/**
 * lib/duty-clean.mjs —— 运行时文件的清理/轮转（纯函数，便于测试）
 * ============================================================================
 * 插件会长期挂着跑，两类东西会长大：
 *   1) live.log：每次心跳/任务都 append，一天几百行，几个月就上 MB —— 按大小轮转；
 *   2) config.plans：一次性计划执行完（fired/missed）后不会自己消失 —— 定期裁剪，
 *      保留最近 keepDays 天的历史，总条数不超过 cap。
 *
 * 这里只做纯文件/数组操作，不依赖插件上下文，方便 scripts/test-clean.mjs 覆盖。
 * ============================================================================
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/** live.log 超过这个大小就轮转（默认 512KB） */
export const LOG_MAX_BYTES = 512 * 1024
/** 轮转后保留最后多少行（默认 400 行） */
export const LOG_KEEP_LINES = 400

/**
 * 日志超过 maxBytes 就截断成「最后 keepLines 行」，用 tmp + rename 原子替换。
 * @param {string} file 日志路径
 * @param {{maxBytes?:number, keepLines?:number}} opts
 * @returns {{rotated:boolean, before?:number, after?:number, keptLines?:number, reason?:string}}
 */
export function rotateLogIfNeeded(file, { maxBytes = LOG_MAX_BYTES, keepLines = LOG_KEEP_LINES } = {}) {
  let st = null
  try { st = statSync(file) } catch { return { rotated: false, reason: 'missing' } }
  if (!st.isFile() || st.size <= maxBytes) return { rotated: false, reason: 'small' }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { rotated: false, reason: 'read-failed' } }
  const lines = text.split('\n').filter((x) => x.trim() !== '')
  const tail = lines.slice(-Math.max(1, keepLines))
  const out = tail.length ? `${tail.join('\n')}\n` : ''
  const tmp = `${file}.rotate.tmp`
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    return { rotated: false, reason: 'write-failed' }
  }
  return { rotated: true, before: st.size, after: Buffer.byteLength(out), keptLines: tail.length }
}

/**
 * 裁剪计划数组：
 *   - pending 全部保留；
 *   - 非 pending（fired/missed）只保留最近 keepDays 天内（按计划时间 at）；
 *   - 总条数超过 cap 时，先丢最旧的非 pending，再兜底保留最近的 cap 条。
 * @param {Array} plans 计划数组
 * @param {number} now 当前时间戳
 * @param {{keepDays?:number, cap?:number}} opts
 * @returns {{plans:Array, removed:number}}
 */
export function prunePlans(plans, now = Date.now(), { keepDays = 7, cap = 60 } = {}) {
  const list = Array.isArray(plans) ? plans.filter((p) => p && typeof p === 'object') : []
  const cutoff = Number(now) - Math.max(1, keepDays) * 86400 * 1000
  let kept = list.filter((p) => {
    const status = String(p.status || 'pending')
    if (status === 'pending') return true
    const at = Date.parse(String(p.at || ''))
    return !Number.isFinite(at) || at >= cutoff
  })
  if (kept.length > cap) {
    const atOf = (p) => { const n = Date.parse(String(p.at || '')); return Number.isFinite(n) ? n : 0 }
    kept = kept.slice().sort((a, b) => atOf(a) - atOf(b))
    const nonPending = kept.filter((p) => String(p.status || 'pending') !== 'pending')
    const need = kept.length - cap
    const drop = new Set(nonPending.slice(0, need).map((p) => p.id))
    kept = kept.filter((p) => !drop.has(p.id))
    if (kept.length > cap) kept = kept.slice(-cap) // 极端情况：保留最近 cap 条
  }
  return { plans: kept, removed: list.length - kept.length }
}
