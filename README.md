# DeepSeek Harness 桌面版

> 一个将 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）Web 界面封装为 Windows 原生桌面应用的 Electron 外壳，启动后像使用普通桌面软件一样使用 DSH，无需再手动打开终端。
> A lightweight Electron desktop wrapper for the DeepSeek Harness web UI.

![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/Electron-28.3.3-47848F)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

## 功能特性

- **一键启动**：应用启动时自动拉起 DSH 本地服务并加载界面，关闭窗口即完整退出（服务进程一并清理，不会残留后台）。
- **窗口大小可调**：默认尺寸按屏幕自适应（约 80% 工作区），可自由拖拽调整或最大化，并自动记住上次的窗口大小、位置与最大化状态，下次启动自动恢复。
- **零端口冲突**：每次启动自动申请一个空闲端口，不固定占用特定端口，也不会影响其他程序。
- **本地化**：使用 `npx --no-install` 只调用全局已安装的 DSH 包，启动过程不会修改 DSH 版本。
- **单实例**：重复打开应用只会聚焦已有窗口，不会启动第二个服务。
- **安全的渲染配置**：`contextIsolation` + `sandbox` 开启、`nodeIntegration` 关闭；窗口内禁止跳转到外部网站，外部链接交给系统浏览器。

## 环境要求

- Windows 10/11
- [Node.js](https://nodejs.org/)（含 npx）
- 全局安装 DSH：`npm i -g @deepseek-ai/dsh`

> 应用本体不打包 DSH，运行时依赖全局安装的 `@deepseek-ai/dsh`。如果启动后提示 DSH 进程退出，请先确认已执行上面的全局安装命令。

## 快速开始

```bash
# 1. 克隆或下载本项目后，安装依赖（首次）
npm install

# 2. 开发模式运行（带控制台日志，便于调试）
npm start

# 3. 打包构建（可选）
npm run pack   # 仅打包免安装目录，快速验证
npm run build  # 构建 Windows 安装包（NSIS）
```

安装包输出到 `dist/` 目录（如 `dist/DeepSeek Harness Setup 1.1.0.exe`）。

## 工作原理

```
┌──────────────────────────────┐
│         Electron 窗口         │
│  ┌──────────┐   ┌─────────┐  │
│  │ 加载页    │ → │ DSH Web │  │
│  │ index.html│   │ 界面    │  │
│  └──────────┘   └─────────┘  │
└──────────────┬───────────────┘
               │ 加载 http://127.0.0.1:<随机空闲端口>
               ▼
        ┌──────────────┐
        │ dsh web 服务  │  ← 由 npx 启动，--port 指定端口
        └──────────────┘
```

1. 应用启动后先申请一个空闲端口，再用 `npx --no-install @deepseek-ai/dsh web --port <端口>` 启动 DSH。
2. 窗口立即显示本地加载页，同时轮询该端口直到服务就绪，再切换到 DSH 界面（不依赖日志文本匹配，也不会出现"卡住"的隐形窗口）。
3. 关闭窗口时通过 `taskkill /T /F` 终止整棵进程树，确保 DSH 不会残留在后台。

## 常见问题

**启动后提示"DSH 进程已退出"**
检查是否已全局安装 DSH：`npm i -g @deepseek-ai/dsh`，然后重新打开应用。

**从 GitHub 克隆后无法运行？**
`node_modules` 不会上传到仓库，克隆后先执行 `npm install` 再运行。

**窗口大小/位置存在哪里？**
保存在 `%APPDATA%\deepseek-harness\window-state.json`。想恢复默认尺寸，关闭应用后删除该文件即可。

**如何查看 DSH 的日志？**
开发模式下运行 `npm start`，终端会实时打印 DSH 的 stdout/stderr。

## 目录结构

```
├── main.js          # Electron 主进程：窗口、DSH 服务生命周期管理
├── index.html       # 本地加载页（服务就绪前显示，使用 icon-256.png 作为图标）
├── icon-256.png     # 从 icon.ico 提取的 256×256 图标，用于加载页
├── icon.ico         # 应用图标（安装包/任务栏用）
├── package.json     # 依赖与 electron-builder 构建配置
└── dist/            # 构建产物（已 gitignore）
```

## 技术栈

- [Electron](https://www.electronjs.org/) 28 + [electron-builder](https://www.electron.build/) 24
- 主进程仅使用 Node.js 内置模块（`child_process` / `net` / `http`），无第三方运行时依赖

## 相关项目

- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) —— 本应用所封装的核心工具

## License

本项目基于 [MIT](LICENSE) 协议开源。
