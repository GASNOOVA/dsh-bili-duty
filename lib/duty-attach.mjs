/**
 * lib/duty-attach.mjs —— 插件自己写入的「动态图片附件」清退
 * ============================================================================
 * 背景：
 *   · 多模态识图（动态里的直播日程表）必须先把图片交给宿主 attachments 服务
 *     落盘（llm.generate({ images }) 只认持久化 ref，见 @deepseek-ai/dsh-llm）。
 *   · DSH 0.2.2 的附件库是内容寻址的共享库，**没有 delete 接口**，源码注释也写明
 *     已发布对象要等「未来的保留策略」才会被回收。
 *   · 所以这里做插件侧的保守清退：只回收「本插件新建、且已经不再被任何会话引用」
 *     的图片对象；有共享/被引用/证据不足的一律保留。
 *
 * 安全规则（按顺序）：
 *   1) 只记录「保存后 5 秒内 mtime 仍是新的」对象 —— mtime 很旧说明是内容去重命中
 *      （对象原本就存在，可能是用户聊天里的同一张图），不纳入清退。
 *   2) 清退前校验文件大小 + sha256 与 ref 一致，不一致就只丢跟踪记录、不删文件。
 *   3) 清退前扫描 DSH 会话日志（session.*.jsonl[.zstd]）里是否还引用该 sha；
 *      被引用 → 永不删除（只把记录移出跟踪列表）。
 *   4) 会话扫描超预算/解压失败/目录不存在 → 本轮全部延后（保守），下轮再试。
 *   5) 只保留 keepDays 天；附件库 tmp/ 与插件家目录里的 *.tmp 也顺手清掉。
 *
 * 纯函数优先，方便 scripts/test-attach-clean.mjs 用临时目录覆盖。
 * ============================================================================
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 插件图片附件默认保留天数 */
export const ATTACH_KEEP_DAYS = 7
/** 跟踪表最多保留多少条（极端情况下防止跟踪文件自己变大） */
export const ATTACH_MAX_ENTRIES = 500
/** 跟踪文件名（放在插件家目录） */
export const ATTACH_TRACK_FILE = 'attachments.json'
/** 附件库 tmp/ 与家目录 *.tmp 的清理阈值 */
export const ATTACH_TMP_MAX_AGE_MS = 6 * 3600 * 1000
/** 一轮会话扫描允许读取的压缩字节上限，超了就保守延后 */
export const SESSION_SCAN_MAX_BYTES = 64 * 1024 * 1024

const NEW_OBJECT_WINDOW_MS = 5000
const ID_RE = /^sha256:([a-f0-9]{64})$/

const shaOfId = (id) => {
  const m = ID_RE.exec(String(id || ''))
  return m ? m[1] : ''
}

/** 跟踪文件路径 */
export function trackPath(home) {
  return join(home, ATTACH_TRACK_FILE)
}

/** 同步计算文件 sha256（读不到返回空串） */
export function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

/** 读跟踪表；坏文件/坏条目直接忽略，不让清理逻辑崩掉 */
export function readTrack(file) {
  let raw = null
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const id = String(e.id || '')
    const path = String(e.path || '')
    const at = Number(e.at)
    if (!shaOfId(id) || !path || !Number.isFinite(at) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      path,
      bytes: Number(e.bytes) || 0,
      width: Number(e.width) || 0,
      height: Number(e.height) || 0,
      mediaType: String(e.mediaType || ''),
      at,
    })
  }
  return out
}

/** 原子写跟踪表（tmp + rename）；写失败返回 false */
export function writeTrack(file, list) {
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(list || [], null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    return false
  }
}

/**
 * 记录一个刚保存的图片 ref —— 只记录本插件新建（非内容去重命中）的对象。
 * @param {{home:string, ref:object, hostPath:string, now?:number, windowMs?:number, maxEntries?:number}} input
 * @returns {{tracked:boolean, shared?:boolean, reason?:string, id?:string, evicted?:number}}
 */
