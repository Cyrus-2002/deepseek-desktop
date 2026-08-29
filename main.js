/**
 * DeepSeek Desktop — Electron 主进程。
 *
 * 架构：Electron 外壳 + 本地 dsh web 引擎。
 *   - 主进程以子进程方式启动 `dsh web`（DeepSeek Harness 的浏览器服务），
 *     解析其打印的 `dsh web: http://127.0.0.1:<port>` 行得到本机 URL；
 *   - 渲染进程加载该 URL（复用整个 dsh web 前端，零改造）；
 *   - 所有用户数据（会话、skills、预设、插件、设置、key）都落在 <app>/（DSH_HOME=应用根），
 *     关闭窗口时回收引擎进程。
 *
 * 运行方式：`npm start`。冒烟测试：`electron . --smoke`。
 */

'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync, rmSync } = require('node:fs')
const path = require('node:path')

// 打包后：应用代码/资源在 app.asar（只读），用户数据（会话/settings/logs/配置）
// 落在 .exe 同目录（便携绿色，与引擎同盘避免 EXDEV 跨盘 rename）。开发模式两者都在仓库目录。
const RESOURCES = __dirname
const APP_ROOT = app.isPackaged ? path.dirname(process.execPath) : __dirname
process.env.DSH_DESKTOP_APP_ROOT = APP_ROOT

const engine = require('./scripts/engine.js')
const usage = require('./scripts/usage.js')
const updater = require('./scripts/updater.js')

const APP_NAME = 'DeepSeek Desktop'
const APP_ID = 'com.deepseek.desktop'

// 所有用户数据（Electron userData：localStorage、GPU 缓存等）——放在应用数据根内，
// 便携绿色；也避免系统目录权限/跨盘问题（单实例锁依赖 userData 可写）。
// 必须在 requestSingleInstanceLock() 之前设置。
app.setPath('userData', path.join(APP_ROOT, 'userdata'))

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

const LOG_DIR = path.join(APP_ROOT, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'desktop.log')
const LOG_MAX_BYTES = 2 * 1024 * 1024

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      writeFileSync(LOG_FILE, '')
    }
    appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 日志失败不阻塞应用 */ }
  console.log(line)
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/** 剥离 JSONC 注释（README 示例配置允许行注释与块注释；字符串字面量内的注释不受影响）。 */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * 加载 config.json。健壮性约定：
 *   - 支持带注释的 JSONC；
 *   - 解析失败只用默认值并保留原文件（绝不回写覆盖，避免用户配置丢失）；
 *   - 仅在首次运行（文件不存在）时生成默认配置。
 */
function loadConfig() {
  const configPath = path.join(APP_ROOT, 'config.json')
  const defaults = {
    harnessRoot: path.join(APP_ROOT, '..', 'deepseek-harness-master'),
    nodePath: process.env.DSH_DESKTOP_NODE || 'node',
    window: { width: 1280, height: 820, minWidth: 960, minHeight: 640 },
  }
  const existed = existsSync(configPath)
  let user = {}
  if (existed) {
    try {
      user = JSON.parse(stripJsonComments(readFileSync(configPath, 'utf8')))
      if (user === null || typeof user !== 'object') user = {}
    } catch (error) {
      log(`config.json 解析失败（文件保持原样，请手动修复），本次使用默认配置: ${error.message}`)
    }
  }
  const config = { ...defaults, ...user, window: { ...defaults.window, ...(user.window || {}) } }
  // harnessRoot 允许相对路径（相对应用目录），此处解析为绝对路径，
  // 避免打包后 cwd 变化导致引擎找不到。
  if (config.harnessRoot && !path.isAbsolute(config.harnessRoot)) {
    config.harnessRoot = path.resolve(APP_ROOT, config.harnessRoot)
  }
  if (!existed) {
    try { writeFileSync(configPath, JSON.stringify(defaults, null, 2) + '\n') } catch { /* 只读时忽略 */ }
  }
  return config
}

function validateHarness(root) {
  const needed = [
    ['CLI 入口', path.join(root, 'apps', 'cli', 'lib', 'bin.js')],
    ['Web 前端', path.join(root, 'apps', 'web', 'dist', 'index.html')],
  ]
  return needed.filter(([, p]) => !existsSync(p))
}

