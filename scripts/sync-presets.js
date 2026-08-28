#!/usr/bin/env node
/**
 * sync-presets.js — 把 .agent-presets/_shared/common.rows.yml（共享工具面）
 * 内联回写每个 sd-* 预设的 agent.cordis.yml。
 *
 * 背景：dsh 的 agent 预设要求单文件自包含（不支持 include），因此共享的
 * 工具行（agent-instructions、tool-* 系列、plan-mode、compaction、delegation）
 * 以「内联展开」的方式落到每个预设文件；本脚本用标记行定位共享区域并整体
 * 替换，保证 9 份副本永远一致。
 *
 * 用法：
 *   node scripts/sync-presets.js           # 同步全部 sd-* 预设
 *   node scripts/sync-presets.js --check   # 只检查是否有过期副本（退出码 1）
 *
 * 每个预设文件的结构约定：
 *   [头部注释 + persona 配置块]           ← 手工维护（各预设不同）
 *   [共享标记行]                          ← 本脚本定位用
 *   [共享工具面 rows]                     ← 本脚本从 _shared/ 生成
 */

const fs = require('fs')
const path = require('path')

const APP_ROOT = path.resolve(__dirname, '..')
const PRESETS_DIR = path.join(APP_ROOT, '.agent-presets')
const SHARED_FILE = path.join(PRESETS_DIR, '_shared', 'common.rows.yml')
const MARKER = '# ══════════════ 共享工具面（此行到文件末尾由 scripts/sync-presets.js 生成，勿手工编辑）══════════════'

function main() {
  const checkOnly = process.argv.includes('--check')
  const shared = fs.readFileSync(SHARED_FILE, 'utf8').replace(/\r\n/g, '\n').trimEnd()
  const block = `${MARKER}\n\n${shared}\n`

  const dirs = fs.readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^sd-[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name)
    .sort()

  if (dirs.length === 0) {
    console.error('未找到任何 sd-* 预设目录')
    process.exit(1)
  }

  let changed = 0
  for (const name of dirs) {
    const file = path.join(PRESETS_DIR, name, 'agent.cordis.yml')
    if (!fs.existsSync(file)) {
      console.warn(`跳过 ${name}：缺少 agent.cordis.yml`)
      continue
    }
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

    // 截断点：优先用标记行；老文件（无标记）退回到第一个顶层 agent-instructions 行；
    // 两者都没有（仅含 persona 的新文件）则整体作为头部，共享块追加到末尾
    let head
    const markerIdx = src.indexOf(MARKER)
    if (markerIdx !== -1) {
      head = src.slice(0, markerIdx)
    } else {
      const m = src.match(/^- id: agent-instructions$/m)
      head = m ? src.slice(0, m.index) : src
    }

    const next = head.replace(/\n+$/, '\n') + '\n' + block
    if (next === src) {
      console.log(`已是最新：${name}`)
      continue
    }
    if (checkOnly) {
      console.log(`需要同步：${name}`)
      changed++
      continue
    }
    fs.writeFileSync(file, next, 'utf8')
    console.log(`已同步：${name}`)
    changed++
  }

  if (checkOnly && changed > 0) {
    console.error(`\n${changed} 个预设的共享工具面过期，请运行 node scripts/sync-presets.js`)
    process.exit(1)
  }
  console.log(`\n完成：${changed} 个文件${checkOnly ? '过期' : '更新'}，共 ${dirs.length} 个预设`)
}

main()
