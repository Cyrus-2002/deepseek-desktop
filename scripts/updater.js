/**
 * DeepSeek Desktop — DeepSeek Harness 源码更新模块。
 *
 * 从 GitHub(deepseek-ai/deepseek-harness) 拉取最新源码，替换本地 harnessRoot
 * （config.json 里指向的那份深 harness 源码目录），并重新 pnpm install + build，
 * 使桌面版引擎跟进上游更新。
 *
 * 安全设计：
 *   - 替换前先把旧 harnessRoot 改名为备份；构建失败则恢复备份，绝不提交半成品。
 *   - 下载用最新 commit SHA 生成的 tarball（可复现），不追 "master" 浮动引用。
 *   - 所有状态（已装 SHA、远程 SHA）记录到 <appRoot>/logs/update-state.json。
 *   - 更新会停止引擎、整目录替换；调用方负责控制引擎生命周期与进度回调。
 *
 * CLI（自测/手动）：
 *   node scripts/updater.js --dry-run   # 只下载+解压到临时目录验证，不改动任何东西
 */

'use strict'

const { execFileSync, spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } = require('node:fs')
const path = require('node:path')
const tar = require('tar')

const OWNER = 'deepseek-ai'
const REPO = 'deepseek-harness'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`
const CODELOAD = `https://codeload.github.com/${OWNER}/${REPO}/tar.gz`
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' }

const MAX_ARCHIVE_MB = 800 // 以防巨型压缩包

/* ---------------- 远程信息 ---------------- */

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS })
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
    const r = await fetch(`${RAW}/${branch}/package.json`, { headers: { 'User-Agent': 'dsh-desktop' } })
    if (r.ok) {
      const pkg = await r.json()
      if (pkg && typeof pkg.version === 'string') version = pkg.version
    }
  } catch { /* 保持 unknown */ }
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
 * @returns {{ ok, remote, localVersion, updateAvailable, firstRun, error }}
 *   updateAvailable：HEAD 的正式版本号 ≠ 本地版本号（两者都可解析时）。
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
    return { ok: true, remote, localVersion, updateAvailable, firstRun: !installedSha, state: st }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/* ---------------- 工具：执行子进程（异步，便于进度回调） ---------------- */

function run(cmd, args, cwd, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let out = ''
    const pump = (buf) => {
      const s = buf.toString()
      out += s
      if (onLine) onLine(s)
    }
    child.stdout && child.stdout.on('data', pump)
    child.stderr && child.stderr.on('data', pump)
    child.on('error', (err) => resolve({ code: -1, out, error: err.message }))
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, out }))
  })
}

/* ---------------- 下载 + 解压 ---------------- */

async function downloadTarball(sha) {
  const url = `${CODELOAD}/${sha}`
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-desktop' } })
  if (!res.ok) throw new Error(`源码下载失败 ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const MB = buf.length / 1048576
  if (MB > MAX_ARCHIVE_MB) throw new Error(`源码包过大(${Math.round(MB)}MB)，已中止`)
  return buf
}

function extractTarGz(archiveFile, destDir) {
  mkdirSync(destDir, { recursive: true })
  return tar.x({ file: archiveFile, cwd: destDir, strip: 1 }).then(() => destDir, (err) => {
    throw new Error(`解压失败: ${err.message}`)
  })
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

    // 1. 下载
    progress('step:download')
    progress('正在从 GitHub 下载最新源码…')
    const buf = await downloadTarball(remote.sha)
    writeFileSync(archivePath, buf)

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
      renameSync(harnessRoot, backupDir)
    }

    // 4. 替换
    progress('step:replace')
    progress('正在替换本地源码…')
    renameSync(sourceDir, harnessRoot)

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
    if (gCommit.code !== 0) throw new Error(`git 快照初始化失败：${gCommit.out.slice(-300)}`)

    // 5. 安装依赖
    progress('step:install')
    progress('正在安装依赖 (pnpm install)…')
    const inst = await run('pnpm', ['install'], harnessRoot)
    if (inst.code !== 0) throw new Error(`pnpm install 失败：${inst.out.slice(-400)}`)

    // 6. 构建
    progress('step:build')
    progress('正在构建 (pnpm run build)，可能需要几分钟…')
    const bld = await run('pnpm', ['run', 'build'], harnessRoot)
    if (bld.code !== 0) throw new Error(`构建失败：${bld.out.slice(-400)}`)

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
        renameSync(backupDir, harnessRoot)
        progress('step:fail')
        progress('更新失败，已恢复旧版本')
      } catch (e2) {
        progress('step:fail')
        progress('更新失败，旧版本备份保留在 ' + backupDir)
      }
    } else {
      progress('step:fail')
      progress('更新失败')
    }
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return { ok: false, error: error.message }
  }
}

/* ---------------- CLI（自测） ---------------- */

if (require.main === module) {
  const APP_ROOT = process.env.DSH_DESKTOP_APP_ROOT || path.join(__dirname, '..')
  const config = JSON.parse(readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8'))
  const harnessRoot = path.resolve(APP_ROOT, config.harnessRoot)
  const dryRun = process.argv.includes('--dry-run')

  ;(async () => {
    const info = await fetchRemoteInfo()
    if (dryRun) {
      console.log(`远程: ${info.branch}@${info.sha.slice(0, 7)} ${info.version} (${info.date})`)
      console.log('正在下载测试…')
      const buf = await downloadTarball(info.sha)
      console.log(`下载完成 ${(buf.length / 1048576).toFixed(1)} MB`)
      const tmp = path.join(APP_ROOT, 'logs', '.dryrun')
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      const archive = path.join(tmp, 'source.tar.gz')
      writeFileSync(archive, buf)
      await extractTarGz(archive, path.join(tmp, 'out'))
      const rootEntry = readdirSync(path.join(tmp, 'out')).filter((n) => !n.startsWith('.'))
      console.log('解压目录:', rootEntry)
      rmSync(tmp, { recursive: true, force: true })
      console.log('dry-run OK（未改动任何文件）')
      process.exit(0)
    }
    const a = await analyze(APP_ROOT, harnessRoot)
    console.log(JSON.stringify(a, null, 2))
    if (a.ok && a.updateAvailable) {
      const r = await applyUpdate({ appRoot: APP_ROOT, harnessRoot, remote: a.remote, progress: (m) => console.log('  ->', m) })
      console.log(r)
    } else {
      console.log(a.ok ? '已是最新' : '检查失败')
    }
    process.exit()
  })().catch((e) => { console.error('ERR', e); process.exit(1) })
}

module.exports = { fetchRemoteInfo, analyze, applyUpdate, readLocalVersion, readLocalSourceSha }
