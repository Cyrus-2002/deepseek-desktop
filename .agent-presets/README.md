# .agent-presets — 用户 Agent 预设目录

自定义的 Agent 模式（预设）放在本目录，DeepSeek Desktop 会在「设置 → Agent 预设」里自动列出。

## 结构

每个预设是一个目录（目录名即 preset id，需匹配 `^[a-z0-9][a-z0-9-]*$`），内含：

```
.agent-presets/
└── <preset-id>/
    ├── agent.cordis.yml    # 组合文件：Cordis entry 列表（定义该模式的工具与提示词）
    └── preset.yml          # 可选元数据：name / description / order
```

## 创建方式

1. 应用内「设置 → Agent 预设」→ 对内置预设点「复制」，即在本目录生成副本；
2. 用「打开位置」在本目录编辑 `agent.cordis.yml` 与 `preset.yml`。

示例见 [`example/preset.yml`](example/preset.yml)。