/** 更新进行中标志：为 true 时拦截退出，避免中断留下无构建产物的新源码。 */
let updating = false
/** 更新期间用户关闭全部窗口：更新结束后自动退出而不是留一个无界面进程。 */
let quitAfterUpdate = false

/**
 * 自愈被中断的更新：harnessRoot 缺构建产物、且旁边存在 .dsh-fallback-* 备份时，
 * 删除半成品并恢复备份（取时间戳最新的一个）。
 * @returns {boolean} 是否完成了恢复
 */
function recoverInterruptedUpdate(harnessRoot) {
  // A completed update may intentionally retain a fallback directory until a
  // later health check.  Never replace a complete current harness merely
  // because such a backup exists.
  if (validateHarness(harnessRoot).length === 0) return false

  const parent = path.dirname(harnessRoot)
  let fallbacks = []
  try {
    fallbacks = readdirSync(parent).filter((n) => n.startsWith('.dsh-fallback-')).sort()
  } catch { return false }
  if (fallbacks.length === 0) return false
  const fb = path.join(parent, fallbacks[fallbacks.length - 1])
  if (!existsSync(path.join(fb, 'apps', 'cli', 'lib', 'bin.js'))) return false
  try {
    rmSync(harnessRoot, { recursive: true, force: true })
    renameSync(fb, harnessRoot)
    log(`检测到未完成的更新，已自动恢复旧版本（来自 ${path.basename(fb)}）`)
    return true
  } catch (error) {
    log(`恢复中断更新失败: ${error.message}`)
    return false
  }
}

/** 递归复制（asar 兼容：cpSync 无法遍历 asar 内目录，改用 readdir/readFile）。 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}

/**
 * 打包后首次运行：把种子资源（config.json、cordis.patch.yml、示例 skill/预设）
 * 从 asar 复制到应用数据根（DSH_HOME）。cordis.patch.yml 决定会话落盘与原始 JSONL；
 * config.json 携带 harnessRoot 绝对路径。缺失时用量统计读不到数据。
 */
