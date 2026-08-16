// main.js — DeepSeek Harness 桌面版 v1.1
//
// 设计要点（相比 v1.0 的改动）：
//  1. 不再"杀光 3080 端口上的所有进程"：启动前先申请一个空闲端口，
//     用 `--port` 传给 DSH，端口冲突从根源上不可能发生。
//  2. 不再靠解析日志字符串判断服务就绪：直接轮询 HTTP 端口，可靠且无竞态。
//  3. 退出时用 taskkill /T 杀掉整棵进程树（npx -> node -> DSH），
//     杜绝"DSH 一直留在后台"的孤儿进程问题。
//  4. 增加单实例锁：重复打开应用只会聚焦已有窗口，不会互相干扰。
//  5. 启动时立即显示本地加载页，失败时显示明确错误页，不再有"隐形窗口"。

const { app, BrowserWindow, screen, shell } = require('electron');
const { spawn } = require('child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ---------- 常量 ----------
const DSH_PACKAGE = '@deepseek-ai/dsh';
const STARTUP_TIMEOUT_MS = 90 * 1000; // 等待 DSH 服务就绪的最长时间
const POLL_INTERVAL_MS = 500;         // 就绪探测间隔
const LOAD_RETRIES = 5;               // 页面加载失败的重试次数
const DSH_ORIGINS = ['http://127.0.0.1', 'http://localhost'];

let mainWindow = null;
let dshProcess = null;
let dshPort = null;
let quitting = false;

// ---------- 工具函数 ----------

// 申请一个当前空闲的端口（TcpListener 监听 0 端口由系统分配）
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// 轮询直到 DSH 的 HTTP 服务可访问，或进程退出 / 超时
function waitForServer(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function probe() {
      if (settled) return;
      if (dshProcess && dshProcess.exitCode !== null) {
        return fail(
          new Error(`DSH 进程已退出（代码 ${dshProcess.exitCode}）。请确认已执行：npm i -g ${DSH_PACKAGE}`)
        );
      }
      if (Date.now() > deadline) {
        return fail(new Error(`等待 DSH 服务就绪超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume(); // 丢弃响应体，只要"能连上"就够了
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      // 无论连接被拒、超时还是出错，都稍后重试
      req.on('timeout', () => req.destroy());
      req.on('error', () => setTimeout(probe, POLL_INTERVAL_MS));
    }
    probe();
  });
}

// 终止 DSH 及其全部子进程（双保险 + 等待清理完成）：
//   1) taskkill /T 杀掉主进程整棵树（npx -> node -> dsh）；
//   2) 按端口兜底：若包装进程提前退出导致树断开，
//      直接结束占用本应用端口的进程（只动自己的端口，不影响其它进程）。
function cleanupDsh() {
  return new Promise((resolve) => {
    const safety = setTimeout(resolve, 3000); // 兜底：最多等待 3 秒
    let doneCount = 0;
    const done = () => {
      doneCount++;
      if (doneCount >= 2) {
        clearTimeout(safety);
        resolve();
      }
    };

    // 1) 主进程树（Windows: taskkill /T；其它平台: 进程组 SIGTERM）
    try {
      if (dshProcess && dshProcess.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(dshProcess.pid), '/T', '/F'], { stdio: 'ignore' });
          killer.on('exit', done);
          killer.on('error', done);
        } else {
          try {
            process.kill(-dshProcess.pid, 'SIGTERM');
          } catch {
            try { dshProcess.kill(); } catch { /* 忽略 */ }
          }
          done();
        }
      } else {
        done();
      }
    } catch {
      done();
    }

    // 2) 按端口兜底（仅清理本应用使用的端口）
    try {
      const psCmd = dshPort
        ? `Start-Sleep -Milliseconds 800; Get-NetTCPConnection -LocalPort ${dshPort} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
        : 'exit';
      const fallback = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: 'ignore' });
      fallback.on('exit', done);
      fallback.on('error', done);
    } catch {
      done();
    }
  });
}

