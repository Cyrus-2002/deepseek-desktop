/**
 * DeepSeek Desktop — DeepSeek Harness 源码更新模块。
 *
 * 从 GitHub(deepseek-ai/deepseek-harness) 拉取最新源码，替换本地 harnessRoot
 * （config.json 里指向的那份深 harness 源码目录），并重新 pnpm install + build，
 * 使桌面版引擎跟进上游更新。
 *
 * 安全设计：
 *   - 替换前先把旧 harnessRoot 改名为备份；构建失败则恢复备份，绝不提交半成品。
 *   - 下载用最新 commit SHA 生成的 tarball（可复现），不追 "master" 浮动引用；
 *     流式写盘并全程限长，不整包进内存。
 *   - 所有网络请求带超时；403 限流给出可读提示。
 *   - 替换用「改名优先、跨盘回退复制」策略（EXDEV 兜底）。
 *   - analyze() 检测本地 git 未提交改动（dirty），由调用方决定是否提示用户。
 *   - 所有状态（已装 SHA、远程 SHA）记录到 <appRoot>/logs/update-state.json。
 *   - 更新会停止引擎、整目录替换；调用方负责控制引擎生命周期与进度回调。
 *
 * 子进程约定（Windows）：git/pnpm 都通过 `cmd.exe /d /s /c "<整条命令>"`
 * 启动（等价 cross-spawn 方案），参数用 Windows 规则手工引号化——
 * 直接 spawn 会因 .cmd 需要 shell、而 shell:true 不加引号导致
 * 含空格参数（如 git commit 消息）被拆词。
 *
 * CLI（自测/手动）：
 *   node scripts/updater.js --dry-run            # 只下载+解压到临时目录验证，不改动任何东西
 *   node scripts/updater.js [--force]            # 完整更新；本地有未提交改动时需要 --force
 */

'use strict'

const { execFileSync, spawn } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, cpSync } = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const tar = require('tar')

const OWNER = 'deepseek-ai'
const REPO = 'deepseek-harness'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`
const CODELOAD = `https://codeload.github.com/${OWNER}/${REPO}/tar.gz`
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' }

const MAX_ARCHIVE_MB = 800 // 以防巨型压缩包
const FETCH_TIMEOUT_MS = 30_000 // API / raw 请求超时
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000 // 下载整体超时
const PROC_TIMEOUT_MS = 20 * 60_000 // git/pnpm 步骤超时（build 可能需要几分钟）

/* ---------------- 网络请求（带超时与限流提示） ---------------- */

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 403) {
    throw new Error(`GitHub 请求被限流(403)：匿名请求每小时 60 次，请稍后再试。URL: ${url}`)
  }
  return res
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`GitHub 请求失败 ${res.status}: ${url}`)
  return res.json()
}

/**
 * 解析最新版本信息。
 * @returns {{ branch, sha, date, message, version }}
 */
async function fetchRemoteInfo() {
  const repo = await fetchJson(API)
  const branch = repo.default_branch || 'master'
  // 最新提交（master 背离即当前 HEAD，反映最新改动；也用于生成可复现 tarball）
  const commit = await fetchJson(`${API}/commits/${branch}`)
  const sha = commit.sha
  const date = commit.commit && commit.commit.committer && commit.commit.committer.date
  const message = (commit.commit && commit.commit.message || '').split('\n')[0]
  // HEAD 处根 package.json 的正式版本号（版本对比基准）
  let version = 'unknown'
  try {
    const r = await fetchWithTimeout(`${RAW}/${branch}/package.json`)
    if (r.ok) {
      const pkg = await r.json()
      if (pkg && typeof pkg.version === 'string') version = pkg.version
    }
  } catch (error) {
    if (/限流/.test(error.message)) throw error // 限流值得让用户知道，其余保持 unknown
  }
  return { branch, sha, date, message, version }
}

/* ---------------- 本地基线 ---------------- */

function readLocalVersion(harnessRoot) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(harnessRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch { return 'unknown' }
}

/**
 * Resolve the upstream SHA for both a normal clone and our lightweight
 * tarball snapshot.  A tarball has no upstream .git history, so the updater
 * records the downloaded SHA in its empty snapshot commit message.
 */
function readLocalSourceSha(harnessRoot) {
  const options = { cwd: harnessRoot, encoding: 'utf8', windowsHide: true }
  try {
    const message = execFileSync('git', ['log', '-1', '--format=%B'], options)
    const snapshot = /source snapshot\s+([0-9a-f]{7,40})/i.exec(message)
    if (snapshot) return snapshot[1]
  } catch { /* not a git repository */ }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], options).trim()
  } catch { return null }
}

