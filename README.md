<div align="center">

# 🐳 DeepSeek Desktop

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进一个**鲸鱼蓝小窗口**，像 Codex / Claude Code 桌面版那样用。**

*(ノ◕ヮ◕)ノ\*:・ﾟ✧  本仓库只装「桌面壳层」，灵魂是 dsh web 引擎啦～*

---

![icon](assets/icon.png)

**Electron  ·  dsh web 本地引擎  ·  鲸鱼蓝主题  ·  便携绿色版**

[![Platform](https://img.shields.io/badge/platform-Windows-4D6BFD?style=flat-square&logo=windows)](#-快速开始)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43853D?style=flat-square&logo=node.js&logoColor=white)](#-快速开始)
[![License](https://img.shields.io/badge/license-MIT-FFB86C?style=flat-square)](#-许可)
[![Repo](https://img.shields.io/badge/repo-gitee%20%7C%20github-4D6BFD?style=flat-square&logo=github)](#-镜像仓库)

</div>

---

## ✨ 这只鲸鱼能干嘛

| | |
|---|---|
| 🪟 **原生桌面窗口** | 应用菜单、快捷键、明暗主题、鲸鱼图标，告别浏览器地址栏的小情绪～ |
| ⚡ **本地 dsh 引擎** | 内置 `dsh web`，自动挑空闲端口，聊天 / 工具调用 / 会话 全在本地跑 |
| 💾 **聊天永不掉线** | 历史会话实时落 `session/`，重启自动恢复，原生 JSONL，人人都能备份 (｡♥‿♥｡) |
| 📊 **用量看得见** | `Ctrl+Shift+U` 一键召唤「今天 / 过去 7 天 / 过去 30 天」Token 报告，永久保存 |
| 🧩 **Skill / 插件 / 预设** | 复用 dsh 完整设置界面，资源目录全落在本目录，随手管理 |
| 🚀 **便携绿色版** | `npm run dist` 打个免安装包，整个文件夹拷贝走，走到哪用到哪～ |

---

## 🚀 快速开始

> 前置：装了 **Node.js ≥ 22**（推荐 24 LTS 啦~）。

```powershell
npm install        # 装依赖（第一次要拉 Electron，慢的话就换国内镜像）
npm start          # 启动桌面版，看见鲸鱼就成功啦 🐳
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

## 📦 打包免安装版

```powershell
npm run dist
```

产出 `dist/win-unpacked/`，里面有个 `DeepSeek Desktop.exe`，**双击就跑** ✧٩(ˊωˋ*)و✧

> 这个目录是**便携绿色**的：聊天记录、Skill、预设、插件、设置都住在里面，
> 整个文件夹复制到 U 盘/网盘带走，换台电脑依然有完整数据。
>
> 📌 **首次运行**会在应用目录生成 `config.json`，里面要填 `harnessRoot`，
> 指向一份已经 `pnpm run build` 过的 DeepSeek Harness 仓库。

---

## ⚙️ 配置

`config.json`（首次启动自动生成，机器相关，已加入 `.gitignore`）：

```jsonc
{
  "harnessRoot": "D:/ai_agent/deepseek-harness/deepseek-harness-master",  // dsh 引擎（含 apps/cli/lib 与 apps/web/dist）
  "nodePath": "node",
  "window": { "width": 1280, "height": 820, "minWidth": 960, "minHeight": 640 }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `harnessRoot` | ✅ | DeepSeek Harness 仓库根目录，需要已经构建过 |
| `nodePath`    | -   | `node` 可执行文件路径，缺省走 PATH |
| `window`      | -   | 窗口大小 / 最小尺寸，桌面版会记住你的习惯 |

---

## 🗂 目录结构

```
deepseek-desktop/
├── main.js                     # Electron 主进程（启动引擎、装窗口、挂菜单）
├── preload.js                  # 给 splash/usage 用的安全桥
├── start.bat                   # Windows 一键启动
├── package.json                # 依赖与 electron-builder 配置
├── cordis.patch.yml            # 全局 Cordis 补丁：会话落 session/、原始 JSONL
├── scripts/
│   ├── engine.js               # 拉起 dsh web 子进程，嗅探就绪 URL
│   ├── usage.js                # 从 session/ 重建用量快照（今天/7天/30天）
│   └── dist.js                 # 打包脚本（保数据：先备份用户数据再重建）
├── assets/                     # 鲸鱼图标、启动页、主题 CSS/JS、用量面板
│   ├── icon.png / icon.ico
│   ├── splash.html             # 启动鲸鱼页
│   ├── usage.html              # API 用量小窗
│   ├── desktop-theme.css       # 注入到 dsh UI 的鲸鱼蓝主题
│   ├── desktop-settings.css/js # 浮窗「设置」按钮 + 菜单
│   └── SOURCES.md
├── skills/                     # 📁 用户 Skill（自带 example-skill 示例）
│   ├── README.md
│   └── example-skill/SKILL.md
├── .agent-presets/             # 📁 Agent 预设（自带 example + sd-* 团队预设）
│   ├── README.md
│   ├── example/                # 复制内置预设得到的范例
│   ├── sd-architect/
│   ├── sd-dev/
│   ├── sd-orchestrator/
│   ├── sd-pm/
│   ├── sd-qa/
│   ├── sd-reviewer/
│   ├── sd-ui/
│   └── sd-ux/
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

## 🛠 设置入口

- 侧边栏底部「⚙️ 设置」按钮 → 打开 dsh 设置面板（模型 / 通用 / 插件 / Agent 预设）
- 菜单「**设置 → API 用量**」或 `Ctrl+Shift+U` → 用量面板（今天 / 7 天 / 30 天）
- 菜单「**设置**」下可一键打开：会话目录、Skills 目录、Agent 预设目录、插件目录
- 帮助菜单 → 关于 / DeepSeek Harness 文档

---

## ➕ 添加工 Skill / 插件 / Agent 预设

| 玩法 | 怎么加 | 调用方式 |
| --- | --- | --- |
| **Skill** | `skills/<名称>/SKILL.md`（frontmatter 至少 `name`+`description`） | 对话框输入 `/名称` ✨ |
| **Agent 预设** | 应用内「设置 → Agent 预设」点「复制」→ 编辑生成的文件 | 在「设置 → Agent 预设」切换 |
| **插件** | `node ../<harness>/apps/cli/lib/bin.js plugin --profile web add <包名>` | 落在 `profiles/web/` |

详细格式：见 [`skills/README.md`](skills/README.md) 与 [`.agent-presets/README.md`](.agent-presets/README.md)。

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Shift+U` | 🧮 API 用量 |
| `Ctrl+R` | 🔄 重新加载 |
| `Ctrl+Shift+I` | 🐞 开发者工具 |
| `F11` | ⛶ 全屏 |
| `Ctrl+Q` | 🚪 退出（顺便帮你关引擎） |

---

## 🐛 故障排查

- **「未找到完整构建产物」** → 检查 `config.json` 里的 `harnessRoot`，该目录里要有 `apps/cli/lib/bin.js` 和 `apps/web/dist/index.html`（说明 dsh 仓库跑过 `pnpm run build`）
- **Electron 下载失败** → 切国内镜像（见上）重装
- **打包后聊天记录没了** → 不会的，`scripts/dist.js` 会先把 `session/` / `usage/` / `userdata/` 等搬到 `dist/.userdata-backup`，打完再搬回去
- **想清空用量统计** → 删 `usage/` 文件夹即可，下次打开用量面板会从 `session/` 自动重建

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

<sub>用 🐳  和 ☕  制作 · 愿你的小鲸鱼陪你写出更多好代码</sub>

</div>