// HTML 转义，用于错误页
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildErrorPage(title, detail) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
         background:#0f1117; color:#e6e6e6; display:flex; align-items:center;
         justify-content:center; height:100vh; }
  .box { max-width:560px; padding:40px; }
  h1 { font-size:22px; margin:0 0 16px; }
  p { font-size:14px; line-height:1.7; color:#aab; }
  code { background:#1c1f29; padding:2px 6px; border-radius:4px; font-size:13px; }
</style>
</head>
<body>
  <div class="box">
    <h1>⚠️ ${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
}

function showErrorPage(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = buildErrorPage(title, detail);
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  mainWindow.show();
}

// 判断一个 URL 是否属于 DSH 本地服务（放行导航/弹窗的唯一来源）
function isDshOrigin(url) {
  return DSH_ORIGINS.some((origin) => url.startsWith(origin));
}

// ---------- DSH 服务管理 ----------

async function startDsh() {
  try {
    // 1. 申请空闲端口（不占用 3080，也不与任何现有服务冲突）
    const port = await findFreePort();
    console.log(`[app] 已申请空闲端口: ${port}`);

    // 2. 启动 DSH：--no-install 保证不联网下载，只使用全局已安装的包
    dshPort = port;
    dshProcess = spawn(
      'npx',
      ['--no-install', DSH_PACKAGE, 'web', '--port', String(port)],
      { shell: true, windowsHide: true }
    );
    console.log(`[app] 已启动 DSH (pid=${dshProcess.pid}, 端口=${port})`);

    dshProcess.stdout.on('data', (data) => console.log(`[DSH] ${data}`));
    dshProcess.stderr.on('data', (data) => console.error(`[DSH ERR] ${data}`));
    dshProcess.on('error', (err) => {
      console.error('[app] 无法启动 npx:', err.message);
    });
    dshProcess.on('exit', (code, signal) => {
      console.log(`[app] DSH 进程退出 code=${code} signal=${signal}`);
      dshProcess = null;
      if (!quitting) {
        showErrorPage(
          'DSH 服务意外退出',
          `进程已退出（代码 ${code ?? signal}）。请重新打开应用。`
        );
        app.quit();
      }
    });

    // 3. 等待服务就绪（轮询端口，而不是匹配日志字符串）
    await waitForServer(port, STARTUP_TIMEOUT_MS);
    if (quitting) return;

    console.log(`[app] DSH 已就绪: http://127.0.0.1:${port}`);
    loadDshUrl(port);
  } catch (err) {
    console.error('[app] 启动失败:', err);
    if (!quitting) {
      showErrorPage('DeepSeek Harness 启动失败', err.message);
      app.quit();
    }
  }
}

function loadDshUrl(port, attempt = 1) {
  const url = `http://127.0.0.1:${port}`;
  mainWindow.loadURL(url);

  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDesc) => {
    if (errorCode === -3) return; // ERR_ABORTED：被新导航打断，忽略
    if (attempt < LOAD_RETRIES) {
      console.warn(`[app] 页面加载失败（${errorCode}），${attempt}/${LOAD_RETRIES} 次重试...`);
      setTimeout(() => loadDshUrl(port, attempt + 1), 1000);
    } else {
      showErrorPage(
        '页面加载失败',
        `无法加载 DSH 页面（${errorCode}: ${errorDesc}）。请重新打开应用。`
      );
    }
  });
}

// ---------- 窗口状态（记住用户调整过的大小/位置） ----------

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// 读取上次保存的窗口状态；文件不存在或损坏时返回 null
function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (
      typeof state.width === 'number' &&
      typeof state.height === 'number' &&
      state.width >= 800 &&
      state.height >= 600
    ) {
      return state;
    }
  } catch {
    // 首次运行或文件损坏，忽略
  }
  return null;
}

// 保存窗口状态（防抖：连续调整时只写最后一次）
function createStateSaver(win) {
  let timer = null;
  return function saveNow() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        // getNormalBounds() 在最大化/全屏时也返回还原后的尺寸，保证恢复正确
        const state = {
          ...win.getNormalBounds(),
          maximized: win.isMaximized()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      } catch {
        // 写入失败不影响使用
      }
    }, 500);
  };
}

// 保存的坐标是否仍在某个屏幕的可视区域内（防止拔掉外接显示器后窗口"消失"）
function isBoundsVisible(bounds) {
  return screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return (
      bounds.x < wa.x + wa.width &&
      bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height &&
      bounds.y + bounds.height > wa.y
    );
  });
}

// ---------- 窗口 ----------

function createWindow() {
  const saved = loadWindowState();
  const workArea = screen.getPrimaryDisplay().workArea;

  // 默认尺寸 = 屏幕工作区的 80%，没有保存记录时按当前分辨率自适应
  const defaultWidth = Math.round(workArea.width * 0.8);
  const defaultHeight = Math.round(workArea.height * 0.8);

  mainWindow = new BrowserWindow({
    width: saved ? saved.width : defaultWidth,
    height: saved ? saved.height : defaultHeight,
    // 仅在保存的位置仍可见时恢复坐标，否则交给系统居中
    ...(saved && typeof saved.x === 'number' && typeof saved.y === 'number' && isBoundsVisible(saved)
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    title: 'DeepSeek Harness',
    icon: undefined, // Windows 上使用打包后的 exe 图标
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 上次退出时窗口处于最大化，则本次也最大化
  if (saved && saved.maximized) {
    mainWindow.maximize();
  }

  // 先显示本地加载页，避免"隐形窗口"
  mainWindow.loadFile('index.html').then(() => {
    if (!mainWindow.isDestroyed()) mainWindow.show();
  }).catch((err) => {
    console.error('[app] 加载页加载失败:', err);
    showErrorPage('加载页加载失败', String((err && err.message) || err));
  });

  // 弹窗（window.open）只放行 DSH 本地来源，外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isDshOrigin(url)) return { action: 'allow' };
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 阻止窗口内导航离开 DSH 本地服务
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDshOrigin(url) || url.startsWith('data:') || url.startsWith('about:')) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // 记住窗口大小/位置/最大化状态
  const saveState = createStateSaver(mainWindow);
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('close', saveState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- 应用生命周期 ----------

// 单实例锁：重复启动时只聚焦已有窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    startDsh();
  });

  // 所有平台都在窗口关闭时退出（本应用只面向 Windows）
  app.on('window-all-closed', () => {
    app.quit();
  });

  // 退出流程：先标记 quitting（避免误报错误），
  // 再用 will-quit 暂停退出、等待 DSH 清理完成后再真正退出，
  // 防止"主进程先退出、清理进程被掐断"导致 DSH 残留后台。
  let cleanupStarted = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    event.preventDefault();
    cleanupDsh().then(() => {
      app.quit();
    });
  });
}
