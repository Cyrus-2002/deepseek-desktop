# scripts/

桌面端的小工具脚本们，按需查阅～

| 脚本 | 角色 | 何时会被调用 |
| --- | --- | --- |
| [`engine.js`](./engine.js) | 启动 `dsh web` 子进程，嗅探「就绪 URL」，把状态写入 `logs/engine.json` | Electron 主进程 `require`（日常运行）；也支持 `node scripts/engine.js` 单跑（CLI / 调试用） |
| [`usage.js`](./usage.js) | 从 `session/*.jsonl` 重建「今天 / 7 天 / 30 天」用量快照 | 打开「API 用量」窗口时（前端 IPC 触发） |
| [`dist.js`](./dist.js) | 包装 `electron-builder`，保数据 + 注入鲸鱼图标 | `npm run dist` |

## engine.js

- **子进程方式启动 dsh web**（`DSH_HOME=<app 根目录>`，所有数据落本目录）
- 不捕获 stdout/stderr 到管道，而是直接重定向到 `logs/engine.log` 文件描述符
  （避免 dsh 内部管道的 backpressure 影响启动）
- 150ms 轮询日志尾部，匹配 `dsh web: http://127.0.0.1:<port>` 即认为就绪
- 父进程退出（`ppid` 消失）时自动停引擎（CLI 模式下生效）

## usage.js

- **snapshots 架构**：每次打开用量面板都从 `session/` 全量重建
  `usage/snapshots/{today,last7days,last30days}.jsonl`，不依赖任何运行时聚合状态
- 用量**永久记录**，应用内不提供「清空用量」入口；用户可手动删 `usage/` 文件夹
- 原始 `session/*.jsonl` **只读**，永远不改

## dist.js

- electron-builder 重建 `dist/` 会清空 `dist/win-unpacked`，而便携版的用户数据（`session/`、`usage/`、设置、key…）正住在那儿
- 打包前把这些数据搬到 `dist/.userdata-backup`，打包完成再搬回去 —— **重新打包不再丢数据**
- 顺手用 `resedit` 把 `assets/icon.ico` 写进 `DeepSeek Desktop.exe` 资源段
  （electron-builder 的 rcedit 在本机偶发崩溃，配置已 `signAndEditExecutable: false` 跳过，由这里补上）