export function trackSavedAttachment({ home, ref, hostPath, now = Date.now(), windowMs = NEW_OBJECT_WINDOW_MS, maxEntries = ATTACH_MAX_ENTRIES } = {}) {
  const sha = shaOfId(ref?.attachmentId)
  const path = String(hostPath || '')
  if (!sha || !path) return { tracked: false, reason: 'bad-ref' }
  let st = null
  try { st = statSync(path) } catch { return { tracked: false, reason: 'missing' } }
  if (!st.isFile()) return { tracked: false, reason: 'not-file' }
  // mtime 很旧 = 内容寻址命中已有对象（可能是用户聊天附件的同一张图），不归我们管
  if (now - st.mtimeMs > windowMs) return { tracked: false, shared: true, reason: 'pre-existing' }

  const file = trackPath(home)
  const list = readTrack(file)
  const id = `sha256:${sha}`
  const entry = {
    id,
    path,
    bytes: Number.isFinite(Number(ref?.bytes)) && Number(ref.bytes) > 0 ? Number(ref.bytes) : st.size,
    width: Number(ref?.width) || 0,
    height: Number(ref?.height) || 0,
    mediaType: String(ref?.mediaType || ''),
    at: Number(now),
  }
  const idx = list.findIndex((x) => x.id === id)
  if (idx >= 0) list[idx] = entry
  else list.push(entry)

  let evicted = 0
  if (list.length > maxEntries) {
    list.sort((a, b) => a.at - b.at)
    evicted = list.length - maxEntries
    list.splice(0, evicted)
  }
  const tracked = writeTrack(file, list)
  return { tracked, shared: false, id, evicted }
}

/** 递归找会话日志文件（session*.jsonl / .jsonl.zstd） */
function walkSessionFiles(root, out = [], depth = 0) {
  if (depth > 6) return out
  let ents = []
  try { ents = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const d of ents) {
    const p = join(root, d.name)
    if (d.isDirectory()) { walkSessionFiles(p, out, depth + 1); continue }
    if (!d.isFile()) continue
    if (/\.tmp$/i.test(d.name)) continue
    if (/^session.*\.jsonl(\.zstd)?$/i.test(d.name) || /\.jsonl\.zstd$/i.test(d.name)) out.push(p)
  }
  return out
}

/**
 * 在 DSH 会话日志里搜 attachment sha（会话日志可能是 zstd 压缩的 jsonl）。
 * 任何不确定情况都返回 incomplete:true，让调用方保守地跳过删除。
 * @returns {{found:Set<string>, incomplete:boolean, scannedBytes:number, files:number}}
 */
export function scanSessionsForShas(sessionsRoot, shas, { maxBytes = SESSION_SCAN_MAX_BYTES } = {}) {
  const need = new Set((shas || []).map((s) => String(s || '')).filter(Boolean))
  const result = { found: new Set(), incomplete: false, scannedBytes: 0, files: 0 }
  if (!need.size) return result
  if (!sessionsRoot || !existsSync(sessionsRoot)) {
    result.incomplete = true
    return result
  }
  const files = walkSessionFiles(sessionsRoot)
  const list = []
  let total = 0
  for (const file of files) {
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size <= 0) continue
      list.push({ file, size: st.size })
      total += st.size
    } catch { result.incomplete = true }
  }
  if (total > maxBytes) {
    result.incomplete = true
    return result
  }
  for (const { file, size } of list) {
    if (!need.size) break
    let buf = null
    try { buf = readFileSync(file) } catch { result.incomplete = true; continue }
    let text = ''
    if (/\.zstd$/i.test(file)) {
      try { text = zstdDecompressSync(buf).toString('utf8') } catch { result.incomplete = true; continue }
    } else {
      text = buf.toString('utf8')
    }
    result.scannedBytes += size
    result.files += 1
    for (const sha of Array.from(need)) {
      if (text.includes(sha)) {
        need.delete(sha)
        result.found.add(sha)
      }
    }
  }
  return result
}

/**
 * 清目录里过期的普通文件（默认全部文件；nameRe 可限定后缀）。
 * @returns {{removed:number, bytes:number}}
 */
