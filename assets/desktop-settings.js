/**
 * DeepSeek Desktop — 桌面壳注入脚本（悬浮设置按钮 + 引擎横幅 + 反馈）。
 * 由主进程在 dsh web UI 加载完成后 executeJavaScript 注入（主 world）。
 * 幂等：重复注入不产生重复元素。元素挂在 document.body（React 根之外）。
 *
 * 双模式（自门控）：
 *   - **桥模式**（推荐路径）：dsh-desktop-bridge 插件已把桌面功能渲染进系统
 *     设置对话框与侧边栏（window.__dshDesktopBridge 就绪）——本脚本只保留
 *     「引擎断开横幅」与 toast，页面完全干净；
 *   - **悬浮回退模式**：桥未就绪（pnpm 缺失 / 安装失败 / harness 更新后兼容
 *     问题）时，最多等待 4.2s 后注入悬浮设置按钮作为回退。
 *
 * 悬浮按钮行为（回退模式）：
 *   - 点击（位移 < 5px）→ 展开/收起菜单；方向键在菜单项间移动。
 *   - 拖动（位移 ≥ 5px）→ 按钮跟随光标，菜单收起；视口 clamp；松开后持久化。
 *   - 位置持久化到 localStorage；窗口缩放只 clamp 不改写保存值。
 */
