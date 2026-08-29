# scripts/

桌面端的小工具脚本们，按需查阅～

| 脚本 | 角色 | 何时会被调用 |
| --- | --- | --- |
| [`engine.js`](./engine.js) | 启动 `dsh web` 子进程，嗅探「就绪 URL」，把状态写入 `logs/engine.json` | Electron 主进程 `require`（日常运行）；也支持 `node scripts/engine.js` 单跑（CLI / 调试用） |
| [`usage.js`](./usage.js) | 从 `session/*.jsonl` 重建「今天 / 7 天 / 30 天」用量快照 | 打开「API 用量」窗口时（前端 IPC 触发） |
| [`updater.js`](./updater.js) | 检查并应用 DeepSeek Harness 上游更新 | 悬浮菜单「检查更新」；也可 `node scripts/updater.js`（`--dry-run` 仅验证下载解压；本地有未提交改动时完整更新需 `--force` 确认） |
| [`sync-presets.js`](./sync-presets.js) | 把 `.agent-presets/_shared/common.rows.yml` 共享工具面内联进每个 `sd-*` 预设 | 手动运行：`node scripts/sync-presets.js`（同步）/ `--check`（检查过期副本，有则退出码 1） |
| [`dist.js`](./dist.js) | 包装 `electron-builder`，保数据 + 注入鲸鱼图标 | `npm run dist` |

## engine.js

- **子进程方式启动 dsh web**（`DSH_HOME=<app 根目录>`，所有数据落本目录）
- 不捕获 stdout/stderr 到管道，而是直接重定向到 `logs/engine.log` 文件描述符
  （避免 dsh 内部管道的 backpressure 影响启动）
- 100ms 轮询日志尾部，匹配 `dsh web: http://127.0.0.1:<port>` 即认为就绪
- 进程事件回调按「实例」守卫：重启后旧进程的迟到退出不会误清新进程的句柄
- 停止时等待进程真正退出；Windows 用 `taskkill /T /F` 树杀，防止 dsh 派生的子进程变孤儿
- 父进程退出（`ppid` 消失）时自动停引擎（CLI 模式下生效）

## usage.js

- **snapshots 架构**：每次打开用量面板都从 `session/` 重建
  `usage/snapshots/{today,last7days,last30days}.jsonl`，不依赖任何运行时聚合状态
- 会话文件按 `(mtime, size)` 做解析缓存，未变化的文件不重复解析；
  超出 30 天窗口的历史事件不进入缓存与快照
- 快照为「先清空、追加写入」：事件再多也只追加落盘，不会因缓冲分批而互相覆盖
- 用量**永久记录**，应用内不提供「清空用量」入口；用户可手动删 `usage/` 文件夹
- 原始 `session/*.jsonl` **只读**，永远不改

## updater.js

- **检查**：GitHub API 读 `master` HEAD 的 SHA 与版本，优先与本地已装 SHA
  （`logs/update-state.json` 或源码快照提交信息 `source snapshot <sha>`）比对，版本号兜底；
  同时跑 `git status --porcelain` 检测本地 harness 未提交改动（dirty），结果透出给 UI 提前警告
- **下载**：按 commit SHA 拉 codeload tarball（可复现），候选源依次尝试——
  GitHub 直连 → 公共加速前缀（可被 `config.json` 的 `updateMirror` 或环境变量
  `DSH_UPDATE_MIRROR` 覆盖/前置，`"off"` 关闭加速源）；单源停滞 12s 或平均速度
  < 96KB/s 即自动切换下一个，进度实时显示百分比与速率
- **缓存**：源码包按 SHA 命名缓存（`logs/.update-tmp/source-<sha>.tar.gz` + `.ok` 标记），
  构建失败重试不再重复下载
- **更新**：`tar` 库解压（跨盘 rename 自动回退复制）-> 旧版改名备份 -> 替换 ->
  git 空提交登记快照（构建脚本需要 `git rev-parse HEAD`）-> `pnpm install` + `pnpm run build`
- **安全**：构建失败自动回滚备份；主进程更新期间拦截退出（关窗则更新完成后自动退出）；
  启动时自愈被中断的更新（`main.js` 的 `recoverInterruptedUpdate`）
- 本机 `github.com:443` 不通但 `api/codeload.github.com` 可达，所以走 tarball 而不是 git clone

## dist.js

- electron-builder 重建 `dist/` 会清空 `dist/win-unpacked`，而便携版的用户数据（`session/`、`usage/`、设置、key…）正住在那儿
- 打包前把这些数据搬到 `dist/.userdata-backup`，打包完成再搬回去 —— **重新打包不再丢数据**
- Electron 下载缓存默认落项目内 `.electron-cache/`，可用环境变量 `ELECTRON_CACHE` 改到别处
- 顺手用 `resedit` 把 `assets/icon.ico` 写进 `DeepSeek Desktop.exe` 资源段
  （electron-builder 的 rcedit 在本机偶发崩溃，配置已 `signAndEditExecutable: false` 跳过，由这里补上）