export function sweepStaleFiles(dir, { now = Date.now(), maxAgeMs = ATTACH_TMP_MAX_AGE_MS, nameRe = null } = {}) {
  const out = { removed: 0, bytes: 0 }
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of ents) {
    if (!d.isFile()) continue
    if (nameRe && !nameRe.test(d.name)) continue
    const p = join(dir, d.name)
    let st = null
    try { st = statSync(p) } catch { continue }
    if (now - st.mtimeMs < maxAgeMs) continue
    try {
      unlinkSync(p)
      out.removed += 1
      out.bytes += st.size
    } catch { /* 删不掉就下轮再说 */ }
  }
  return out
}

/**
 * 一轮插件附件清退。
 * @param {{home:string, dshHome:string, now?:number, keepDays?:number, maxSessionBytes?:number, maxEntries?:number, tmpMaxAgeMs?:number}} input
 * @returns {{deleted:number, referenced:number, deferred:number, invalid:number, bytesFreed:number,
 *            tmpRemoved:number, tmpBytes:number, scannedBytes:number, incomplete:boolean,
 *            keep:number, trackedBefore:number, keepDays:number, at:number}}
 */
export function sweepPluginAttachments({
  home,
  dshHome,
  now = Date.now(),
  keepDays = ATTACH_KEEP_DAYS,
  maxSessionBytes = SESSION_SCAN_MAX_BYTES,
  maxEntries = ATTACH_MAX_ENTRIES,
  tmpMaxAgeMs = ATTACH_TMP_MAX_AGE_MS,
} = {}) {
  const at = Number(now)
  const trackFile = trackPath(home)
  const before = readTrack(trackFile)
  const cutoff = at - Math.max(1, keepDays) * 86400 * 1000
  const keep = []
  const candidates = []
  let invalid = 0

  for (const e of before) {
    let st = null
    try { st = statSync(e.path) } catch { invalid += 1; continue }
    if (!st.isFile() || !shaOfId(e.id)) { invalid += 1; continue }
    // 大小对不上说明对象不是当初保存的那份（或已被替换），只丢记录、不动文件
    if (Number(e.bytes) > 0 && Number(e.bytes) !== st.size) { invalid += 1; continue }
    if (e.at > cutoff) { keep.push(e); continue }
    candidates.push({ ...e, sha: shaOfId(e.id), size: st.size })
  }

  const stats = {
    deleted: 0,
    referenced: 0,
    deferred: 0,
    invalid,
    bytesFreed: 0,
    tmpRemoved: 0,
    tmpBytes: 0,
    scannedBytes: 0,
    incomplete: false,
    keep: 0,
    trackedBefore: before.length,
    keepDays,
    at,
  }

  if (candidates.length) {
    const verified = []
    for (const c of candidates) {
      if (sha256File(c.path) !== c.sha) { stats.invalid += 1; continue }
      verified.push(c)
    }
    if (verified.length) {
      const scan = scanSessionsForShas(join(dshHome || dirname(home), 'sessions'), verified.map((c) => c.sha), { maxBytes: maxSessionBytes })
      stats.scannedBytes = scan.scannedBytes
      stats.incomplete = scan.incomplete
      if (scan.incomplete) {
        stats.deferred += verified.length
        for (const c of verified) keep.push(c)
      } else {
        for (const c of verified) {
          // 会话里还在引用 → 交给 DSH 自己未来回收，插件永不删
          if (scan.found.has(c.sha)) { stats.referenced += 1; continue }
          try {
            unlinkSync(c.path)
            stats.deleted += 1
            stats.bytesFreed += c.size
          } catch {
            stats.invalid += 1
            keep.push(c)
          }
        }
      }
    }
  }

  const attachTmp = sweepStaleFiles(join(dshHome || dirname(home), 'attachments', 'v1', 'tmp'), { now: at, maxAgeMs: tmpMaxAgeMs })
  const homeTmp = sweepStaleFiles(home, { now: at, maxAgeMs: tmpMaxAgeMs, nameRe: /\.tmp$/i })
  stats.tmpRemoved = attachTmp.removed + homeTmp.removed
  stats.tmpBytes = attachTmp.bytes + homeTmp.bytes

  let final = keep
  if (final.length > maxEntries) {
    final = final.slice().sort((a, b) => a.at - b.at).slice(-maxEntries)
  }
  writeTrack(trackFile, final)
  stats.keep = final.length
  return stats
}
