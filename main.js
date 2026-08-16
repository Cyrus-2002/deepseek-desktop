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
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } = require('node:fs')
const path = require('node:path')

// 打包后：应用代码/资源在 app.asar（只读），用户数据（会话/settings/logs/配置）
// 落在 .exe 同目录（便携绿色，与引擎同盘避免 EXDEV 跨盘 rename）。开发模式两者都在仓库目录。
const RESOURCES = __dirname
const APP_ROOT = app.isPackaged ? path.dirname(process.execPath) : __dirname
process.env.DSH_DESKTOP_APP_ROOT = APP_ROOT

const engine = require('./scripts/engine.js')
const usage = require('./scripts/usage.js')

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

function loadConfig() {
  const configPath = path.join(APP_ROOT, 'config.json')
  const defaults = {
    harnessRoot: path.join(APP_ROOT, '..', 'deepseek-harness-master'),
    nodePath: process.env.DSH_DESKTOP_NODE || 'node',
    window: { width: 1280, height: 820, minWidth: 960, minHeight: 640 },
  }
  let user = {}
  try {
    user = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch { /* 首次运行：生成默认配置 */ }
  const config = { ...defaults, ...user, window: { ...defaults.window, ...(user.window || {}) } }
  // harnessRoot 允许相对路径（相对应用目录），此处解析为绝对路径，
  // 避免打包后 cwd 变化导致引擎找不到。
  if (config.harnessRoot && !path.isAbsolute(config.harnessRoot)) {
    config.harnessRoot = path.resolve(APP_ROOT, config.harnessRoot)
  }
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  } catch { /* 只读时忽略 */ }
  return config
}

function validateHarness(root) {
  const needed = [
    ['CLI 入口', path.join(root, 'apps', 'cli', 'lib', 'bin.js')],
    ['Web 前端', path.join(root, 'apps', 'web', 'dist', 'index.html')],
  ]
  return needed.filter(([, p]) => !existsSync(p))
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

function waitForEngineReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const state = engine.getState()
      if (state.ready && state.url !== null) return resolve(state.url)
      if (Date.now() > deadline) return reject(new Error('等待引擎就绪超时（60s）'))
      setTimeout(tick, 150)
    }
    tick()
  })
}

function stopServer() {
  intentionalStop = true
  engine.stopEngine()
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (serverUrl !== null && url.startsWith(serverUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
  })
  window.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    log(`页面加载失败: ${code} ${description} ${validatedURL}`)
    if (serverUrl !== null && validatedURL.startsWith(serverUrl)) {
      window.webContents.send('desktop:error', `页面加载失败（${code} ${description}）`)
    }
  })
  // 每次页面加载完成后注入桌面版主题（splash/usage 页自有样式，注入无害；dsh UI 需要精修）。
  window.webContents.on('did-finish-load', () => {
    injectTheme(window)
    // 仅在 dsh 主界面注入常驻设置按钮（splash/usage 页不注入）。
    if (serverUrl !== null && window.webContents.getURL().startsWith(serverUrl)) {
      injectSettingsButton(window)
    }
  })

  installMenu(window)

  showLoading(window)
  return window
}

/** 平滑切换：让启动页淡出，再加载真实 UI。 */
function fadeSplashThenLoad(window, url) {
  const fade = () => {
    try {
      window.webContents.executeJavaScript(
        `document.body && document.body.classList.add('ds-splash-fade')`,
      ).catch(() => {})
    } catch { /* 页面可能已卸载 */ }
  }
  fade()
  // 200ms 淡出后切换文档；即便淡出失败也照常切换
  setTimeout(() => {
    if (window.isDestroyed()) return
    serverUrl = url
    window.loadURL(url)
  }, 220)
}

async function boot(config) {
  const window = createWindow(config)
  try {
    engine.startEngine({ harnessRoot: config.harnessRoot, nodePath: config.nodePath })
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
    if (window.isDestroyed()) return
    window.webContents.send('desktop:error', `引擎启动失败：${error.message}`)
    window.webContents.send('desktop:show-retry', true)
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
        { label: '打开会话目录', click: () => revealInExplorer(path.join(APP_ROOT, 'session')) },
        { label: '打开 Skills 目录', click: () => revealInExplorer(path.join(APP_ROOT, 'skills')) },
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
  ipcMain.handle('desktop:restart', async () => {
    engine.stopEngine()
    // 关闭现有窗口，避免 retry 时叠加出多个窗口
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.destroy()
    await new Promise((resolve) => setTimeout(resolve, 300))
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

  const missing = validateHarness(app.config.harnessRoot)
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
    stopServer()
    app.quit()
  })

  app.on('before-quit', () => {
    stopServer()
  })
}
