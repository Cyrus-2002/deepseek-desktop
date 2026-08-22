/**
 * DeepSeek Desktop - 带数据保护的打包脚本。
 *
 * electron-builder 重建 dist 会清空 dist/win-unpacked，而打包版的用户数据
 * （聊天记录 session/、用量 usage/、settings.yaml、.credentials.yaml 等）
 * 恰恰存放在那里。本脚本在打包前把这些数据搬到 dist/.userdata-backup，
 * 打包完成后恢复回去，使重新打包不再丢数据。
 *
 * 用法：node scripts/dist.js（等价于原 npm run dist，但保数据）
 */

'use strict'

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, renameSync, readdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const UNPACKED = path.join(DIST, 'win-unpacked')
const BACKUP = path.join(DIST, '.userdata-backup')

/**
 * 把鲸鱼图标写入 exe 的资源段（纯 JS，resedit）。
 * electron-builder 的 rcedit 步骤在本机不可靠（Go 工具链崩溃），打包配置里
 * signAndEditExecutable: false 跳过它，图标由这里补上。
 */
function setExeIcon() {
  const exePath = path.join(UNPACKED, 'DeepSeek Desktop.exe')
  const icoPath = path.join(ROOT, 'assets', 'icon.ico')
  if (!existsSync(exePath) || !existsSync(icoPath)) {
    console.log('[dist] 跳过图标注入（缺少 exe 或 icon.ico）')
    return false
  }
  try {
    const ResEdit = require('resedit')
    const exe = ResEdit.NtExecutable.from(readFileSync(exePath))
    const res = ResEdit.NtExecutableResource.from(exe)
    const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath))
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 0, iconFile.icons.map((i) => i.data),
    )
    res.outputResource(exe)
    writeFileSync(exePath, Buffer.from(exe.generate()))
    console.log('[dist] 已注入鲸鱼图标 -> DeepSeek Desktop.exe')
    return true
  } catch (error) {
    console.log(`[dist] 图标注入失败: ${error.message}`)
    return false
  }
}

// 打包版运行时会落在 exe 同目录的用户数据（与 main.js 的 APP_ROOT 逻辑一致）
const USER_DATA = [
  'session', 'usage', 'userdata', 'logs',
  'settings.yaml', '.credentials.yaml', '.anonymous-user-id',
  'config.json', 'cordis.patch.yml',
  'skills', '.agent-presets', 'profiles', 'storages',
]

function backup() {
  if (!existsSync(UNPACKED)) return 0
  mkdirSync(BACKUP, { recursive: true })
  let n = 0
  for (const name of USER_DATA) {
    const src = path.join(UNPACKED, name)
    if (!existsSync(src)) continue
    renameSync(src, path.join(BACKUP, name))
    n++
  }
  return n
}

function restore() {
  if (!existsSync(BACKUP)) return 0
  let n = 0
  for (const name of readdirSync(BACKUP)) {
    const src = path.join(BACKUP, name)
    if (!existsSync(src)) continue
    renameSync(src, path.join(UNPACKED, name))
    n++
  }
  return n
}

function removeEmptyBackup() {
  try { rmSync(BACKUP, { recursive: true, force: true }) } catch { /* 下次打包会覆盖 */ }
}

const moved = backup()
console.log(`[dist] 已备份用户数据 ${moved} 项 -> dist/.userdata-backup`)

const env = {
  ...process.env,
  ELECTRON_CACHE: process.env.ELECTRON_CACHE || 'D:/ai_agent/electron-cache',
  // 无代码签名证书时跳过签名发现，避免误触签名步骤
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}
const result = spawnSync('npx', ['electron-builder', '--dir'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

let restored = 0
if (result.status === 0) {
  setExeIcon()
  restored = restore()
  removeEmptyBackup()
  console.log(`[dist] 已恢复用户数据 ${restored} 项 -> dist/win-unpacked`)
} else {
  // 打包失败也要恢复，避免数据滞留在 backup
  if (existsSync(UNPACKED)) {
    restored = restore()
    removeEmptyBackup()
    console.log(`[dist] 打包失败，已恢复用户数据 ${restored} 项`)
  } else {
    console.log('[dist] 打包失败；用户数据仍在 dist/.userdata-backup，可手动移回')
  }
}
process.exit(result.status ?? 1)
