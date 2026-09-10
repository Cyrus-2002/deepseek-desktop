/**
 * DeepSeek Desktop — 共享引擎模块 / CLI。
 *
 * 职责：启动 dsh web 引擎子进程（DSH_HOME=<app 根目录>），等待其就绪
 * （“dsh web: http://127.0.0.1:<port>”），把状态写入 logs/engine.json，
 * 并把引擎输出追加到 logs/engine.log。不依赖管道捕获输出：
 *   - dsh 的 stdout/stderr 直接重定向到文件描述符（file fd，非管道）；
 *   - 本进程轮询日志尾部提取就绪 URL。
 *
 * DSH_HOME 指向应用根目录，因此会话历史、skills、Agent 预设、插件、设置、
 * API key 全部落在 deepseek-desktop/ 目录下（session/、skills/、.agent-presets/、
 * profiles/、settings.yaml、.credentials.yaml）。
 *
 * 并发约定：engineProc/engineState/pollTimer 属于“当前进程实例”。
 * 所有事件回调先比对捕获的 proc 与当前 engineProc，旧进程的迟到事件
 * （重启后晚退）一律忽略，避免清掉新进程的句柄与轮询。
 *
 * 两种用法：
 *   1) require('./engine.js') → { startEngine(config), stopEngine(), getState(), procAlive() }
 *   2) CLI：node scripts/engine.js（供启动脚本 / Edge App 模式使用）
 */

'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, statSync, readSync, writeSync, closeSync } = require('node:fs')
const path = require('node:path')

const APP_ROOT = process.env.DSH_DESKTOP_APP_ROOT || path.join(__dirname, '..')
const LOG_DIR = path.join(APP_ROOT, 'logs')
const ENGINE_LOG = path.join(LOG_DIR, 'engine.log')
const STATE_FILE = path.join(LOG_DIR, 'engine.json')
// 就绪 URL 可能携带认证参数（0.1.5+ 的 dsh web 会在 URL 上附 ?token=…），
// 必须完整捕获，丢了令牌加载会被信任栅栏拒绝（黑屏）。
const READY_LINE = /dsh web: (https?:\/\/\S+)/
const STOP_TIMEOUT_MS = 5000

let engineProc = null
let engineState = { pid: null, url: null, dshHome: null, startedAt: null, ready: false }
let tailOffset = 0
let pollTimer = null
// 必须在使用之前声明：startEngine 注册的 exit 回调会读取它（CLI 模式下同步场景）
let isCliMode = false

function procAlive() {
  return engineProc !== null && engineProc.exitCode === null && engineProc.signalCode === null
}

function getState() {
  return { ...engineState }
}

function writeState() {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(engineState, null, 2) + '\n')
  } catch (error) {
    log(`写入引擎状态失败: ${error.message}`)
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const fd = openSync(ENGINE_LOG, 'a')
    try { writeSync(fd, Buffer.from(line + '\n', 'utf8')) } finally { closeSync(fd) }
  } catch { /* 日志失败不阻塞 */ }
  console.log(line)
}