;(function () {
  'use strict'
  if (window.__dsdeskShellInjected) return
  window.__dsdeskShellInjected = true

  var POS_KEY = 'dsdesk-settings-pos'
  var PAD = 8 // 视口边缘保留距离
  var BRIDGE_WAIT_MS = 4200 // 等待桥插件就绪的时限
  var suppressClick = false // 拖动结束后抑制一次 click，避免误开菜单

  /** 悬浮 UI 的句柄（桥模式保持 null，相关函数安全空转）。 */
  var rootHolder = { root: null, btn: null, menu: null }

  var icon = function (inner) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
  }

  /* ---------------- 共享工具（两种模式都用） ---------------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  /** 轻量 toast：异步失败与静默操作的用户反馈。 */
  function toast(message, isError) {
    var t = document.getElementById('dsdesk-toast')
    if (!t) {
      t = document.createElement('div')
      t.id = 'dsdesk-toast'
      t.className = 'dsdesk-toast'
      t.setAttribute('role', 'status')
      document.body.appendChild(t)
    }
    t.textContent = message
    t.classList.toggle('dsdesk-toast-err', !!isError)
    t.classList.add('show')
    clearTimeout(t._timer)
    t._timer = setTimeout(function () { t.classList.remove('show') }, 2600)
  }
  function fire(promise, label) {
    if (!promise || typeof promise.catch !== 'function') return
    promise.catch(function (e) {
      toast((label || '操作') + '失败：' + (e && e.message ? e.message : '未知错误'), true)
    })
  }

  /** 查找 dsh 自身的设置入口：排除桌面壳自己的元素，按可信度依次尝试。 */
  function findDshTrigger() {
    var selectors = [
      'button[aria-label*="设置" i]',
      'button[title*="设置" i]',
      'button[aria-haspopup="dialog"]',
    ]
    for (var i = 0; i < selectors.length; i++) {
      var candidates = document.querySelectorAll(selectors[i])
      for (var j = 0; j < candidates.length; j++) {
        if (!rootHolder.root || !rootHolder.root.contains(candidates[j])) return candidates[j]
      }
    }
    return null
  }

  /* ---------------- 引擎断开横幅（两种模式都启用，一键重启） ---------------- */

  function showEngineBanner() {
    if (document.getElementById('dsdesk-engine-banner')) return
    var bar = document.createElement('div')
    bar.id = 'dsdesk-engine-banner'
    bar.className = 'dsdesk-engine-banner'
    var text = document.createElement('span')
    text.className = 'dsdesk-engine-text'
    text.textContent = '引擎已断开，会话暂时无法响应'
    var restart = document.createElement('button')
    restart.type = 'button'
    restart.className = 'dsdesk-engine-restart'
    restart.textContent = '重新启动'
    restart.addEventListener('click', function () {
      restart.disabled = true
      text.textContent = '正在重启引擎…'
      fire(window.desktop.restart(), '重启引擎')
    })
    bar.appendChild(text)
    bar.appendChild(restart)
    document.body.appendChild(bar)
  }

  if (window.desktop && typeof window.desktop.onEngineExited === 'function') {
    window.desktop.onEngineExited(function () { showEngineBanner() })
  }

  /* ---------------- 悬浮回退 UI（桥未就绪时才注入） ---------------- */

  function startShellUi() {
    if (rootHolder.root) return // 已注入过（理论上不会走到）

    var slidersInner =
      '<line x1="4" y1="6"  x2="20" y2="6"/>' +
      '<circle cx="9"  cy="6"  r="1.6" fill="currentColor"/>' +
      '<line x1="4" y1="12" x2="20" y2="12"/>' +
      '<circle cx="15" cy="12" r="1.6" fill="currentColor"/>' +
      '<line x1="4" y1="18" x2="20" y2="18"/>' +
      '<circle cx="11" cy="18" r="1.6" fill="currentColor"/>'
    var chartInner = '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'
    var folderInner = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
    var powerInner = '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'
    var refreshInner = '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'

    var slidersSvg = icon(slidersInner)
    var chartSvg = icon(chartInner)
    var folderSvg = icon(folderInner)
    var powerSvg = icon(powerInner)
    var refreshSvg = icon(refreshInner)

    var btn = document.createElement('button')
    btn.id = 'dsdesk-settings-btn'
    btn.className = 'dsdesk-settings-btn'
    btn.type = 'button'
    btn.setAttribute('aria-label', '设置（可拖动）')
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.innerHTML = slidersSvg
    rootHolder.btn = btn

    var menu = document.createElement('div')
    menu.id = 'dsdesk-settings-menu'
    menu.className = 'dsdesk-settings-menu'
    menu.setAttribute('role', 'menu')
    rootHolder.menu = menu

    function closeMenu() {
      menu.classList.remove('open')
      btn.setAttribute('aria-expanded', 'false')
    }
    function item(label, svg, onClick) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'dsdesk-settings-item'
      b.setAttribute('role', 'menuitem')
      b.innerHTML = svg + '<span>' + label + '</span>'
      b.addEventListener('click', onClick)
      return b
    }
    function sep() {
      var d = document.createElement('div')
      d.className = 'dsdesk-settings-sep'
      d.setAttribute('role', 'separator')
      return d
    }

    function dshSettings() {
      closeMenu()
      var trigger = findDshTrigger()
      if (trigger) { trigger.click(); return }
      toast('未找到 dsh 设置入口，请从侧边栏打开', true)
    }

    menu.appendChild(item('打开设置', slidersSvg, dshSettings))
    menu.appendChild(item('API 用量', chartSvg, function () { fire(window.desktop.openUsage(), '打开用量窗口'); closeMenu() }))
    menu.appendChild(sep())
    menu.appendChild(item('打开会话目录', folderSvg, function () { fire(window.desktop.openDir('session'), '打开目录'); closeMenu() }))
    menu.appendChild(item('打开 Skills 目录', folderSvg, function () { fire(window.desktop.openDir('skills'), '打开目录'); closeMenu() }))
    menu.appendChild(item('打开 Agent 预设目录', folderSvg, function () { fire(window.desktop.openDir('agents'), '打开目录'); closeMenu() }))
    menu.appendChild(item('打开插件目录', folderSvg, function () { fire(window.desktop.openDir('plugins'), '打开目录'); closeMenu() }))
    menu.appendChild(sep())
    menu.appendChild(item('检查更新', refreshSvg, function () { closeMenu(); checkUpdateFlow() }))
    menu.appendChild(sep())
    menu.appendChild(item('退出', powerSvg, function () { fire(window.desktop.quit(), '退出') }))

    /* ---------------- 检查更新覆盖层（回退模式专用） ---------------- */

    function updOverlay() {
      var old = document.getElementById('dsdesk-upd-overlay')
      if (old) old.remove()
      var mask = document.createElement('div')
      mask.id = 'dsdesk-upd-overlay'
      mask.className = 'dsdesk-upd-mask'
      mask.setAttribute('data-busy', '0')
      // 非更新进行中时点击遮罩空白处可关闭
      mask.addEventListener('click', function (e) {
        if (e.target === mask && mask.getAttribute('data-busy') !== '1') mask.remove()
      })
      var panel = document.createElement('div')
      panel.className = 'dsdesk-upd'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-labelledby', 'dsdesk-upd-title')
      var head = document.createElement('div')
      head.className = 'dsdesk-upd-title'
      head.id = 'dsdesk-upd-title'
      var body = document.createElement('div')
      body.className = 'dsdesk-upd-body'
      body.id = 'dsdesk-upd-body'
      panel.appendChild(head)
      panel.appendChild(body)
      mask.appendChild(panel)
      document.body.appendChild(mask)
      return { mask, panel, head, body }
    }
    function updClose(mask) { if (mask) mask.remove() }
    function updBtn(label, primary, onClick) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'dsdesk-upd-btn' + (primary ? ' dsdesk-upd-btn-primary' : '')
      b.textContent = label
      b.addEventListener('click', onClick)
      return b
    }

    function checkUpdateFlow() {
      var ov = updOverlay()
      ov.head.textContent = '检查更新'
      ov.body.innerHTML = '<div class="dsdesk-upd-status">正在检查 DeepSeek Harness 上游更新…</div>'
      window.desktop.checkUpdate().then(function (a) {
        if (!a || !a.ok) {
          ov.body.innerHTML = '<div class="dsdesk-upd-status dsdesk-upd-err">检查更新失败：' + escapeHtml((a && a.error) || '无法连接 GitHub') + '</div>'
          ov.body.appendChild(updBtn('关闭', false, function () { updClose(ov.mask) }))
          return
        }
        if (!a.updateAvailable) {
          ov.body.innerHTML = '<div class="dsdesk-upd-status">已是最新版本（' + escapeHtml(a.localVersion) + '）</div>'
          ov.body.appendChild(updBtn('关闭', false, function () { updClose(ov.mask) }))
          return
        }
        var r = a.remote
        ov.body.innerHTML =
          '<div class="dsdesk-upd-new">发现新版本</div>' +
          '<div class="dsdesk-upd-line">本地 <b>' + escapeHtml(a.localVersion) + '</b> → 最新 <b>' + escapeHtml(r.version) + '</b></div>' +
          '<div class="dsdesk-upd-sub">' + escapeHtml(r.date || '') + '</div>' +
          '<div class="dsdesk-upd-msg">' + escapeHtml(r.message || '') + '</div>' +
          (a.dirty
            ? '<div class="dsdesk-upd-warn">注意：本地 harness 有未提交改动，更新会覆盖这些改动。</div>'
            : '') +
          '<div class="dsdesk-upd-warn">更新将拉取最新源码、替换本地引擎并重新构建，全程不可中断，构建约需数分钟。</div>'
        var btnRow = document.createElement('div')
        btnRow.className = 'dsdesk-upd-row'
        btnRow.appendChild(updBtn('取消', false, function () { updClose(ov.mask) }))
        btnRow.appendChild(updBtn('立即更新', true, function () { runUpdateFlow(ov) }))
        ov.body.appendChild(btnRow)
      }).catch(function (e) {
        ov.body.innerHTML = '<div class="dsdesk-upd-status dsdesk-upd-err">检查更新失败：' + escapeHtml(e.message) + '</div>'
        ov.body.appendChild(updBtn('关闭', false, function () { updClose(ov.mask) }))
      })
    }

    function runUpdateFlow(ov) {
      ov.mask.setAttribute('data-busy', '1') // 更新进行中：禁止 Escape / 点击遮罩关闭
      ov.head.textContent = '更新中'
      ov.body.innerHTML =
        '<div class="dsdesk-upd-status" id="dsdesk-upd-status">准备更新…</div>' +
        '<div class="dsdesk-upd-bar"><i></i></div>' +
        '<div class="dsdesk-upd-note">更新期间请勿关闭应用。完成后会自动重启引擎。</div>'
      var statusEl = document.getElementById('dsdesk-upd-status')
      var unsub = window.desktop.onUpdateStatus(function (payload) {
        if (typeof payload === 'string') {
          if (payload.indexOf('step:') === 0) {
            var phase = payload.replace('step:', '')
            var label = {
              begin: '准备更新…', download: '从 GitHub 下载源码…', extract: '解压源码…',
              backup: '备份旧版本…', replace: '替换本地源码…', git: '登记源码版本信息…',
              install: '安装依赖（pnpm install）…', build: '构建（pnpm run build）…',
              done: '更新完成！', fail: '更新失败',
            }[phase] || '处理中…'
            if (statusEl) statusEl.textContent = label
          } else if (statusEl) {
            statusEl.textContent = payload // 下载百分比等中间进度
          }
        } else if (payload && payload.message && statusEl) {
          statusEl.textContent = payload.message
          if (payload.step === 'fail') ov.body.classList.add('dsdesk-upd-fail')
        }
      })
      window.desktop.applyUpdate().then(function (r) {
        if (unsub) unsub()
        if (r && r.ok) {
          if (statusEl) statusEl.textContent = '更新完成：' + (r.version || '') + '，正在重启引擎…'
          // 主进程会自动载入新 UI，这里等待片刻后关闭覆盖层
          setTimeout(function () { updClose(ov.mask) }, 1500)
        } else {
          ov.mask.setAttribute('data-busy', '0')
          ov.body.classList.add('dsdesk-upd-fail')
          if (statusEl) statusEl.textContent = '更新失败：' + ((r && r.error) || '未知错误')
          var row = document.createElement('div')
          row.className = 'dsdesk-upd-row'
          row.appendChild(updBtn('重试', false, function () { updClose(ov.mask); checkUpdateFlow() }))
          row.appendChild(updBtn('关闭', false, function () { updClose(ov.mask) }))
          ov.body.appendChild(row)
        }
      }).catch(function (e) {
        if (unsub) unsub()
        ov.mask.setAttribute('data-busy', '0')
        ov.body.classList.add('dsdesk-upd-fail')
        if (statusEl) statusEl.textContent = '更新失败：' + e.message
        var row = document.createElement('div')
        row.className = 'dsdesk-upd-row'
        row.appendChild(updBtn('关闭', false, function () { updClose(ov.mask) }))
        ov.body.appendChild(row)
      })
    }

    var root = document.createElement('div')
    root.id = 'dsdesk-settings-root'
    root.appendChild(btn)
    root.appendChild(menu)
    document.body.appendChild(root)
    rootHolder.root = root

    /* ---------------- 位置持久化 ---------------- */

    function viewport() {
      return { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }
    }
    function clamp(pos, btnW, btnH, w, h) {
      return {
        left: Math.min(Math.max(PAD, pos.left), w - btnW - PAD),
        top: Math.min(Math.max(PAD, pos.top), h - btnH - PAD),
      }
    }
    function defaultPos(btnW, btnH, w, h) {
      // 默认：左下角，dsh 内置设置按钮（侧边栏底部）的右侧一点、垂直对齐；
      // 内置按钮找不到时兜底到窗口左下角。
      var trigger = findDshTrigger()
      if (trigger) {
        var r = trigger.getBoundingClientRect()
        return clamp({ left: r.right + 12, top: r.top + (r.height - btnH) / 2 }, btnW, btnH, w, h)
      }
      return clamp({ left: 16, top: h - btnH - 16 }, btnW, btnH, w, h)
    }
    function loadPos(btnW, btnH) {
      var vp = viewport()
      try {
        var raw = localStorage.getItem(POS_KEY)
        if (raw) {
          var p = JSON.parse(raw)
          if (typeof p.left === 'number' && typeof p.top === 'number') {
            return clamp(p, btnW, btnH, vp.w, vp.h)
          }
        }
      } catch (e) { /* 忽略损坏的存储 */ }
      return defaultPos(btnW, btnH, vp.w, vp.h)
    }
    function savePos(pos) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch (e) { /* 私有模式可能抛错 */ }
    }
    function applyPos(pos) {
      btn.style.left = pos.left + 'px'
      btn.style.top = pos.top + 'px'
    }

    /* ---------------- 菜单位置（自适应） ---------------- */

    function positionMenu() {
      var vp = viewport()
      var btnRect = btn.getBoundingClientRect()
      var menuRect = menu.getBoundingClientRect()
      var GAP = 10
      var margin = 6

      // 默认：在按钮下方，左对齐按钮左
      var top = btnRect.bottom + GAP
      var left = btnRect.left

      // 下方空间不够 → 翻到按钮上方
      if (top + menuRect.height > vp.h - margin) {
        top = btnRect.top - menuRect.height - GAP
      }
      // 左侧空间不够 → 右对齐按钮右
      if (left + menuRect.width > vp.w - margin) {
        left = btnRect.right - menuRect.width
      }
      // 再 clamp
      left = Math.min(Math.max(margin, left), vp.w - menuRect.width - margin)
      top = Math.min(Math.max(margin, top), vp.h - menuRect.height - margin)

      menu.style.left = left + 'px'
      menu.style.top = top + 'px'
    }

    /* ---------------- 拖动 ---------------- */

    function bindDrag(el) {
      var DRAG_THRESHOLD = 5
      var startX = 0, startY = 0
      var origLeft = 0, origTop = 0
      var btnW = el.offsetWidth, btnH = el.offsetHeight
      var dragging = false
      var pointerId = null

      function onDown(e) {
        if (e.button !== undefined && e.button !== 0) return // 只响应左键
        pointerId = e.pointerId
        startX = e.clientX
        startY = e.clientY
        origLeft = parseFloat(el.style.left) || 0
        origTop = parseFloat(el.style.top) || 0
        el.setPointerCapture(pointerId)
        // 不立即进入 dragging，等超过阈值
        el._maybeDrag = true
      }
      function onMove(e) {
        if (!el._maybeDrag || e.pointerId !== pointerId) return
        var dx = e.clientX - startX
        var dy = e.clientY - startY
        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          dragging = true
          // 进入拖动态：收起菜单、加样式
          closeMenu()
          el.classList.add('dragging')
          document.body.classList.add('dsdesk-grabbing')
        }
        var vp = viewport()
        var pos = clamp({ left: origLeft + dx, top: origTop + dy }, btnW, btnH, vp.w, vp.h)
        applyPos(pos)
      }
      function onUp(e) {
        if (e.pointerId !== pointerId) return
        el._maybeDrag = false
        if (dragging) {
          var vp = viewport()
          var pos = clamp({
            left: parseFloat(el.style.left) || 0,
            top: parseFloat(el.style.top) || 0,
          }, btnW, btnH, vp.w, vp.h)
          applyPos(pos)
          savePos(pos)
          suppressClick = true  // 本次拖动产生的 click 不再触发展开
        }
        dragging = false
        pointerId = null
        el.classList.remove('dragging')
        document.body.classList.remove('dsdesk-grabbing')
        try { el.releasePointerCapture(e.pointerId) } catch (e2) { /* 已释放 */ }
      }

      el.addEventListener('pointerdown', onDown)
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onUp)
    }

    /* ---------------- 初始化 ---------------- */

    // 默认位置或上次保存位置
    applyPos(loadPos(btn.offsetWidth || 48, btn.offsetHeight || 48))

    // 视口变化时只重新 clamp（窗口缩放/全屏切换）；
    // 不在此处保存位置——临时缩小窗口不应永久改写用户保存的坐标。
    window.addEventListener('resize', function () {
      var vp = viewport()
      var pos = clamp({
        left: parseFloat(btn.style.left) || 0,
        top: parseFloat(btn.style.top) || 0,
      }, btn.offsetWidth, btn.offsetHeight, vp.w, vp.h)
      applyPos(pos)
      if (menu.classList.contains('open')) positionMenu()
    })

    // 菜单展开时计算位置、关闭时还原 transform origin
    var observer = new MutationObserver(function () {
      if (menu.classList.contains('open')) positionMenu()
    })
    observer.observe(menu, { attributes: true, attributeFilter: ['class'] })

    // 拖动（绑定在 capture，避免和菜单展开冲突）
    bindDrag(btn)

    // 点击展开/收起：拖动后抑制一次 click（见 onUp 的 suppressClick）
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (suppressClick) { suppressClick = false; return }
      var open = menu.classList.toggle('open')
      btn.setAttribute('aria-expanded', String(open))
    })

    // 菜单键盘导航：方向键移动、Escape 返回按钮焦点
    menu.addEventListener('keydown', function (e) {
      var items = menu.querySelectorAll('.dsdesk-settings-item')
      if (!items.length) return
      var idx = Array.prototype.indexOf.call(items, document.activeElement)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[(idx + 1 + items.length) % items.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[(idx - 1 + items.length) % items.length].focus()
      }
    })

    // 全局点击关闭菜单
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) closeMenu()
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeMenu()
        // 更新覆盖层：非更新进行中可 Escape 关闭
        var mask = document.getElementById('dsdesk-upd-overlay')
        if (mask && mask.getAttribute('data-busy') !== '1') mask.remove()
        if (menu.classList.contains('open') || document.activeElement === btn) btn.focus()
      }
    })

    // 应用菜单命令（桥模式下由插件接管；悬浮回退模式由这里兜底）
    if (window.desktop && typeof window.desktop.onMenuCommand === 'function') {
      window.desktop.onMenuCommand(function (command) {
        if (command === 'check-update') checkUpdateFlow()
      })
    }
  }

  /* ---------------- 模式判定 ----------------
   * 桥插件在页面引导阶段注册（window.__dshDesktopBridge）。
   * 检测到桥 → 仅保留横幅与 toast（页面干净，原生设置分组已可用）；
   * 超时未检测到 → 注入悬浮回退 UI。 */

  ;(function decideMode() {
    if (!window.desktop) return // 桥缺失的极端场景：splash 已有兜底，这里不动作
    var waited = 0
    var timer = setInterval(function () {
      if (window.__dshDesktopBridge) {
        clearInterval(timer)
        return
      }
      waited += 140
      if (waited >= BRIDGE_WAIT_MS) {
        clearInterval(timer)
        try { startShellUi() } catch (e) {
          try { toast('桌面壳界面初始化失败：' + (e && e.message ? e.message : e), true) } catch { /* 忽略 */ }
        }
      }
    }, 140)
  })()
})()
