/**
 * DeepSeek Desktop — preload 脚本。
 * 仅向启动页暴露最小 IPC 面：应用信息、引擎状态、错误/重试、就绪事件。
 * 主 UI（dsh web 前端）不依赖本桥，保持零改动。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** 引擎就绪事件（启动页据此淡出并切换）。 */
  onReady: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:ready', listener)
    return () => ipcRenderer.removeListener('desktop:ready', listener)
  },
  /** 订阅引擎退出事件。 */
  onEngineExited: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:engine-exited', listener)
    return () => ipcRenderer.removeListener('desktop:engine-exited', listener)
  },
  /** 订阅错误事件（引擎启动失败、页面加载失败）。 */
  onError: (callback) => {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('desktop:error', listener)
    return () => ipcRenderer.removeListener('desktop:error', listener)
  },
  /** 订阅"显示重试"事件。 */
  onShowRetry: (callback) => {
    const listener = (_event) => callback()
    ipcRenderer.on('desktop:show-retry', listener)
    return () => ipcRenderer.removeListener('desktop:show-retry', listener)
  },
  /** 重启引擎并重新加载。 */
  restart: () => ipcRenderer.invoke('desktop:restart'),
  /** 读取 API 用量聚合（今天 / 过去七天 / 过去一个月）。 */
  usage: () => ipcRenderer.invoke('desktop:usage'),
  /** 检查 DeepSeek Harness 上游是否有更新。 */
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  /** 应用更新（拉源码、替换、重装依赖并重建）。返回 {ok, version?, error?}。 */
  applyUpdate: () => ipcRenderer.invoke('desktop:apply-update'),
  /** 订阅更新进度（main 推送 'desktop:update-status'，参数为说明字符串）。 */
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:update-status', listener)
    return () => ipcRenderer.removeListener('desktop:update-status', listener)
  },
  /** 订阅应用菜单命令（如 'check-update'，转发给注入层覆盖层处理）。 */
  onMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('desktop:menu-command', listener)
    return () => ipcRenderer.removeListener('desktop:menu-command', listener)
  },
  /** 打开 API 用量窗口。 */
  openUsage: () => ipcRenderer.invoke('desktop:open-usage'),
  /** 在资源管理器中打开指定数据目录（session / skills / agents / plugins / logs）。 */
  openDir: (name) => ipcRenderer.invoke('desktop:open-dir', name),
  /** 退出应用。 */
  quit: () => ipcRenderer.invoke('desktop:quit'),
})