/**
 * 本地 harness 是否有未提交改动（.git 仓库时）。tarball 快照装出来的目录
 * 没有历史，视为不脏。
 */
function readDirtyState(harnessRoot) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: harnessRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return out.trim().length > 0
  } catch { return false }
}

function isSameSource(remoteSha, installedSha) {
  if (typeof remoteSha !== 'string' || typeof installedSha !== 'string') return false
  const remote = remoteSha.trim().toLowerCase()
  const installed = installedSha.trim().toLowerCase()
  return remote === installed || (installed.length >= 7 && remote.startsWith(installed))
}

function stateFile(appRoot) {
  return path.join(appRoot, 'logs', 'update-state.json')
}
function loadState(appRoot) {
  try { return JSON.parse(readFileSync(stateFile(appRoot), 'utf8')) } catch { return {} }
}
function saveState(appRoot, state) {
  try {
    mkdirSync(path.dirname(stateFile(appRoot)), { recursive: true })
    writeFileSync(stateFile(appRoot), JSON.stringify(state, null, 2) + '\n')
  } catch { /* 非致命 */ }
}

/**
 * 判断是否有可用更新。
 * @returns {{ ok, remote, localVersion, updateAvailable, firstRun, dirty, error }}
 *   updateAvailable：优先比对已装 SHA；无记录时退回版本号比较。
 *   dirty：本地 harness 是 git 仓库且有未提交改动（更新将覆盖这些改动）。
 */
async function analyze(appRoot, harnessRoot) {
  try {
    const remote = await fetchRemoteInfo()
    const localVersion = readLocalVersion(harnessRoot)
    const st = loadState(appRoot)
    const installedSha = st.installedSha || readLocalSourceSha(harnessRoot)
    // Once an update has completed, the recorded upstream SHA is authoritative:
    // upstream can publish several commits without bumping package.json.
    // For an older install without a record, retain the safe version fallback.
    const updateAvailable = installedSha
      ? !isSameSource(remote.sha, installedSha)
      : remote.version !== 'unknown' && localVersion !== 'unknown' && remote.version !== localVersion
    const dirty = readDirtyState(harnessRoot)
    return { ok: true, remote, localVersion, updateAvailable, firstRun: !installedSha, dirty, state: st }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/* ---------------- 工具：执行子进程（异步，便于进度回调） ---------------- */

/**
 * Windows 参数引号化：含空白/引号的参数包一层双引号，内部引号按
 * CommandLineToArgvW 规则转义。拒绝 % 与换行（cmd 会做变量展开）。
 */
function quoteArg(arg) {
  const s = String(arg)
  if (/[\r\n%]/.test(s)) throw new Error(`子进程参数包含不安全字符，已中止: ${JSON.stringify(s.slice(0, 60))}`)
  if (s !== '' && !/[\s"]/.test(s)) return s
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* 已退出 */ }
}

function run(cmd, args, cwd, onLine, timeoutMs = PROC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    if (process.platform === 'win32') {
      // /d 禁用 AutoRun；/s /c + 整体引号让内层参数的引号原样保留。
      const cmdline = [cmd, ...args].map(quoteArg).join(' ')
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    } else {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    let out = ''
    const pump = (buf) => {
      const s = buf.toString()
      out += s
      if (out.length > 1024 * 1024) out = out.slice(-512 * 1024) // 防止超长输出占用内存
      if (onLine) onLine(s)
    }
    child.stdout && child.stdout.on('data', pump)
    child.stderr && child.stderr.on('data', pump)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
    timer.unref?.()
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out, error: err.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code === null ? -1 : code, out, error: timedOut ? `步骤超时(${Math.round(timeoutMs / 60000)} 分钟)` : undefined })
    })
  })
}

/* ---------------- 下载 + 解压 ---------------- */

/**
 * 流式下载源码 tarball 到 archivePath（不整包进内存），带总量上限与进度回调。
 * @returns {Promise<number>} 实际字节数
 */
