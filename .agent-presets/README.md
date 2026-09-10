# .agent-presets — 用户 Agent 预设目录

自定义的 Agent 模式（预设）放在本目录，DeepSeek Desktop 会在「设置 → Agent 预设」里自动列出。

## 结构

每个预设是一个目录（目录名即 preset id，需匹配 `^[a-z0-9][a-z0-9-]*$`），内含：

```
.agent-presets/
├── _shared/
│   └── common.rows.yml     # sd-* 预设共享的工具面（权威副本，勿在预设里手改）
├── product-designer/       # 💬 独立预设：对话式产品雏形工作坊（不参与 sd-* 同步）
├── sd-orchestrator/        # 流水线第 0 站：项目总控与门禁
├── sd-pm/                  # 第 1 站：产品经理 → docs/PRD.md
├── sd-ux/                  # 第 2 站：交互设计 → docs/交互设计.md + wireframes/
├── sd-ui/                  # 第 3 站：视觉设计 → docs/视觉设计.md + design/
├── sd-architect/           # 第 4 站：技术架构 → ARCHITECTURE.md + SPRINT-PLAN.md
├── sd-dev/                 # 第 5 站：全栈开发 → 代码 + 测试 + DEV-LOG.md
├── sd-reviewer/            # 第 6 站：代码审查 → REVIEW-REPORT.md
├── sd-qa/                  # 第 7 站：验收测试 → QA-REPORT.md（Go/No-Go）
└── <preset-id>/
    ├── agent.cordis.yml    # 组合文件：Cordis entry 列表（定义该模式的工具与提示词）
    └── preset.yml          # 可选元数据：name / description / order
```

## sd-* 流水线预设的共享工具面

dsh 的 agent 预设要求**单文件自包含**（不支持 include），因此 8 个 sd-* 预设的
工具面（agent-instructions、shell/fs、skills、goal、plan-mode、compaction、
delegation、todo、web 等 rows）以「内联展开」的形式写入每个 `agent.cordis.yml`。

这些共享 rows 的权威副本在 [`_shared/common.rows.yml`](\_shared/common.rows.yml)，
逐字对齐 harness 内置 `standard` 预设。每个预设文件中有一条标记行：

```
# ══════════════ 共享工具面（此行到文件末尾由 scripts/sync-presets.js 生成，勿手工编辑）══════════════
```

- **标记行以下勿手工编辑**（会被同步覆盖）；标记行以上是各预设的 persona 提示词，自由定制。
- 上游 harness 的 standard 预设更新后：把新的工具面 rows 更新到 `_shared/common.rows.yml`，
  然后运行 `node scripts/sync-presets.js`，全部预设一次性同步。
- `node scripts/sync-presets.js --check` 可检查是否有预设过期（退出码 1）。

### persona 写作约定

- 开头一句使用且仅使用 harness 注册的插值变量：`{{model}}` 与 `{{cwd}}`
  （未注册的 `{{...}}` 会在渲染时直接抛错）。
- 统一骨架：一、角色与使命 → 二、流水线坐标 → 三、原则与红线 → 四、工作流程 →
  五、产出模板 → 六、质量自检 → 七、交互规范。

## 创建方式

1. 应用内「设置 → Agent 预设」→ 对内置预设点「复制」，即在本目录生成副本；
2. 用「打开位置」在本目录编辑 `agent.cordis.yml` 与 `preset.yml`。

内置预设的镜像副本见 [`example/`](example/agent.cordis.yml)——它是 harness
`standard` 预设的逐字拷贝，仅作参考，不参与同步。
