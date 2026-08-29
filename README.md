<div align="center">

# 🐳 DeepSeek Desktop

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进一只鲸鱼蓝小窗口，
像 Codex / Claude Code 桌面版那样陪你写代码的桌面小鲸鱼～**

*(ノ◕ヮ◕)ノ\*:・ﾟ✧  本仓库只装「桌面壳层」，灵魂是 dsh web 引擎啦～*

---

![icon](assets/icon.png)

**Electron  ·  dsh web 本地引擎  ·  深空极光启动页  ·  便携绿色版**

[![Platform](https://img.shields.io/badge/platform-Windows-4D6BFD?style=flat-square&logo=windows)](#-三步起飞)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43853D?style=flat-square&logo=node.js&logoColor=white)](#-三步起飞)
[![License](https://img.shields.io/badge/license-MIT-FFB86C?style=flat-square)](#-许可)
[![Repo](https://img.shields.io/badge/repo-gitee%20%7C%20github-4D6BFD?style=flat-square&logo=github)](#-镜像仓库)

</div>

---

## ✨ 这只鲸鱼能干嘛

| | |
|---|---|
| 🪟 **原生桌面窗口** | 应用菜单、快捷键、鲸鱼图标，告别浏览器地址栏的小情绪～ |
| 🌌 **深空极光启动页** | 极光缓缓流动、鲸鱼玻璃光环漂浮，等引擎的那几秒也不无聊 (｡•̀ᴗ-)✧ |
| ⚡ **本地 dsh 引擎** | 内置 `dsh web`，自动挑空闲端口，聊天 / 工具调用 / 会话全在本地跑 |
| 💾 **聊天永不掉线** | 历史会话实时落 `session/`，重启自动恢复，原生 JSONL，人人都能备份 (｡♥‿♥｡) |
| 📊 **用量看得见** | `Ctrl+Shift+U` 召唤「今天 / 7 天 / 30 天」Token 报告，回到窗口还会自动刷新，永久保存 |
| 🚨 **崩溃不慌张** | 引擎意外断开时页面顶部出现小红横幅，一键「重新启动」就满血复活～ |
| 🧩 **Skill / 插件 / 预设** | 复用 dsh 完整设置界面，还自带一套 8 岗位「企业级开发流水线」预设！ |
| ⬆️ **更新不遭罪** | 检查更新自动多源下载加速，慢网也能喂饱小鲸鱼～ |
| 🚀 **便携绿色版** | `npm run dist` 打个免安装包，整个文件夹拷贝走，走到哪用到哪～ |

---

## 🚀 三步起飞

> 前置：装了 **Node.js ≥ 22**（推荐 24 LTS 啦~）。

```powershell
npm install        # 装依赖（第一次要拉 Electron，慢的话就换国内镜像）
npm start          # 启动桌面版，看见极光里的小鲸鱼就成功啦 🐳
```

冒烟测试（启动 → 加载 → 退出）：

```powershell
npm run smoke
```

### 🇨🇳 Electron 下载慢？切镜像：

```powershell
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install
```

---

## 📦 打包成随身鲸鱼罐头

```powershell
npm run dist
```

产出 `dist/win-unpacked/`，里面有个 `DeepSeek Desktop.exe`，**双击就跑** ✧٩(ˊωˋ*)و✧

> 这个目录是**便携绿色**的：聊天记录、Skill、预设、插件、设置都住在里面，
> 整个文件夹复制到 U 盘/网盘带走，换台电脑依然有完整数据～
>
> 📌 **首次运行**会在应用目录生成 `config.json`，里面要填 `harnessRoot`，
> 指向一份已经 `pnpm run build` 过的 DeepSeek Harness 仓库。
>
> ⚠️ 改了桌面壳的代码后，记得重新 `npm run dist` 才会进到打包版里哦
> （应用内「检查更新」只更新 harness 引擎，不更新桌面壳哒）。

---

## 🍬 配置小甜饼

`config.json`（首次启动自动生成，机器相关，已加入 `.gitignore`）：

```jsonc
{
  "harnessRoot": "D:/path/to/deepseek-harness",  // dsh 引擎目录（含 apps/cli/lib 与 apps/web/dist，需已构建）
  "nodePath": "node",
  "updateMirror": "",                            // 可选：更新下载加速前缀，留空自动，"off" 关闭加速源
  "window": { "width": 1280, "height": 820, "minWidth": 960, "minHeight": 640 }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `harnessRoot` | ✅ | DeepSeek Harness 仓库根目录，需要已经构建过 |
| `nodePath`    | -   | `node` 可执行文件路径，缺省走 PATH |
| `updateMirror` | - | 更新下载加速前缀（如 `https://ghfast.top/` 或含 `{url}` 占位符的模板）；`"off"` 关闭公共加速源；也可用环境变量 `DSH_UPDATE_MIRROR` |
| `window`      | -   | 窗口大小 / 最小尺寸，小鲸鱼会记住你的习惯 |

> 配置支持带 `//` 注释的 JSONC；解析失败时会用默认配置启动但**绝不回写覆盖**你的文件（放心手动改）。

---

## 🗂 小鲸鱼的家

```
deepseek-desktop/
├── main.js                     # Electron 主进程（启动引擎、装窗口、挂菜单）
├── preload.js                  # 给 splash/usage 用的安全桥
├── start.bat                   # Windows 一键启动
├── package.json                # 依赖与 electron-builder 配置
├── cordis.patch.yml            # 全局 Cordis 补丁：会话落 session/、原始 JSONL
├── scripts/
│   ├── engine.js               # 拉起 dsh web 子进程，嗅探就绪 URL（Windows 树杀、防重启竞态）
│   ├── usage.js                # 从 session/ 重建用量快照（今天/7天/30天，mtime 增量解析）
│   ├── updater.js              # 检查更新：多源加速下载 + 超时/限流/跨盘/脏检查
│   ├── sync-presets.js         # 把 _shared/ 共享工具面同步进 sd-* 预设
│   └── dist.js                 # 打包脚本（保数据：先备份用户数据再重建）
├── assets/                     # 鲸鱼图标、启动页、主题 CSS/JS、用量面板
│   ├── icon.png / icon.ico
│   ├── splash.html             # 深空极光启动页 🌌
│   ├── usage.html              # API 用量小窗
│   ├── desktop-theme.css       # 注入到 dsh UI 的鲸鱼蓝主题
│   ├── desktop-settings.css/js # 悬浮「设置」按钮 + 菜单 + 引擎横幅
│   └── SOURCES.md
├── skills/                     # 📁 用户 Skill（自带 example-skill 示例）
├── .agent-presets/             # 📁 Agent 预设（自带 example + sd-* 流水线天团）
│   ├── README.md
│   ├── _shared/                # sd-* 共享工具面（sync-presets.js 的权威来源）
│   ├── example/                # 复制内置预设得到的范例
│   └── sd-*/                   # 🚦总控 → 📋PM → 🗺UX → 🎨UI → 🏗架构 → 💻开发 → 🔍审查 → 🧪QA
└── (运行时生成，已 gitignore)：
    ├── session/                # 💬 聊天记录 (JSONL)
    ├── usage/                  # 📊 用量快照
    ├── profiles/web/           # 🔌 插件与 profile
    ├── userdata/               # 🗃 Electron userData
    ├── storages/               # 🗃 工作区状态
    ├── logs/                   # 📝 desktop.log / engine.log
    ├── settings.yaml           # ⚙️ 模型 / 通用 / 插件
    └── .credentials.yaml       # 🔑 API key（只写，前端只见脱敏描述）
```

---

## 🛠 设置入口在哪

- **原生融入系统设置** ✨：打开侧边栏「⚙️ 设置」，左侧导航多了一个「**桌面**」分组——
  API 用量、检查更新（内嵌进度条）、会话/Skills/预设/插件/日志目录直达、退出，全在这里，
  和「通用设置 / 模型 / 插件 / Agent 预设」完全同级同款
- 侧边栏底部齿轮旁还有一颗「**桌面**」按钮，一键跳到该分组（原生样式，不悬浮、不遮挡）
- 菜单「**设置 → API 用量**」或 `Ctrl+Shift+U` → 用量面板（手动刷新 / 回窗自动刷新 / 暗色模式都有哦）
- 菜单「**设置 → 检查更新**」与菜单/按钮同源，自动打开设置里的「桌面」分组并开始检查
- 菜单「**文件**」下可一键打开：会话目录、Skills 目录、日志目录
- 引擎意外退出时页面顶部会出现红色横幅，点「重新启动」一键复活 ✧
- 帮助菜单 → 关于 / DeepSeek Harness 文档

> 小知识：原生分组由一个官方格式的 dsh 客户端插件（`dsh-plugin/`）实现，启动时自动安装
> 进 `profiles/web/`（免疫 harness 更新覆盖）。如果插件没装上（比如机器上没有 pnpm），
> 会自动回退到右下角的悬浮设置按钮，功能一个不少～

---

## ⬆️ 喂鲸鱼吃更新

悬浮设置按钮 / 应用菜单「设置 → 检查更新」：

- 优先按已装源码 SHA 对比 GitHub 上游（deepseek-ai/deepseek-harness），版本号兜底；
  发现新版本会展示版本差异与最新提交信息
- 确认后一键更新：下载源码 tarball（**直连太慢自动切加速源**，实时显示百分比和速度）
  → 备份旧版 → 覆盖 `harnessRoot` → `pnpm install` + `pnpm run build` → 自动重启引擎
- 同一版本重复尝试会复用已下载的源码包缓存，不用重新下载～
- 更新失败自动恢复旧版本，绝不留半成品；启动时还能自愈上次被中断的更新
- 网络请求全部带超时，GitHub 限流（403）会给可读提示；
  本地 harness 有未提交改动时会提前警告
- 需要 `pnpm` 可用（构建依赖）；CLI 手动触发：`node scripts/updater.js`
  （`--dry-run` 仅下载解压验证；本地有改动时完整更新需 `--force` 确认）

---

## 🎒 领养新技能

| 玩法 | 怎么加 | 调用方式 |
| --- | --- | --- |
| **Skill** | `skills/<名称>/SKILL.md`（frontmatter 至少 `name`+`description`） | 对话框输入 `/名称` ✨ |
| **Agent 预设** | 应用内「设置 → Agent 预设」点「复制」→ 编辑生成的文件 | 在「设置 → Agent 预设」切换 |
| **流水线预设** | 自带 8 个 `sd-*` 预设：总控门禁 → PM → UX → UI → 架构 → 开发 → 审查 → QA，按站流转文档 | 切换预设即换岗位～ |
| **插件** | `node ../<harness>/apps/cli/lib/bin.js plugin --profile web add <包名>` | 落在 `profiles/web/` |

详细格式：见 [`skills/README.md`](skills/README.md) 与 [`.agent-presets/README.md`](.agent-presets/README.md)。

---

## ⌨️ 快捷键小抄

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Shift+U` | 🧮 API 用量 |
| `Ctrl+R` | 🔄 重新加载 |
| `Ctrl+Shift+I` | 🐞 开发者工具 |
| `F11` | ⛶ 全屏 |
| `Ctrl+Q` | 🚪 退出（顺便帮你关引擎） |

---

## 🩹 翻车急救

- **「未找到完整构建产物」** → 检查 `config.json` 里的 `harnessRoot`，该目录里要有 `apps/cli/lib/bin.js` 和 `apps/web/dist/index.html`（说明 dsh 仓库跑过 `pnpm run build`）
- **Electron 下载失败** → 切国内镜像（见上）重装
- **打包后聊天记录没了** → 不会的，`scripts/dist.js` 会先把 `session/` / `usage/` / `userdata/` 等搬到 `dist/.userdata-backup`，打完再搬回去
- **改了代码没生效** → 如果你启动的是 `dist/win-unpacked` 里的 exe，那是打包版的旧代码，重新 `npm run dist` 一下就好啦
- **想清空用量统计** → 删 `usage/` 文件夹即可，下次打开用量面板会从 `session/` 自动重建
- **引擎中途断线** → 页面顶部的红色横幅点「重新启动」就好，不用慌 (๑•̀ㅂ•́)و✧

---

## 🪞 镜像仓库

| 平台 | 地址 |
| --- | --- |
| 🐙 GitHub | <https://github.com/Cyrus-2002/deepseek-desktop> |
| 🟥 Gitee  | <https://gitee.com/cyrus2002/deepseek-desktop> |

两边同步更新～ 想提 Issue / PR 选顺手的那边就好 (◍•ᴗ•◍)

---

## 📜 许可

**MIT** — 前端与引擎版权归 DeepSeek Harness 项目所有；本目录仅含桌面壳层代码与用量面板。

<div align="center">

<sub>用 🐳 和 ☕ 制作 · 愿你的小鲸鱼陪你写出更多好代码 ˊ˗</sub>

</div>
