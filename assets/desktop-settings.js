/**
 * DeepSeek Desktop — 可拖动悬浮设置按钮注入脚本。
 * 由主进程在 dsh web UI 加载完成后 executeJavaScript 注入（主 world）。
 * 幂等：重复注入不产生重复按钮。按钮/菜单挂在 document.body（React 根 #root 之外），
 * 不会被 dsh 的 React 重渲染清除。
 *
 * 行为：
 *   - 点击（位移 < 5px）→ 展开/收起菜单。
 *   - 拖动（位移 ≥ 5px）→ 按钮跟随光标，菜单收起；视口边界 clamp；松开后停留。
 *   - 位置持久化到 localStorage，重启后保持。
 *   - 菜单显示方向按按钮在视口的位置自适应（上方/下方），避免溢出。
 */
;(function () {
  'use strict'
  if (document.getElementById('dsdesk-settings-root')) return

  var POS_KEY = 'dsdesk-settings-pos'
  var PAD = 8 // 视口边缘保留距离
  var suppressClick = false // 拖动结束后抑制一次 click，避免误开菜单

  var icon = function (inner) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
  }
  // 三条横线 + 圆点：调整条 / 偏好，明确"设置"语义，与齿轮视觉区分。
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

  var slidersSvg = icon(slidersInner)
  var chartSvg = icon(chartInner)
  var folderSvg = icon(folderInner)
  var powerSvg = icon(powerInner)

  var btn = document.createElement('button')
  btn.id = 'dsdesk-settings-btn'
  btn.className = 'dsdesk-settings-btn'
  btn.type = 'button'
  btn.setAttribute('aria-label', '设置（可拖动）')
  btn.setAttribute('aria-haspopup', 'menu')
  btn.setAttribute('aria-expanded', 'false')
  btn.innerHTML = slidersSvg

  var menu = document.createElement('div')
  menu.id = 'dsdesk-settings-menu'
  menu.className = 'dsdesk-settings-menu'
  menu.setAttribute('role', 'menu')

  function closeMenu() {
    menu.classList.remove('open')
    btn.setAttribute('aria-expanded', 'false')
  }
  function fire(promise) {
    if (promise && typeof promise.catch === 'function') promise.catch(function () {})
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
    var trigger = document.querySelector('button[aria-haspopup="dialog"]')
    if (trigger) trigger.click()
    closeMenu()
  }

  menu.appendChild(item('打开设置', slidersSvg, dshSettings))
  menu.appendChild(item('API 用量', chartSvg, function () { fire(window.desktop.openUsage()); closeMenu() }))
  menu.appendChild(sep())
  menu.appendChild(item('打开会话目录', folderSvg, function () { fire(window.desktop.openDir('session')); closeMenu() }))
  menu.appendChild(item('打开 Skills 目录', folderSvg, function () { fire(window.desktop.openDir('skills')); closeMenu() }))
  menu.appendChild(item('打开 Agent 预设目录', folderSvg, function () { fire(window.desktop.openDir('agents')); closeMenu() }))
  menu.appendChild(item('打开插件目录', folderSvg, function () { fire(window.desktop.openDir('plugins')); closeMenu() }))
  menu.appendChild(sep())
  menu.appendChild(item('退出', powerSvg, function () { fire(window.desktop.quit()) }))


  var root = document.createElement('div')
  root.id = 'dsdesk-settings-root'
  root.appendChild(btn)
  root.appendChild(menu)
  document.body.appendChild(root)

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
    var trigger = document.querySelector('button[aria-haspopup="dialog"]')
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

  // 视口变化时重新 clamp（窗口缩放/全屏切换）
  window.addEventListener('resize', function () {
    var vp = viewport()
    var pos = clamp({
      left: parseFloat(btn.style.left) || 0,
      top: parseFloat(btn.style.top) || 0,
    }, btn.offsetWidth, btn.offsetHeight, vp.w, vp.h)
    applyPos(pos)
    savePos(pos)
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

  // 全局点击关闭菜单
  document.addEventListener('click', function (e) {
    if (!root.contains(e.target)) closeMenu()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu()
  })
})()