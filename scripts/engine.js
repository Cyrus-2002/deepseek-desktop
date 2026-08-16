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
const READY_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

let engineProc = null
let engineState = { pid: null, url: null, dshHome: null, startedAt: null, ready: false }
let tailOffset = 0
let pollTimer = null

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
  log(`启动引擎: ${options.nodePath} ${bin} web --port 0  (DSH_HOME=${dshHome})`)

  const outFd = openSync(ENGINE_LOG, 'a')
  engineProc = spawn(options.nodePath, [bin, 'web', '--port', '0'], {
    cwd: options.harnessRoot,
    env,
    stdio: ['ignore', outFd, outFd],
    windowsHide: true,
  })
  closeSync(outFd)
  engineState.pid = engineProc.pid
  writeState()

  pollTimer = setInterval(drainEngineLog, 150)
  pollTimer.unref?.()

  engineProc.on('error', (error) => {
    log(`引擎进程错误: ${error.message}`)
    engineState.ready = false
    writeState()
  })
  engineProc.on('exit', (code, signal) => {
    log(`引擎退出: code=${code} signal=${signal}`)
    clearInterval(pollTimer)
    pollTimer = null
    engineProc = null
    engineState.ready = false
    engineState.url = null
    writeState()
    if (isCliMode && code !== 0 && code !== null) process.exitCode = code
  })
  return { proc: engineProc, dshHome }
}

function stopEngine() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
  if (engineProc !== null && !engineProc.killed) {
    log('正在停止引擎…')
    engineProc.kill()
    engineProc = null
  }
  engineState.ready = false
  writeState()
}

let isCliMode = false

if (require.main === module) {
  isCliMode = true
  const configPath = path.join(APP_ROOT, 'config.json')
  let config = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { /* 默认 */ }
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

  const shutdown = (code) => { stopEngine(); process.exit(code) }
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

module.exports = { startEngine, stopEngine, getState, procAlive, STATE_FILE }
