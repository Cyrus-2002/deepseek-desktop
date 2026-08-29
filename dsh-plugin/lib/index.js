/**
 * dsh-desktop-bridge — 宿主半（Node half）。
 *
 * Loader 按包名 import 本入口以完成挂载；桌面功能的全部价值都在浏览器半
 * （lib/client.js，经 `dsh.client` 声明被扫描并服务为 /plugins/<id>/client.js）。
 * 宿主侧不注册任何服务、不产生副作用。
 */

export const name = 'dsh-desktop-bridge'

/**
 * cordis 插件挂载入口（宿主侧 no-op）。
 * @param {import('@deepseek-ai/cordis').Context} _ctx - 宿主上下文（未使用）。
 */
export function apply(_ctx) {}