function seedDshHome() {
  if (!app.isPackaged) return
  try {
    for (const file of ['config.json', 'cordis.patch.yml']) {
      const src = path.join(RESOURCES, file)
      const dst = path.join(APP_ROOT, file)
      if (existsSync(src) && !existsSync(dst)) writeFileSync(dst, readFileSync(src))
    }
    for (const dir of ['skills', '.agent-presets']) {
      const src = path.join(RESOURCES, dir)
      const dst = path.join(APP_ROOT, dir)
      if (existsSync(src) && !existsSync(dst)) copyTree(src, dst)
    }
  } catch (error) {
    log(`DSH_HOME 种子复制失败: ${error.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * 引擎进程（实现见 scripts/engine.js）
 * ------------------------------------------------------------------ */

let serverUrl = null
let intentionalStop = false

/** 引擎本机页面判定：严格按 origin 比较（startsWith 会放过 127.0.0.1:30801 这类端口前缀混淆）。 */
function isLocalPage(url) {
  if (serverUrl === null) return false
  try {
    return new URL(url, serverUrl).origin === new URL(serverUrl).origin
  } catch { return false }
}

function waitForEngineReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const state = engine.getState()
      if (state.ready && state.url !== null) return resolve(state.url)
      if (Date.now() > deadline) return reject(new Error(`等待引擎就绪超时（${Math.round(timeoutMs / 1000)}s）`))
      setTimeout(tick, 150)
    }
    tick()
  })
}

function stopServer() {
  intentionalStop = true
  return engine.stopEngine()
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

let mainWindow = null
let usageWindow = null

function showLoading(window) {
  window.loadFile(path.join(RESOURCES, 'assets', 'splash.html'))
}

/** 注入桌面版主题 CSS（Codex/Claude 式极简 + DeepSeek 蓝，见 assets/desktop-theme.css）。 */
function injectTheme(window) {
  try {
    const css = readFileSync(path.join(RESOURCES, 'assets', 'desktop-theme.css'), 'utf8')
    window.webContents.insertCSS(css).catch(() => {})
  } catch { /* 主题文件缺失时静默 */ }
}

/** 注入常驻设置按钮（iOS 风格）+ 下拉菜单，替代需要 Alt 的应用菜单。 */
function injectSettingsButton(window) {
  try {
    const css = readFileSync(path.join(RESOURCES, 'assets', 'desktop-settings.css'), 'utf8')
    const js = readFileSync(path.join(RESOURCES, 'assets', 'desktop-settings.js'), 'utf8')
    window.webContents.insertCSS(css).catch(() => {})
    window.webContents.executeJavaScript(js).catch(() => {})
  } catch { /* 文件缺失时静默 */ }
}

function createWindow(config) {
  const window = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    title: APP_NAME,
    icon: path.join(RESOURCES, 'assets', 'icon.png'),
    backgroundColor: '#f7f9fc',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(RESOURCES, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow = window

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { mainWindow = null })
  // 品牌标题：把 dsh web 的 "DSH Local Build" 窗口标题改写为 DeepSeek
  //（page-title-updated 每次页面改标题都会触发；仅在含品牌串时拦截改写）
  window.on('page-title-updated', (event, title) => {
    if (typeof title === 'string' && title.includes('DSH Local Build')) {
      event.preventDefault()
      window.setTitle(title.split('DSH Local Build').join('DeepSeek'))
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isLocalPage(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
  })
  window.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    log(`页面加载失败: ${code} ${description} ${validatedURL}`)
    if (isLocalPage(validatedURL)) {
      window.webContents.send('desktop:error', `页面加载失败（${code} ${description}）`)
    }
  })
  // 每次页面加载完成后注入桌面版主题（splash/usage 页自有样式，注入无害；dsh UI 需要精修）。
  window.webContents.on('did-finish-load', () => {
    injectTheme(window)
    // 仅在 dsh 主界面注入常驻设置按钮（splash/usage 页不注入）。
    if (isLocalPage(window.webContents.getURL())) {
      injectSettingsButton(window)
    }
  })

  installMenu(window)

  showLoading(window)
  return window
}

/** 平滑切换：让启动页淡出（splash CSS 淡出 0.28s），再加载真实 UI。 */
function fadeSplashThenLoad(window, url) {
  const fade = () => {
    try {
      window.webContents.executeJavaScript(
        `document.body && document.body.classList.add('ds-splash-fade')`,
      ).catch(() => {})
    } catch { /* 页面可能已卸载 */ }
  }
  fade()
  // 等淡出完成后切换文档；即便淡出失败也照常切换
  setTimeout(() => {
    if (window.isDestroyed()) return
    serverUrl = url
    window.loadURL(url)
  }, 300)
}

async function boot(config) {
  // 全新启动：恢复引擎崩溃监视（boot 失败清理路径会置 true）
  intentionalStop = false
  // Start the local service before constructing the splash window.  Window
  // creation and Chromium initialization can now overlap dsh's module load.
  let window = null
  try {
    engine.startEngine({ harnessRoot: config.harnessRoot, nodePath: config.nodePath })
    window = createWindow(config)
    const url = await waitForEngineReady(60_000)
    if (window.isDestroyed()) return
    // 通知启动页淡出（splash 监听 desktop:ready）
    window.webContents.send('desktop:ready', { url })
    if (process.argv.includes('--smoke')) {
      window.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          console.log(`[desktop-smoke] OK ${url}`)
          stopServer()
          app.quit()
        }, 1500)
      })
    }
    fadeSplashThenLoad(window, url)
    const monitor = setInterval(() => {
      const state = engine.getState()
      if (state.ready === false && engine.procAlive() === false && !intentionalStop) {
        clearInterval(monitor)
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('desktop:engine-exited', {})
        }
      }
    }, 1000)
    monitor.unref?.()
  } catch (error) {
    log(`启动失败: ${error.message}`)
    // 启动链路失败（如等待就绪超时）时回收引擎，避免留下僵尸进程；
    // 用户点击启动页「重试」会重新完整走 boot。
    stopServer()
    const activeWindow = window || createWindow(config)
    if (activeWindow.isDestroyed()) return
    activeWindow.webContents.send('desktop:error', `引擎启动失败：${error.message}`)
    activeWindow.webContents.send('desktop:show-retry', true)
  }
}

/* ------------------------------------------------------------------ *
 * 用量窗口
 * ------------------------------------------------------------------ */

function openUsageWindow() {
  if (usageWindow !== null && !usageWindow.isDestroyed()) {
    usageWindow.focus()
    return
  }
  usageWindow = new BrowserWindow({
    width: 660,
    height: 545,
    minWidth: 500,
    minHeight: 470,
    title: 'API 用量',
    parent: mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#f7f9fc',
    icon: path.join(RESOURCES, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(RESOURCES, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  usageWindow.loadFile(path.join(RESOURCES, 'assets', 'usage.html'))
  usageWindow.on('closed', () => { usageWindow = null })
}

/* ------------------------------------------------------------------ *
 * 菜单
 * ------------------------------------------------------------------ */

function revealInExplorer(target) {
  // 目录可能尚未生成（如 session/ 在首次聊天前不存在），先确保存在再打开。
  try {
    mkdirSync(target, { recursive: true })
  } catch { /* 非目录路径时忽略，仍尝试用系统打开 */ }
  shell.openPath(target).then((errorMessage) => {
    if (errorMessage) log(`打开路径失败: ${errorMessage}`)
  })
}

function showAbout(parentWindow) {
  dialog.showMessageBox(parentWindow !== null && !parentWindow.isDestroyed() ? parentWindow : undefined, {
    type: 'info',
    title: '关于 ' + APP_NAME,
    message: APP_NAME,
    detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n\n引擎：DeepSeek Harness (dsh web)\n会话目录：${path.join(APP_ROOT, 'session')}\n引擎安装：${app.config.harnessRoot}`,
    buttons: ['好'],
  })
}

