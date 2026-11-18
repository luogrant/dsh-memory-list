/**
 * 记忆识海 · DSH 插件（宿主半边）
 *
 * 干两件事：
 *   1. 把原来那个独立服务（app.mjs，端口 8080）整条搬到 DSH 的 webServer 下，
 *      统一走 `/dsh-memory-list` 前缀 —— 不再自己占端口，跟着 DSH 一起起停；
 *   2. 数据默认落 `$DSH_HOME/memory-list/`（本机用 junction 指到 E:/dsh-data/memory-list），
 *      第一次启动自动按随包骨架 data/识海.json 初始化，不会因为缺文件就崩。
 *
 * 独立跑法仍然保留：`node app.mjs` 听 8080，和以前一模一样。
 */
import fs from 'node:fs'
import { 处理, 确保库, 起自动任务, DATA_FILE, 数据根 } from './app.mjs'

export const name = 'memory-list'
export const inject = ['webServer']
export const PREFIX = '/dsh-memory-list'

// 插件自己的日志：装没装上看这一行就够了
function 记一笔(行) {
  try {
    const 目 = process.env.SHIRAM_HOME || (process.env.DSH_HOME || (process.env.USERPROFILE || '.') + '/.dsh') + '/memory-list'
    fs.mkdirSync(目, { recursive: true })
    fs.appendFileSync(目 + '/plugin.log', '[' + new Date().toISOString() + '] ' + 行 + '\n')
  } catch {}
}

function 回文本(res, 码, 文本) {
  try {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(码, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(文本)
  } catch {}
}

export function apply(ctx, 配置 = {}) {
  try {
    const 记 = require === undefined ? null : null
  } catch {}
  try { 记一笔('apply 被调用（v0.1.0）'); } catch {}
  const 前缀 = String((配置 && 配置.prefix) || PREFIX).replace(/\/+$/, '') || PREFIX
  const 连接 = typeof ctx.get === 'function' ? ctx.get('connection') : undefined

  // 自动汲取 / 自动整理：每个 DSH 进程一份，插件卸载时清掉
  let 停表 = null
  try {
    停表 = 起自动任务()
  } catch (e) {
    try { console.error('[memory-list] 自动任务挂不上：' + String((e && e.message) || e)) } catch {}
  }
  ctx.effect(() => () => {
    try { if (typeof 停表 === 'function') 停表() } catch {}
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: 前缀,
      handler: async (req, res) => {
        // 和别的 DSH 插件一致：先让宿主做一次鉴权
        const 拒 = 连接 && typeof 连接.requestRejection === 'function' ? 连接.requestRejection(req) : undefined
        if (拒 !== undefined && 拒 !== null && 拒 !== 0 && 拒 !== false) {
          回文本(res, Number(拒) || 403, Number(拒) === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const 原 = req.url || '/'
        const 问 = 原.indexOf('?')
        let 径 = 问 >= 0 ? 原.slice(0, 问) : 原
        const 查 = 问 >= 0 ? 原.slice(问) : ''
        try { 径 = decodeURIComponent(径) } catch {}
        // 剥掉前缀：app.mjs 里看到的还是 /api/rev、/orbit、/ 这一套
        if (径 === 前缀 || 径 === 前缀 + '/') 径 = '/'
        else if (径.indexOf(前缀 + '/') === 0) 径 = 径.slice(前缀.length)
        else { 回文本(res, 404, 'not found'); return }
        if (!径) 径 = '/'
        req.url = 径 + 查
        try {
          确保库()
        } catch (e) {
          const 信息 = String((e && e.message) || e)
          回文本(res, 500, '记忆识海起不来：' + 信息 + '　数据目录：' + 数据根 + '　数据文件：' + DATA_FILE)
          return
        }
        return 处理(req, res)
      },
    }),
  )
}