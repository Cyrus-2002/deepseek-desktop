---
name: example-skill
description: 演示自定义 Skill 的示例：说明如何给 DeepSeek Desktop 添加可复用的工作流程
whenToUse: 当你想了解如何添加/编写自定义技能时使用
---

# 示例 Skill（Example Skill）

这是一个**用户级自定义 Skill**，放在 DeepSeek Desktop 的 `skills/` 目录下即可被识别与调用。

## 何时使用

当你需要了解如何给 DeepSeek Desktop 添加一个自定义技能、或想快速复制这个模板时。

## 如何添加一个 Skill

1. 在 `skills/` 下新建一个目录（目录名即 skill 名），放入一个 `SKILL.md`。
2. 在文件开头写 YAML frontmatter，至少包含 `name` 和 `description`（可选 `whenToUse`）。
3. 正文写这个技能要做什么、何时用、具体步骤。
4. 重新打开应用后，在对话输入框输入 `/example-skill` 即可调用。

## 示例

```
skills/
└── example-skill/
    └── SKILL.md
```

本示例本身不执行任何操作，仅用于演示目录与格式约定。
