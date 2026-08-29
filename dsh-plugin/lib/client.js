/* eslint-disable */
/**
 * dsh-desktop-bridge — 浏览器半（client bundle）。
 *
 * DeepSeek Desktop 桌面壳的原生界面桥：把桌面壳的功能以 dsh 官方槽位渲染进
 * 系统 UI，替代悬浮按钮——
 *   1. `settings.section`（id: desktop, order: 25）：系统设置对话框新增「桌面」分组
 *      （API 用量 / 检查更新[内嵌进度] / 数据目录 / 退出）；
 *   2. `sidebar.footer.action`：侧边栏底部齿轮旁的原生按钮，点击直达「桌面」分组。
 *
 * 形态：官方 lazy-CJS factory 约定（banner 调用 window.__ModuleLoader__.load，
 * 外部件经注入的 require 从模块表解析——react 与 ui-primitives 是页面共享实例，
 * 因此外观与 dsh 自带 UI 完全一致）。本文件为手写产物（源即构建产物），
 * 复刻 packages/client/tsdown.client.ts 的输出契约。
 *
 * 防御约定：window.desktop 不存在（纯浏览器打开）时不注册任何 UI；
 * 注册过程任何异常只打 console，绝不影响 dsh 自身启动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** Electron preload 暴露的桌面桥（主世界可直接访问）；浏览器直开时为 null。 */
    const desktop = typeof window !== 'undefined' && window.desktop ? window.desktop : null;

    const BRIDGE_VERSION = '0.5.0';
    const LOCALE_NS = 'desktopBridge';

    /* ---------------- 文案（zh / en） ---------------- */

    const DICT = {
      zh: {
        nav: '桌面',
        sidebarLabel: '桌面',
        groupQuick: '快捷操作',
        groupDirs: '数据目录',
        groupMore: '更多',
        usage: 'API 用量',
        usageHint: '今天 / 过去 7 天 / 过去 30 天的请求与 Token 统计（独立小窗）',
        usageBtn: '打开',
        update: '检查更新',
        updateHint: '从 GitHub 拉取最新 harness 引擎源码并重建，支持多源加速下载',
        updateBtn: '检查',
        updateBtnAgain: '再次检查',
        dirSession: '会话目录',
        dirSkills: 'Skills 目录',
        dirAgents: 'Agent 预设目录',
        dirPlugins: '插件目录',
        dirLogs: '日志目录',
        dirBtn: '打开',
        quit: '退出应用',
        quitHint: '关闭窗口并停止本地引擎（Ctrl+Q 同效）',
        quitBtn: '退出',
        checking: '正在检查更新…',
        latest: '已是最新版本',
        found: '发现新版本',
        localLabel: '本地',
        newest: '最新',
        startUpdate: '立即更新',
        cancel: '取消',
        retry: '重试',
        close: '关闭',
        checkFailed: '检查更新失败',
        updating: '更新中，请勿关闭应用…',
        done: '更新完成，正在重启引擎…',
        updateFailed: '更新失败',
        dirtyWarn: '注意：本地 harness 有未提交改动，更新会覆盖这些改动。',
        stepBegin: '准备更新…',
        stepDownload: '从 GitHub 下载源码…',
        stepExtract: '解压源码…',
        stepBackup: '备份旧版本…',
        stepReplace: '替换本地源码…',
        stepGit: '登记源码版本信息…',
        stepInstall: '安装依赖（pnpm install）…',
        stepBuild: '构建（pnpm run build）…',
        stepDone: '更新完成！',
        stepFail: '更新失败',
        stepOther: '处理中…',
      },
      en: {
        nav: 'Desktop',
        sidebarLabel: 'Desktop',
        groupQuick: 'Quick actions',
        groupDirs: 'Data folders',
        groupMore: 'More',
        usage: 'API usage',
        usageHint: 'Requests and tokens for today / last 7 days / last 30 days (separate window)',
        usageBtn: 'Open',
        update: 'Check for updates',
        updateHint: 'Fetch the latest harness source from GitHub and rebuild, with multi-source download',
        updateBtn: 'Check',
        updateBtnAgain: 'Check again',
        dirSession: 'Sessions folder',
        dirSkills: 'Skills folder',
        dirAgents: 'Agent presets folder',
        dirPlugins: 'Plugins folder',
        dirLogs: 'Logs folder',
        dirBtn: 'Open',
        quit: 'Quit app',
        quitHint: 'Close the window and stop the local engine (same as Ctrl+Q)',
        quitBtn: 'Quit',
        checking: 'Checking for updates…',
        latest: 'You are up to date',
        found: 'New version available',
        localLabel: 'Local',
        newest: 'Latest',
        startUpdate: 'Update now',
        cancel: 'Cancel',
        retry: 'Retry',
        close: 'Close',
        checkFailed: 'Update check failed',
        updating: 'Updating — do not close the app…',
        done: 'Update finished, restarting the engine…',
        updateFailed: 'Update failed',
        dirtyWarn: 'Note: the local harness has uncommitted changes; updating will overwrite them.',
        stepBegin: 'Preparing update…',
        stepDownload: 'Downloading source from GitHub…',
        stepExtract: 'Extracting source…',
        stepBackup: 'Backing up old version…',
        stepReplace: 'Replacing local source…',
        stepGit: 'Recording source version…',
        stepInstall: 'Installing dependencies (pnpm install)…',
        stepBuild: 'Building (pnpm run build)…',
        stepDone: 'Update finished!',
        stepFail: 'Update failed',
        stepOther: 'Working…',
      },
    };

    /* ---------------- 样式（官方 style 注入模式；明暗通用） ---------------- */

    const CSS = [
      '.dsb-section { max-width: 580px; }',
      '.dsb-group { margin: 0 0 26px; }',
      '.dsb-group-title { font-size: 12px; letter-spacing: .4px; opacity: .55; margin: 0 0 10px; text-transform: uppercase; }',
      '.dsb-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,.12); }',
      '.dsb-row:last-child { border-bottom: none; }',
      '.dsb-row-label { font-size: 13.5px; }',
      '.dsb-hint { font-size: 12px; opacity: .55; margin-top: 3px; line-height: 1.5; }',
      '.dsb-panel { margin: 12px 0 2px; padding: 12px 14px; border-radius: 10px; background: rgba(127,127,127,.08); font-size: 12.5px; line-height: 1.6; }',
      '.dsb-panel-err { color: #e56363; }',
      '.dsb-panel-warn { color: #c98a2b; margin-top: 6px; }',
      '.dsb-panel-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }',
      '.dsb-status { font-variant-numeric: tabular-nums; word-break: break-all; }',
      '.dsb-side-btn { display: flex; align-items: center; gap: 9px; width: 100%; border: none; background: transparent; color: inherit; cursor: pointer; border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; justify-content: flex-start; }',
      '.dsb-side-btn:hover { background: rgba(127,127,127,.14); }',
      '.dsb-side-btn-rail { justify-content: center; padding: 8px 0; }',
      '.dsb-icon { display: inline-flex; flex: 0 0 auto; }',
      '.dsb-icon svg { display: block; }',
      'body[data-ds-dark-theme] .dsb-panel { background: rgba(127,127,127,.14); }',
    ].join('\n');

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-desktop-bridge/client.js"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-desktop-bridge';
      tag.dataset.pluginCss = 'dsh-desktop-bridge/client.js';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------- 小工具 ---------------- */

    /** 菜单命令信号：应用菜单「检查更新」→ 打开本分组并自动开始检查。 */
    const signals = { check: 0 };
    const checkListeners = new Set();
    function fireCheckSignal() {
      for (const fn of Array.from(checkListeners)) {
        try { fn(); } catch { /* 监听者异常不扩散 */ }
      }
    }

    /** 打开系统设置对话框并定位到「桌面」分组；定位失败退化为直接开用量窗口。 */
    function openDesktopSection() {
      if (!desktop) return;
      const trigger = document.querySelector('button[aria-haspopup="dialog"]');
      if (!trigger) {
        if (typeof desktop.openUsage === 'function') desktop.openUsage();
        return;
      }
      trigger.click();
      setTimeout(() => {
        try {
          const rows = document.querySelectorAll('[role="dialog"] nav button');
          for (const row of rows) {
            const text = (row.textContent || '').trim();
            if (text.indexOf('桌面') !== -1 || text.indexOf('Desktop') !== -1) {
              row.click();
              return;
            }
          }
        } catch { /* 停在默认分组也不影响功能 */ }
      }, 140);
    }

    /** 行：左侧标题+说明，右侧动作按钮（ui-primitives Button，原生外观）。 */
    function Row(props) {
      const { label, hint, buttonText, onClick, disabled, primary } = props;
      return h('div', { className: 'dsb-row' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'dsb-row-label' }, label),
          hint ? h('div', { className: 'dsb-hint' }, hint) : null,
        ),
        h(Button, {
          variant: primary ? 'primary' : 'outline',
          size: 'sm',
          onClick,
          disabled: !!disabled,
        }, buttonText),
      );
    }

    /* ---------------- 「桌面」设置分组 ---------------- */

    const STEP_KEY = {
      begin: 'stepBegin', download: 'stepDownload', extract: 'stepExtract', backup: 'stepBackup',
      replace: 'stepReplace', git: 'stepGit', install: 'stepInstall', build: 'stepBuild',
      done: 'stepDone', fail: 'stepFail',
    };

    function DesktopSection(props) {
      const { t } = props;
      // phase: idle | checking | confirm | latest | failed | updating | done
      const [phase, setPhase] = React.useState('idle');
      const [info, setInfo] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const [err, setErr] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const unsubRef = React.useRef(null);
      const startCheckRef = React.useRef(function noop() {});

      React.useEffect(() => () => {
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      }, []);

      // 应用菜单「检查更新」联动：自动开始一次检查
      React.useEffect(() => {
        if (!desktop || typeof desktop.onMenuCommand !== 'function') return;
        const listener = () => { startCheckRef.current(); };
        checkListeners.add(listener);
        return () => { checkListeners.delete(listener); };
      }, []);

      async function startCheck() {
        if (busy) return;
        setErr(''); setInfo(null); setPhase('checking');
        try {
          const a = await desktop.checkUpdate();
          if (!a || !a.ok) {
            setErr((a && a.error) || '无法连接 GitHub');
            setPhase('failed');
            return;
          }
          if (!a.updateAvailable) {
            setPhase('latest');
            return;
          }
          setInfo(a);
          setPhase('confirm');
        } catch (e) {
          setErr(String((e && e.message) || e));
          setPhase('failed');
        }
      }
      startCheckRef.current = startCheck;

      function startUpdate() {
        if (!info) return;
        setPhase('updating');
        setBusy(true);
        setStatus(t('updating'));
        if (unsubRef.current) unsubRef.current();
        unsubRef.current = desktop.onUpdateStatus((payload) => {
          if (typeof payload === 'string') {
            if (payload.indexOf('step:') === 0) {
              const key = STEP_KEY[payload.slice(5)];
              setStatus(key ? t(key) : t('stepOther'));
            } else {
              setStatus(payload); // 下载百分比等中间进度
            }
          } else if (payload && payload.message) {
            setStatus(payload.message);
          }
        });
        desktop.applyUpdate().then((r) => {
          if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
          setBusy(false);
          if (r && r.ok) {
            setPhase('done');
            setStatus(t('done') + (r.version ? ' ' + r.version : ''));
          } else {
            setErr((r && r.error) || '未知错误');
            setPhase('failed');
          }
        }).catch((e) => {
          if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
          setBusy(false);
          setErr(String((e && e.message) || e));
          setPhase('failed');
        });
      }

      function renderUpdatePanel() {
        if (phase === 'checking') {
          return h('div', { className: 'dsb-panel' },
            h('div', { className: 'dsb-status' }, t('checking')));
        }
        if (phase === 'latest') {
          return h('div', { className: 'dsb-panel' },
            h('div', null, t('latest')),
            h('div', { className: 'dsb-panel-row' },
              h(Button, { size: 'sm', variant: 'outline', onClick: () => setPhase('idle') }, t('close'))));
        }
        if (phase === 'confirm' && info && info.remote) {
          return h('div', { className: 'dsb-panel' },
            h('div', null, t('found') + '：' + (info.localVersion || '') + ' → ' + (info.remote.version || '')),
            info.remote.date ? h('div', { className: 'dsb-hint' }, String(info.remote.date)) : null,
            info.remote.message ? h('div', { className: 'dsb-hint' }, String(info.remote.message).split('\n')[0]) : null,
            info.dirty ? h('div', { className: 'dsb-panel-warn' }, t('dirtyWarn')) : null,
            h('div', { className: 'dsb-panel-row' },
              h(Button, { size: 'sm', variant: 'outline', onClick: () => setPhase('idle') }, t('cancel')),
              h(Button, { size: 'sm', variant: 'primary', onClick: startUpdate }, t('startUpdate'))));
        }
        if (phase === 'updating') {
          return h('div', { className: 'dsb-panel' },
            h('div', { className: 'dsb-status' }, status || t('updating')));
        }
        if (phase === 'done') {
          return h('div', { className: 'dsb-panel' },
            h('div', { className: 'dsb-status' }, status || t('done')));
        }
        if (phase === 'failed') {
          return h('div', { className: 'dsb-panel dsb-panel-err' },
            h('div', null, t('updateFailed') + (err ? '：' + err : '')),
            h('div', { className: 'dsb-panel-row' },
              h(Button, { size: 'sm', variant: 'outline', onClick: startCheck }, t('retry')),
              h(Button, { size: 'sm', variant: 'outline', onClick: () => setPhase('idle') }, t('close'))));
        }
        return null;
      }

      return h('div', { className: 'dsb-section' },
        h('div', { className: 'dsb-group' },
          h('div', { className: 'dsb-group-title' }, t('groupQuick')),
          h(Row, {
            label: t('usage'),
            hint: t('usageHint'),
            buttonText: t('usageBtn'),
            onClick: () => { if (desktop.openUsage) desktop.openUsage(); },
          }),
          h(Row, {
            label: t('update'),
            hint: t('updateHint'),
            buttonText: phase === 'idle' ? t('updateBtn') : t('updateBtnAgain'),
            onClick: startCheck,
            disabled: busy,
            primary: phase === 'idle',
          }),
          renderUpdatePanel(),
        ),
        h('div', { className: 'dsb-group' },
          h('div', { className: 'dsb-group-title' }, t('groupDirs')),
          ['session', 'skills', 'agents', 'plugins', 'logs'].map((name) => {
            const labels = {
              session: 'dirSession', skills: 'dirSkills', agents: 'dirAgents',
              plugins: 'dirPlugins', logs: 'dirLogs',
            };
            return h(Row, {
              key: name,
              label: t(labels[name]),
              buttonText: t('dirBtn'),
              onClick: () => { if (desktop.openDir) desktop.openDir(name); },
            });
          }),
        ),
        h('div', { className: 'dsb-group' },
          h('div', { className: 'dsb-group-title' }, t('groupMore')),
          h(Row, {
            label: t('quit'),
            hint: t('quitHint'),
            buttonText: t('quitBtn'),
            onClick: () => { if (desktop.quit) desktop.quit(); },
          }),
        ),
      );
    }

    /* ---------------- 侧边栏底部按钮（齿轮旁官方槽位） ---------------- */

    const ICON_SLIDERS =
      h('span', { className: 'dsb-icon', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('line', { x1: 4, y1: 6, x2: 20, y2: 6 }),
          h('circle', { cx: 9, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none' }),
          h('line', { x1: 4, y1: 12, x2: 20, y2: 12 }),
          h('circle', { cx: 15, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }),
          h('line', { x1: 4, y1: 18, x2: 20, y2: 18 }),
          h('circle', { cx: 11, cy: 18, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        ));

    function SidebarButton(props) {
      const { wide, t } = props;
      const onClick = () => {
        if (!desktop) return;
        // 让「检查更新」从菜单/按钮进入时自动开始检查
        signals.check += 1;
        fireCheckSignal();
        openDesktopSection();
      };
      return h('button', {
        type: 'button',
        className: 'dsb-side-btn' + (wide ? '' : ' dsb-side-btn-rail'),
        'aria-label': t('sidebarLabel'),
        title: t('sidebarLabel'),
        onClick,
      }, ICON_SLIDERS, wide ? h('span', null, t('sidebarLabel')) : null);
    }

    /* ---------------- 注册 ---------------- */

    /** Required services (cordis fiber inject). */
    exports.inject = ['slots', 'locale'];

    /**
     * 浏览器挂载入口。
     * @param {object} ctx - 浏览器插件上下文（slots / locale 服务）。
     */
    exports.apply = function apply(ctx) {
      if (!desktop) return; // 纯浏览器打开：桌面桥无意义，不注册任何 UI

      // 桥就绪标记：桌面壳注入层据此进入「仅横幅」模式（悬浮按钮不出现）
      try { window.__dshDesktopBridge = { version: BRIDGE_VERSION }; } catch { /* 忽略 */ }

      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICT), 'dsh-desktop-bridge: dictionaries');
      } catch (error) {
        console.error('[dsh-desktop-bridge] locale 注册失败:', error);
      }

      try {
        // 系统设置对话框新增「桌面」分组（数据驱动账本，order 25 排在 Agent 预设之后）
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'desktop',
          order: 25,
          label: () => ctx.locale.bind(LOCALE_NS)('nav'),
          locale: LOCALE_NS,
          inject: () => ({}),
        }, DesktopSection));
      } catch (error) {
        console.error('[dsh-desktop-bridge] settings.section 注册失败:', error);
      }

      try {
        // 侧边栏底部齿轮旁的官方加法槽位
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'desktop-open',
          locale: LOCALE_NS,
          inject: () => ({}),
        }, SidebarButton));
      } catch (error) {
        console.error('[dsh-desktop-bridge] sidebar.footer.action 注册失败:', error);
      }

      try {
        // 应用菜单命令由插件接管（悬浮回退模式不存在时）
        if (typeof desktop.onMenuCommand === 'function') {
          desktop.onMenuCommand((command) => {
            if (command === 'check-update') {
              signals.check += 1;
              fireCheckSignal();
              openDesktopSection();
            }
          });
        }
      } catch (error) {
        console.error('[dsh-desktop-bridge] 菜单命令订阅失败:', error);
      }
    };

    return module.exports;
  },
});
