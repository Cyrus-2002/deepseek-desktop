/**
 * DeepSeek Desktop - API 用量聚合模块（snapshots 架构，永久记录）。
 *
 * 数据流：
 *   1) 每次用量面板打开时，`recordSnapshots(usageRoot, sessionRoot)` 从
 *      `session/<projectKey>/<sessionId>/session.jsonl` 扫描每个 `assistant/message`
 *      事件，按 3 个时间窗（今天 / 过去 7 天 / 过去 30 天）写入
 *      `usage/snapshots/<window>.jsonl`。
 *   2) `computeUsageFromSnapshots(usageRoot)` 折叠 snapshots 内的 usage，
 *      产出 buckets、total。
 *
 * 用量记录不可从应用内删除（无清除功能）；用户可自行手动清空 usage/ 文件夹，
 * 下次打开面板时会从 session/ 聊天日志自动重建完整记录。
 * 原始会话日志（session/）只读，永不修改。
 */

'use strict'

const { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } = require('node:fs')
const path = require('node:path')

const WINDOWS = [
  { id: 'today',      spanDays: 1,  granularity: 'hour' },
  { id: 'last7days',  spanDays: 7,  granularity: 'day'  },
  { id: 'last30days', spanDays: 30, granularity: 'day'  },
]

/* ========== 时间工具 ========== */

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function startOfHour(ts) {
  const d = new Date(ts)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}
function fmtDay(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtHour(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

/* ========== 数据结构 ========== */

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }
}
function addUsage(target, usage) {
  target.inputTokens += usage.inputTokens || 0
  target.outputTokens += usage.outputTokens || 0
  target.cacheReadTokens += usage.cacheReadTokens || 0
  target.cacheWriteTokens += usage.cacheWriteTokens || 0
  target.requests += 1
}

/* ========== 文件系统扫描 ========== */

function listSessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && (entry.name === 'session.jsonl' || entry.name.endsWith('.jsonl'))) {
        try { if (statSync(full).size > 0) out.push(full) } catch { /* 忽略 */ }
      }
    }
  }
  walk(root, 0)
  return out
}

/* ========== Snapshots 写入 ========== */

/**
 * 扫描 sessionRoot，按 3 个时间窗把每个 assistant/message 事件写入
 * usageRoot/snapshots/<window>.jsonl（每次先清空旧文件再重建，保证与
 * session/ 全量一致）。
 * @returns { rebuilt: boolean, counts: { [window]: number } }
 */
function recordSnapshots(usageRoot, sessionRoot) {
  if (!usageRoot || !sessionRoot || !existsSync(sessionRoot)) {
    return { rebuilt: false, counts: {} }
  }

  const snapshotDir = path.join(usageRoot, 'snapshots')
  mkdirSync(snapshotDir, { recursive: true })

  const todayStart = startOfDay(Date.now())

  // window 定义：[startMs, endMsExclusive)
  const windowRanges = {
    today:     { start: todayStart,  end: todayStart + 86400000 },
    last7days: { start: todayStart - 6 * 86400000,  end: todayStart + 86400000 },
    last30days:{ start: todayStart - 29 * 86400000, end: todayStart + 86400000 },
  }

  const counts = { today: 0, last7days: 0, last30days: 0 }
  const streams = {}
  for (const id of Object.keys(windowRanges)) {
    try { unlinkSync(path.join(snapshotDir, id + '.jsonl')) } catch { /* 不存在也行 */ }
    streams[id] = []
  }

  function flush(id) {
    if (streams[id].length === 0) return
    writeFileSync(path.join(snapshotDir, id + '.jsonl'), streams[id].join('\n') + '\n')
    counts[id] = streams[id].length
    streams[id] = []
  }

  for (const file of listSessionFiles(sessionRoot)) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.length === 0) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type !== 'assistant/message') continue
      if (typeof event.time !== 'number') continue
      const t = event.time
      const compact = JSON.stringify({ t, data: event.data })
      for (const id of Object.keys(windowRanges)) {
        const r = windowRanges[id]
        if (t >= r.start && t < r.end) {
          streams[id].push(compact)
          if (streams[id].length >= 500) flush(id)
        }
      }
    }
  }
  for (const id of Object.keys(windowRanges)) flush(id)

  return { rebuilt: true, counts }
}

/* ========== Snapshots 读取与折叠 ========== */

function readSnapshotLines(snapshotDir, id) {
  try {
    return readFileSync(path.join(snapshotDir, id + '.jsonl'), 'utf8').split('\n')
  } catch { return [] }
}

function fold(lines) {
  const total = emptyBucket()
  const dayMap = new Map()
  const hourMap = new Map()
  for (const line of lines) {
    if (line.length === 0) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const t = rec.t
    const usage = rec.data && rec.data.usage
    if (typeof t !== 'number' || !usage) continue
    addUsage(total, usage)
    const dk = startOfDay(t)
    if (!dayMap.has(dk)) dayMap.set(dk, emptyBucket())
    addUsage(dayMap.get(dk), usage)
    const hk = startOfHour(t)
    if (!hourMap.has(hk)) hourMap.set(hk, emptyBucket())
    addUsage(hourMap.get(hk), usage)
  }
  return { total, dayMap, hourMap }
}

function toSeries(map, keyFmt, count, stepMs, base) {
  const buckets = []
  for (let i = 0; i < count; i++) {
    const k = base + i * stepMs
    const start = stepMs === 3600000 ? startOfHour(k) : startOfDay(k)
    const b = map.get(start) || emptyBucket()
    buckets.push({ label: keyFmt(start), start, ...b })
  }
  return buckets
}

/**
 * 主查询：从 snapshots 折叠出 3 个窗口对应的视图。
 * 返回 { windows: { today/last7days/last30days: { ranges, total } }, error }
 */
function computeUsageFromSnapshots(usageRoot) {
  const result = { windows: {}, error: null }
  if (!usageRoot) return result
  const snapshotDir = path.join(usageRoot, 'snapshots')
  const todayStart = startOfDay(Date.now())

  for (const w of WINDOWS) {
    const folded = fold(readSnapshotLines(snapshotDir, w.id))
    let ranges
    if (w.granularity === 'hour') {
      ranges = toSeries(folded.hourMap, fmtHour, 24, 3600000, todayStart)
    } else {
      const base = todayStart - (w.spanDays - 1) * 86400000
      ranges = toSeries(folded.dayMap, fmtDay, w.spanDays, 86400000, base)
    }
    result.windows[w.id] = { ranges, total: folded.total }
  }
  return result
}

module.exports = { recordSnapshots, computeUsageFromSnapshots, WINDOWS }