function drainEngineLog() {
  if (engineProc === null) return
  let fd = null
  try {
    fd = openSync(ENGINE_LOG, 'r')
    const size = statSync(ENGINE_LOG).size
    if (size <= tailOffset) { closeSync(fd); return }
    const buf = Buffer.alloc(size - tailOffset)
    readSync(fd, buf, 0, buf.length, tailOffset)
    tailOffset = size
    const text = buf.toString('utf8')
    const match = READY_LINE.exec(text)
    if (match !== null && !engineState.ready) {
      engineState.ready = true
      engineState.url = match[1]
      log(`引擎就绪: ${engineState.url}`)
      writeState()
    }
  } catch (error) {
    if (!String(error.message).includes('ENOENT')) log(`读取引擎日志失败: ${error.message}`)
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/** 释放当前进程实例的句柄与轮询（仅当 proc 仍是当前实例时生效）。 */
function releaseProc(proc) {
  if (engineProc !== proc) return
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
  engineProc = null
  engineState = { pid: null, url: null, dshHome: engineState.dshHome, startedAt: engineState.startedAt, ready: false }
  writeState()
}

/**
 * 启动 dsh web 引擎。
 * @param {object} options
 * @param {string} options.harnessRoot - dsh 安装（含 apps/cli/lib 与 apps/web/dist）。
 * @param {string} options.nodePath - node 可执行文件。
 */
function startEngine(options) {
  if (engineProc !== null) return { proc: engineProc, dshHome: engineState.dshHome }

  const bin = path.join(options.harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const dshHome = APP_ROOT
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })

  engineState = { pid: null, url: null, dshHome, startedAt: new Date().toISOString(), ready: false }
  // 从当前日志末尾开始增量读取：忽略历史运行遗留的旧 "dsh web:" 就绪行，
  // 只匹配本次启动后新增的输出。
  try { tailOffset = existsSync(ENGINE_LOG) ? statSync(ENGINE_LOG).size : 0 } catch { tailOffset = 0 }
  writeState()

  const env = { ...process.env, DSH_HOME: dshHome }
  // V8 字节码缓存：dsh CLI 是模块重度应用，缓存编译产物可显著加速重复启动（Node 22.1+）
  try {
    const cacheDir = path.join(APP_ROOT, 'logs', '.node-compile-cache')
    mkdirSync(cacheDir, { recursive: true })
    env.NODE_COMPILE_CACHE = cacheDir
  } catch { /* 缓存目录创建失败则不启用 */ }
  log(`启动引擎: ${options.nodePath} ${bin} web --port 0 --no-open  (DSH_HOME=${dshHome})`)

  const outFd = openSync(ENGINE_LOG, 'a')
  // The Electron shell owns the web view.  Prevent dsh from also opening the
  // system browser on every desktop launch.
  const proc = spawn(options.nodePath, [bin, 'web', '--port', '0', '--no-open'], {
    cwd: options.harnessRoot,
    env,
    stdio: ['ignore', outFd, outFd],
    windowsHide: true,
  })
  closeSync(outFd)
  engineProc = proc
  engineState.pid = proc.pid
  writeState()

  pollTimer = setInterval(drainEngineLog, 100)
  pollTimer.unref?.()

  // spawn 失败（如 nodePath 无效）只触发 error 不触发 exit：同样按实例清理，
  // 否则句柄残留会让 startEngine 的幂等守卫永远拒绝重启。
  proc.on('error', (error) => {
    log(`引擎进程错误: ${error.message}`)
    releaseProc(proc)
  })
  proc.on('exit', (code, signal) => {
    log(`引擎退出: code=${code} signal=${signal}`)
    releaseProc(proc)
    if (isCliMode && code !== 0 && code !== null) process.exitCode = code
  })
  return { proc, dshHome }
}

/**
 * 停止引擎并等待进程真正退出。
 * Windows 上用 taskkill /T /F 树杀（dsh 可能派生自己的子进程，裸 kill 会留孤儿）；
 * 其余平台先 SIGTERM，超时后 SIGKILL。
 * @param {number} [timeoutMs]
 * @returns {Promise<void>} 进程退出（或超时强杀）后 resolve。
 */
async function stopEngine(timeoutMs = STOP_TIMEOUT_MS) {
  const proc = engineProc
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }

  // 并发调用只发一次停止指令（quit 路径与 restart 路径可能先后触发）
  if (proc !== null && !proc.killed && !proc._dshStopRequested) {
    proc._dshStopRequested = true
    log('正在停止引擎…')
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      const killer = spawn(taskkill, ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { try { proc.kill() } catch { /* 已退出 */ } })
    } else {
      proc.kill('SIGTERM')
    }
  }

  if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
        resolve()
      }, timeoutMs)
      timer.unref?.()
      proc.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  releaseProc(proc)
}

module.exports = { startEngine, stopEngine, getState, procAlive }

if (require.main === module) {
  isCliMode = true
  const configPath = path.join(APP_ROOT, 'config.json')
  let config = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { config = {} }
  const harnessRoot = config.harnessRoot || path.join(APP_ROOT, '..', 'deepseek-harness-master')
  const nodePath = process.env.DSH_DESKTOP_NODE || config.nodePath || 'node'

  const missing = [
    path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'),
    path.join(harnessRoot, 'apps', 'web', 'dist', 'index.html'),
  ].filter((p) => !existsSync(p))
  if (missing.length > 0) {
    console.error(`[engine] 未找到完整构建产物: ${missing.join(', ')}`)
    console.error(`[engine] 请检查 config.json 的 harnessRoot: ${harnessRoot}`)
    process.exit(2)
  }

  startEngine({ harnessRoot, nodePath })

  const shutdown = (code) => { stopEngine().finally(() => process.exit(code)) }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))

  const parentPid = process.ppid
  if (parentPid > 0) {
    const watcher = setInterval(() => {
      try { process.kill(parentPid, 0) } catch {
        clearInterval(watcher)
        log('父进程已退出，自动停止引擎')
        shutdown(0)
      }
    }, 2000)
    watcher.unref?.()
  }
}
