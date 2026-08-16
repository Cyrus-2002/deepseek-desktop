# skills — 用户 Skill 目录

把自定义技能放到本目录，DeepSeek Desktop 会自动扫描并可在对话中通过 `/名称` 调用。

## 结构

每个 Skill 是一个目录，内含一个 `SKILL.md`（frontmatter 至少要有 `name`、`description`）：

```
skills/
└── <skill-name>/
    └── SKILL.md
```

也支持直接在 `skills/` 下放扁平的 `*.md` 文件。

## frontmatter 字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `name` | ✅ | kebab-case 标识，对话中 `/名称` 引用 |
| `description` | ✅ | 一句话路由描述 |
| `whenToUse` | 可选 | 更细的触发时机说明 |

示例见 [`example-skill/SKILL.md`](example-skill/SKILL.md)。