async function downloadTarball(sha, archivePath, onProgress) {
  let res
  try {
    res = await fetch(`${CODELOAD}/${sha}`, { headers: HEADERS, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`下载超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)} 分钟），请检查网络后重试`)
    throw error
  }
  if (res.status === 403) throw new Error('GitHub 下载被限流(403)：匿名请求每小时 60 次，请稍后再试')
  if (!res.ok) throw new Error(`源码下载失败 ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (total > MAX_ARCHIVE_MB * 1048576) throw new Error(`源码包过大(${Math.round(total / 1048576)}MB)，已中止`)

  mkdirSync(path.dirname(archivePath), { recursive: true })
  const maxBytes = MAX_ARCHIVE_MB * 1048576
  let received = 0
  let lastReport = 0
  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (received > maxBytes) source.destroy(new Error(`源码包超过 ${MAX_ARCHIVE_MB}MB 上限，已中止`))
    if (onProgress && received - lastReport > 2 * 1048574) {
      lastReport = received
      onProgress(received, total)
    }
  })
  try {
    await pipeline(source, createWriteStream(archivePath))
  } catch (error) {
    try { rmSync(archivePath, { force: true }) } catch { /* 忽略 */ }
    if (error.name === 'TimeoutError' || /aborted|超时/.test(String(error.message))) {
      throw new Error(`下载超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)} 分钟），请检查网络后重试`)
    }
    throw new Error(`下载失败: ${error.message}`)
  }
  return received
}

function extractTarGz(archiveFile, destDir) {
  mkdirSync(destDir, { recursive: true })
  return tar.x({ file: archiveFile, cwd: destDir, strip: 1 }).then(() => destDir, (err) => {
    throw new Error(`解压失败: ${err.message}`)
  })
}

/** 目录移动：同盘改名（原子），跨盘（EXDEV）回退为复制+删除。 */
function moveDir(src, dest) {
  try {
    renameSync(src, dest)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/* ---------------- 核心：应用更新 ---------------- */

/**
 * 应用更新：下载 → 解压 → 备份旧版 → 替换 → pnpm install → build → 状态记录。
 * @param {object} opts { appRoot, harnessRoot, remote, progress(msg) }
 *   remote 来自 fetchRemoteInfo()。
 * @returns {{ ok, error?|message }}
 */
async function applyUpdate(opts) {
  const { appRoot, harnessRoot, remote, progress = () => {} } = opts
  const tmpRoot = path.join(appRoot, 'logs', '.update-tmp')
  const harnessParent = path.dirname(harnessRoot)
  const backupDir = path.join(harnessParent, `.dsh-fallback-${Date.now()}`)
  const archivePath = path.join(tmpRoot, 'source.tar.gz')
  const extractDir = path.join(tmpRoot, 'extract')

  try {
    mkdirSync(tmpRoot, { recursive: true })

    // 1. 下载（流式写盘 + 百分比进度）
    progress('step:download')
    const bytes = await downloadTarball(remote.sha, archivePath, (received, total) => {
      progress(total ? `正在从 GitHub 下载最新源码… ${Math.round((received / total) * 100)}%` : `正在从 GitHub 下载最新源码… ${Math.round(received / 1048576)}MB`)
    })
    progress(`源码下载完成 ${Math.round(bytes / 1048576)}MB`)

    // 2. 解压（strip:1 直接去掉顶层 deepseek-harness-<sha> 目录，源码落在 extractDir）
    progress('step:extract')
    progress('正在解压源码…')
    rmSync(extractDir, { recursive: true, force: true })
    await extractTarGz(archivePath, extractDir)
    const sourceDir = extractDir

    // 3. 备份旧版
    progress('step:backup')
    progress('正在备份旧版本…')
    if (existsSync(harnessRoot)) {
      rmSync(backupDir, { recursive: true, force: true })
      moveDir(harnessRoot, backupDir)
    }

    // 4. 替换
    progress('step:replace')
    progress('正在替换本地源码…')
    moveDir(sourceDir, harnessRoot)

    // 4.5 初始化 git 快照仓库：构建脚本用 git rev-parse HEAD 嵌入版本号，
    //     tarball 源码不是 git 仓库会直接构建失败（本地快照提交即可满足）
    progress('step:git')
    progress('正在登记源码版本信息…')
    const gitCfg = ['-c', 'user.name=deepseek-desktop', '-c', 'user.email=dsh@local']
    const gInit = await run('git', [...gitCfg, 'init'], harnessRoot)
    // The build only needs a valid HEAD.  Do not stage the full extracted tree:
    // node_modules can contain hundreds of thousands of files and made updates
    // appear to hang even though no source snapshot was required.
    const gCommit = gInit.code === 0
      ? await run('git', [...gitCfg, 'commit', '--allow-empty', '-m', `source snapshot ${remote.sha.slice(0, 7)} (${remote.version})`], harnessRoot)
      : gInit
    if (gCommit.code !== 0) throw new Error(`git 快照初始化失败：${(gCommit.error || gCommit.out).slice(-300)}`)

    // 5. 安装依赖
    progress('step:install')
    progress('正在安装依赖 (pnpm install)…')
    const inst = await run('pnpm', ['install'], harnessRoot)
    if (inst.code !== 0) throw new Error(`pnpm install 失败：${(inst.error || inst.out).slice(-400)}`)

    // 6. 构建
    progress('step:build')
    progress('正在构建 (pnpm run build)，可能需要几分钟…')
    const bld = await run('pnpm', ['run', 'build'], harnessRoot)
    if (bld.code !== 0) throw new Error(`构建失败：${(bld.error || bld.out).slice(-400)}`)

    // 7. 记录成功状态
    const now = new Date().toISOString()
    saveState(appRoot, {
      installedSha: remote.sha,
      installedVersion: remote.version,
      installedAt: now,
      lastRemoteSha: remote.sha,
      lastRemoteVersion: remote.version,
      lastCheckedAt: now,
    })
    // 清理
    rmSync(backupDir, { recursive: true, force: true })
    rmSync(tmpRoot, { recursive: true, force: true })
    progress('step:done')
    progress(`更新完成：${remote.version} (${remote.sha.slice(0, 7)})`)
    return { ok: true, version: remote.version, sha: remote.sha }
  } catch (error) {
    // 回滚：只要备份存在且更新未成功，一律恢复旧版
    // （包括"替换后 install/build 失败"的情况——新源码没有构建产物不可用）
    if (existsSync(backupDir)) {
      try {
        if (existsSync(harnessRoot)) rmSync(harnessRoot, { recursive: true, force: true })
        moveDir(backupDir, harnessRoot)
        progress('step:fail')
        progress('更新失败，已恢复旧版本')
      } catch {
        progress('step:fail')
        progress('更新失败，旧版本备份保留在 ' + backupDir)
      }
    } else {
      progress('step:fail')
      progress('更新失败：' + error.message)
    }
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return { ok: false, error: error.message }
  }
}

/* ---------------- CLI（自测） ---------------- */

if (require.main === module) {
  const APP_ROOT = process.env.DSH_DESKTOP_APP_ROOT || path.join(__dirname, '..')
  let config = {}
  try { config = JSON.parse(readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8')) } catch { config = {} }
  const harnessRoot = path.resolve(APP_ROOT, config.harnessRoot || path.join(APP_ROOT, '..', 'deepseek-harness-master'))
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')

  ;(async () => {
    if (dryRun) {
      const info = await fetchRemoteInfo()
      console.log(`远程: ${info.branch}@${info.sha.slice(0, 7)} ${info.version} (${info.date})`)
      console.log('正在下载测试…')
      const tmp = path.join(APP_ROOT, 'logs', '.dryrun')
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      const bytes = await downloadTarball(info.sha, path.join(tmp, 'source.tar.gz'), (r, t) => {
        if (t) process.stdout.write(`\r下载 ${Math.round((r / t) * 100)}%`)
      })
      console.log(`\n下载完成 ${(bytes / 1048576).toFixed(1)} MB`)
      await extractTarGz(path.join(tmp, 'source.tar.gz'), path.join(tmp, 'out'))
      const rootEntry = readdirSync(path.join(tmp, 'out')).filter((n) => !n.startsWith('.'))
      console.log('解压目录:', rootEntry)
      rmSync(tmp, { recursive: true, force: true })
      console.log('dry-run OK（未改动任何文件）')
      process.exit(0)
    }
    const a = await analyze(APP_ROOT, harnessRoot)
    console.log(JSON.stringify(a, null, 2))
    if (a.ok && a.updateAvailable) {
      if (a.dirty && !force) {
        console.error('本地 harness 有未提交改动（dirty），更新会覆盖它们。确认无误请加 --force。')
        process.exit(1)
      }
      const r = await applyUpdate({ appRoot: APP_ROOT, harnessRoot, remote: a.remote, progress: (m) => console.log('  ->', m) })
      console.log(r)
    } else {
      console.log(a.ok ? '已是最新' : '检查失败')
    }
    process.exit()
  })().catch((e) => { console.error('ERR', e); process.exit(1) })
}

module.exports = { fetchRemoteInfo, analyze, applyUpdate, readLocalVersion, readLocalSourceSha, readDirtyState }
