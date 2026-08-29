/**
 * DeepSeek Desktop — 桌面桥插件安装器。
 *
 * 负责 `dsh-plugin/`（dsh-desktop-bridge 客户端插件）的幂等安装与挂载：
 *   1. 把插件包安装进 `$DSH_HOME/profiles/web/node_modules`（pnpm，属 DSH_HOME，
 *      天然免疫 harness 源码更新覆盖）；
 *   2. 在桌面自己的 `$DSH_HOME/cordis.patch.yml`（最后生效补丁层）维护
 *      `- insert:` 挂载行（同样免疫更新）；
 *   3. 任何失败（pnpm 缺失、安装出错、源缺失）都会**摘除挂载行**，
 *      保证引擎永远能启动——界面退回悬浮按钮回退模式。
 *
 * 全程同步（spawnSync）：只在首次安装或版本升级时花费数秒，常态是纯文件
 * 检查（毫秒级），在引擎拉起前调用完毕，安装当次启动即生效。
 */

'use strict'

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const PLUGIN_NAME = 'dsh-desktop-bridge'
/** 挂载行（写入桌面自己的 cordis.patch.yml，幂等增删） */
const INSERT_ROW = '- insert:\n    - id: dsh-desktop-bridge\n      name: dsh-desktop-bridge\n'
const INSERT_ROW_RE = /- insert:\s*\r?\n\s+- id: dsh-desktop-bridge\s*\r?\n\s+name: dsh-desktop-bridge/
const PNPM_TIMEOUT_MS = 120_000

/* ---------------- 基础工具 ---------------- */

/** Windows 参数引号化（与 updater.js 同规则）：含空白/引号的参数包双引号。 */
function quoteArg(arg) {
  const s = String(arg)
  if (/[\r\n%]/.test(s)) throw new Error(`参数包含不安全字符: ${JSON.stringify(s.slice(0, 60))}`)
  if (s !== '' && !/[\s"]/.test(s)) return s
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/** 同步执行 cmd.exe /d /s /c "<命令>"（pnpm 是 .cmd，必须经 shell，引号自管）。 */
function runCmd(commandLine, cwd, timeoutMs) {
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

function readPackageVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/* ---------------- 挂载行增删（$DSH_HOME/cordis.patch.yml） ---------------- */

function patchPath(appRoot) {
  return path.join(appRoot, 'cordis.patch.yml')
}

function readPatch(appRoot) {
  try {
    return readFileSync(patchPath(appRoot), 'utf8')
  } catch {
    return ''
  }
}

function writePatch(appRoot, text) {
  try {
    writeFileSync(patchPath(appRoot), text, 'utf8')
  } catch { /* 只读等场景忽略：引擎仍可用（无挂载行=回退悬浮） */ }
}

function addPatchRow(appRoot) {
  const text = readPatch(appRoot)
  if (INSERT_ROW_RE.test(text)) return false
  writePatch(appRoot, text.replace(/\n*$/, '\n') + '\n' + INSERT_ROW)
  return true
}

function removePatchRow(appRoot) {
  const text = readPatch(appRoot)
  if (!INSERT_ROW_RE.test(text)) return false
  writePatch(appRoot, text.replace(INSERT_ROW_RE, '').replace(/\n{3,}/g, '\n\n'))
  return true
}

/* ---------------- profile 模板（仅当引擎从未运行过时补齐） ---------------- */

function ensureProfileTemplate(appRoot, log) {
  const profileDir = path.join(appRoot, 'profiles', 'web')
  const pkgFile = path.join(profileDir, 'package.json')
  if (existsSync(pkgFile)) return profileDir
  log('profile 目录不存在，写入初始化模板…')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(pkgFile, JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  if (!existsSync(path.join(profileDir, 'cordis.patch.yml'))) {
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  }
  return profileDir
}

/* ---------------- 主流程 ---------------- */

/**
 * 确保桌面桥插件已安装并挂载。同步、幂等、失败安全（失败时摘除挂载行）。
 * @param {object} opts { appRoot, harnessRoot, nodePath, log }
 * @returns {boolean} 桥是否就绪（true=原生界面可用；false=回退悬浮按钮）
 */
function ensureDesktopBridge(opts) {
  const { appRoot, harnessRoot, nodePath, log = () => {} } = opts
  try {
    const sourceDir = path.join(appRoot, 'dsh-plugin')
    const sourceVersion = readPackageVersion(sourceDir)
    if (!sourceVersion) {
      log('桌面桥插件源缺失（dsh-plugin/），跳过安装，使用悬浮按钮回退')
      removePatchRow(appRoot)
      return false
    }
    if (!existsSync(path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'))) {
      log('harness 构建产物缺失，跳过桌面桥安装')
      removePatchRow(appRoot)
      return false
    }

    const profileDir = ensureProfileTemplate(appRoot, log)
    const installedDir = path.join(profileDir, 'node_modules', PLUGIN_NAME)
    const installedVersion = readPackageVersion(installedDir)

    if (installedVersion !== sourceVersion) {
      if (!existsSync(path.join(profileDir, 'pnpm-workspace.yaml'))) {
        log('profile 缺 pnpm-workspace.yaml，跳过桌面桥安装')
        removePatchRow(appRoot)
        return false
      }
      log(`安装桌面桥插件（${installedVersion || '无'} → ${sourceVersion}）…`)
      const res = runCmd(`pnpm add ${quoteArg(sourceDir)}`, profileDir, PNPM_TIMEOUT_MS)
      const out = `${res.stdout || ''}\n${res.stderr || ''}`
      if (res.status !== 0 || !existsSync(path.join(installedDir, 'package.json'))) {
        log(`桌面桥插件安装失败（status=${res.status}）: ${out.slice(-400).trim()}`)
        log('回退悬浮按钮模式')
        removePatchRow(appRoot)
        return false
      }
      log(`桌面桥插件已安装 ${sourceVersion}`)
    }

    if (addPatchRow(appRoot)) log('已在 cordis.patch.yml 挂载桌面桥')
    log(`桌面桥就绪（v${sourceVersion}），设置对话框将出现「桌面」分组`)
    return true
  } catch (error) {
    log(`桌面桥安装异常: ${error.message}；回退悬浮按钮模式`)
    try { removePatchRow(appRoot) } catch { /* 忽略 */ }
    return false
  }
}

module.exports = { ensureDesktopBridge, PLUGIN_NAME }