function installMenu(window) {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开会话目录', click: () => revealInExplorer(path.join(APP_ROOT, 'session')) },
        { label: '打开 Skills 目录', click: () => revealInExplorer(path.join(APP_ROOT, 'skills')) },
        { label: '打开日志目录', click: () => revealInExplorer(LOG_DIR) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '设置',
      submenu: [
        { label: 'API 用量', accelerator: 'CmdOrCtrl+Shift+U', click: () => openUsageWindow() },
        {
          label: '检查更新',
          click: () => {
            // 复用注入层的更新覆盖层 UI（桌面壳的悬浮菜单与应用菜单同一入口）
            if (mainWindow !== null && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('desktop:menu-command', 'check-update')
            }
          },
        },
        { type: 'separator' },
        { label: '打开 Agent 预设目录', click: () => revealInExplorer(path.join(APP_ROOT, '.agent-presets')) },
        { label: '打开插件目录', click: () => revealInExplorer(path.join(APP_ROOT, 'profiles', 'web')) },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 ' + APP_NAME, click: () => showAbout(window) },
        {
          label: 'DeepSeek Harness 文档',
          click: () => void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 * IPC（启动页 + 桌面原生能力）
 * ------------------------------------------------------------------ */

function registerIpc(config) {
  const USAGE_ROOT = path.join(APP_ROOT, 'usage')

  ipcMain.handle('desktop:open-usage', () => { openUsageWindow() })
  ipcMain.handle('desktop:open-dir', (_event, name) => {
    const dirs = {
      session: path.join(APP_ROOT, 'session'),
      skills: path.join(APP_ROOT, 'skills'),
      agents: path.join(APP_ROOT, '.agent-presets'),
      plugins: path.join(APP_ROOT, 'profiles', 'web'),
      logs: LOG_DIR,
    }
    const target = dirs[name]
    if (target) revealInExplorer(target)
  })
  ipcMain.handle('desktop:quit', () => { app.quit() })
  ipcMain.handle('desktop:usage', () => {
    try {
      // 每次查询先从 session/ 重建快照（用量永久记录，无删除功能）
      try {
        usage.recordSnapshots(USAGE_ROOT, path.join(APP_ROOT, 'session'))
      } catch (e) {
        log(`快照重建失败: ${e.message}`)
      }
      return usage.computeUsageFromSnapshots(USAGE_ROOT)
    } catch (error) {
      log(`用量统计失败: ${error.message}`)
      return { windows: {}, error: error.message }
    }
  })
  ipcMain.handle('desktop:check-update', async () => {
    try {
      return await updater.analyze(APP_ROOT, config.harnessRoot)
    } catch (error) {
      log(`检查更新失败: ${error.message}`)
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle('desktop:apply-update', async (event) => {
    updating = true
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const progress = (msg) => {
      if (win !== null && !win.isDestroyed()) win.webContents.send('desktop:update-status', msg)
    }
    try {
      // 更新前停掉引擎，避免占用源码文件
      engine.stopEngine()
      progress({ step: 'begin', message: '准备更新…' })
      const remote = await updater.fetchRemoteInfo()
      const r = await updater.applyUpdate({
        appRoot: APP_ROOT,
        harnessRoot: config.harnessRoot,
        remote,
        progress,
        // 下载加速源：环境变量优先，其次 config.json 的 updateMirror
        mirror: process.env.DSH_UPDATE_MIRROR || config.updateMirror,
      })
      // 更新完成后重启引擎并载入新 UI（复用启动页淡出流程）
      if (win !== null && !win.isDestroyed()) showLoading(win)
      try {
        engine.startEngine({ harnessRoot: config.harnessRoot, nodePath: config.nodePath })
        const url = await waitForEngineReady(120_000)
        if (win !== null && !win.isDestroyed()) {
          win.webContents.send('desktop:ready', { url })
          fadeSplashThenLoad(win, url)
        }
      } catch (e2) {
        log(`更新后引擎重启失败: ${e2.message}`)
        progress({ step: 'fail', message: '引擎重启失败：' + e2.message })
      }
      return r
    } catch (error) {
      log(`更新失败: ${error.message}`)
      progress({ step: 'fail', message: '更新失败：' + error.message })
      return { ok: false, error: error.message }
    } finally {
      updating = false
      // 更新期间用户关闭了所有窗口：完成后按用户意愿退出，避免留下无界面的僵尸进程
      if (quitAfterUpdate) {
        await stopServer()
        app.exit(0)
      }
    }
  })
  ipcMain.handle('desktop:restart', async () => {
    // 等引擎真正退出（含 Windows 树杀）再重启，消除新旧进程竞态
    await engine.stopEngine()
    // 关闭现有窗口，避免 retry 时叠加出多个窗口
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.destroy()
    await boot(config)
  })
}

/* ------------------------------------------------------------------ *
 * 应用生命周期
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  seedDshHome()
  app.config = loadConfig()

  // 自愈：上次更新被中断（新源码无构建产物）时，自动恢复旁边的 .dsh-fallback-* 备份
  let missing = validateHarness(app.config.harnessRoot)
  if (missing.length > 0) {
    if (recoverInterruptedUpdate(app.config.harnessRoot)) {
      missing = validateHarness(app.config.harnessRoot)
    }
  }
  if (missing.length > 0) {
    const list = missing.map(([label, p]) => `  · ${label}: ${p}`).join('\n')
    dialog.showErrorBox(
      'DeepSeek Desktop 无法启动',
      `未找到完整的 DeepSeek Harness 构建产物：\n\n${list}\n\n` +
      `请在 config.json 中将 harnessRoot 指向包含构建产物的仓库（运行过 pnpm run build），\n` +
      `然后重新启动。当前配置：${app.config.harnessRoot}`,
    )
    app.exit(1)
  } else {
    // 引擎尽早启动：与 Electron 初始化并行（boot 里 startEngine 幂等，不会重复拉起）
    engine.startEngine({ harnessRoot: app.config.harnessRoot, nodePath: app.config.nodePath })
    app.on('second-instance', () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
    app.whenReady().then(() => {
      app.setAppUserModelId(APP_ID)
      registerIpc(app.config)
      void boot(app.config)
      app.on('activate', () => {
        if (mainWindow === null && BrowserWindow.getAllWindows().length === 0) {
          void boot(app.config)
        }
      })
    })
  }

  app.on('window-all-closed', () => {
    // 更新进行中不允许退出（中断会留下无构建产物的新源码）；
    // 记住用户意愿，更新结束后自动退出。
    if (updating) {
      quitAfterUpdate = true
      return
    }
    stopServer()
    app.quit()
  })

  app.on('before-quit', (event) => {
    // 更新进行中拦截退出请求：更新完成/失败后自然会退出流程
    if (updating) {
      event.preventDefault()
      log('更新进行中，已拦截退出请求')
      return
    }
    stopServer()
  })
}
