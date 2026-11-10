/**
 * scripts/test-attach-clean.mjs —— 插件图片附件清退测试
 * 用法：node scripts/test-attach-clean.mjs
 *
 * 覆盖：共享对象不跟踪、新建对象跟踪/幂等/上限、保留期、会话引用保护、
 *       大小/hash 校验、扫描预算不足保守延后、tmp 清理。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import {
  ATTACH_KEEP_DAYS,
  readTrack,
  scanSessionsForShas,
  sha256File,
  sweepPluginAttachments,
  trackPath,
  trackSavedAttachment,
  writeTrack,
} from '../lib/duty-attach.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.probe', 'attach-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'home'), { recursive: true })
mkdirSync(join(root, 'dsh', 'sessions'), { recursive: true })
const home = join(root, 'home')
const dshHome = join(root, 'dsh')
const now = Date.parse('2026-11-10T12:00:00Z')
const day = 86400 * 1000

let failed = 0
const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL', msg); failed += 1 } else console.log('PASS', msg)
}

let seq = 0
function makeImage({ ageMs = 0, size = 256 } = {}) {
  seq += 1
  const dir = join(root, 'objects')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `img-${seq}.jpg`)
  const buf = Buffer.alloc(size, 0)
  buf.write(`image-${seq}`, 0, 'utf8')
  writeFileSync(path, buf)
  if (ageMs > 0) {
    const sec = (now - ageMs) / 1000
    utimesSync(path, sec, sec)
  } else {
    const sec = now / 1000
    utimesSync(path, sec, sec)
  }
  const sha = sha256File(path)
  const ref = { attachmentId: `sha256:${sha}`, name: `img-${seq}.jpg`, bytes: buf.length, width: 10, height: 10, mediaType: 'image/jpeg' }
  return { path, ref, sha, size: buf.length }
}

/* 1) 内容去重命中的旧对象（可能是用户聊天附件）不纳入跟踪 */
{
  const a = makeImage({ ageMs: 10 * day })
  const r = trackSavedAttachment({ home, ref: a.ref, hostPath: a.path, now })
  ok(r.tracked === false && r.shared === true, '旧 mtime 对象应视为共享、不跟踪')
  ok(readTrack(trackPath(home)).length === 0, '共享对象不应写入跟踪表')
}

/* 2) 新建对象跟踪 + 幂等 */
const newImg = makeImage()
{
  const r = trackSavedAttachment({ home, ref: newImg.ref, hostPath: newImg.path, now })
  ok(r.tracked === true, '新对象应被跟踪')
  const list = readTrack(trackPath(home))
  ok(list.length === 1, `跟踪表应 1 条（实际 ${list.length}）`)
  ok(list[0].id === newImg.ref.attachmentId && list[0].bytes === newImg.ref.bytes, '跟踪条目字段应正确')
  trackSavedAttachment({ home, ref: newImg.ref, hostPath: newImg.path, now })
  ok(readTrack(trackPath(home)).length === 1, '重复跟踪应幂等（仍 1 条）')
}

/* 3) 保留期内不删 */
{
  const s = sweepPluginAttachments({ home, dshHome, now })
  ok(s.deleted === 0 && s.keep === 1, '保留期内的附件不应删除')
  ok(statSync(newImg.path).isFile(), '保留期内文件应存在')
}

/* 4) 过期 + 无引用 → 删除并清空跟踪表 */
{
  writeTrack(trackPath(home), [{ id: newImg.ref.attachmentId, path: newImg.path, bytes: newImg.size, at: now - 10 * day }])
  const s = sweepPluginAttachments({ home, dshHome, now, keepDays: ATTACH_KEEP_DAYS })
  ok(s.deleted === 1 && s.bytesFreed === newImg.size, '过期无引用附件应删除')
  ok(!(function () { try { statSync(newImg.path); return true } catch { return false } })(), '删除后文件应不存在')
  ok(readTrack(trackPath(home)).length === 0, '删除后跟踪表应清空')
}

/* 5) 过期但会话日志引用 → 永不删 */
{
  const img = makeImage()
  const sessDir = join(dshHome, 'sessions', 'workspace-a', 'session-1')
  mkdirSync(sessDir, { recursive: true })
  const text = JSON.stringify({ type: 'message', images: [{ attachmentId: `sha256:${img.sha}`, name: 'x.jpg' }] })
  writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))
  writeTrack(trackPath(home), [{ id: img.ref.attachmentId, path: img.path, bytes: img.size, at: now - 10 * day }])
  const s = sweepPluginAttachments({ home, dshHome, now })
  ok(s.referenced === 1 && s.deleted === 0, '被会话引用的附件应保留')
  ok(statSync(img.path).isFile(), '被引用文件应存在')
  ok(readTrack(trackPath(home)).length === 0, '被引用对象应移出跟踪表（不再管理）')
}

/* 6) 大小对不上 → 只丢记录不删文件 */
{
  const img = makeImage()
  writeTrack(trackPath(home), [{ id: img.ref.attachmentId, path: img.path, bytes: img.size + 1, at: now - 10 * day }])
  const s = sweepPluginAttachments({ home, dshHome, now })
  ok(s.deleted === 0 && s.invalid === 1, '大小不一致应判为失效且不删除')
  ok(statSync(img.path).isFile(), '大小不一致时文件应保留')
  ok(readTrack(trackPath(home)).length === 0, '失效条目应移出跟踪表')
}

/* 7) 会话扫描超预算 → 保守延后 */
{
  const img = makeImage()
  const sessDir = join(dshHome, 'sessions', 'workspace-b', 'session-2')
  mkdirSync(sessDir, { recursive: true })
  writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ blob: 'x'.repeat(2048) }))))
  writeTrack(trackPath(home), [{ id: img.ref.attachmentId, path: img.path, bytes: img.size, at: now - 10 * day }])
  const s = sweepPluginAttachments({ home, dshHome, now, maxSessionBytes: 16 })
  ok(s.incomplete === true && s.deferred === 1 && s.deleted === 0, '扫描超预算应延后删除')
  ok(readTrack(trackPath(home)).length === 1, '延后条目应保留在跟踪表')
}

/* 8) 跟踪条数上限：超出时淘汰最旧 */
{
  rmSync(trackPath(home), { force: true })
  const imgs = [makeImage(), makeImage(), makeImage()]
  for (const img of imgs) trackSavedAttachment({ home, ref: img.ref, hostPath: img.path, now, maxEntries: 2 })
  const list = readTrack(trackPath(home))
  ok(list.length === 2, `上限 2 时应只留 2 条（实际 ${list.length}）`)
  ok(list.some((e) => e.id === imgs[2].ref.attachmentId), '应保留最新的条目')
}

/* 9) tmp 清理：过期 tmp 删、未过期留、只清 *.tmp */
{
  const stale = join(root, 'home', 'stale.tmp')
  const fresh = join(root, 'home', 'fresh.tmp')
  const keepFile = join(root, 'home', 'attachments.json')
  writeFileSync(stale, 'old')
  writeFileSync(fresh, 'new')
  utimesSync(stale, (now - 2 * 6 * 3600 * 1000) / 1000, (now - 2 * 6 * 3600 * 1000) / 1000)
  const attachTmp = join(dshHome, 'attachments', 'v1', 'tmp')
  mkdirSync(attachTmp, { recursive: true })
  const staged = join(attachTmp, 'staged-abc')
  writeFileSync(staged, 'staged')
  utimesSync(staged, (now - 10 * 3600 * 1000) / 1000, (now - 10 * 3600 * 1000) / 1000)
  const s = sweepPluginAttachments({ home, dshHome, now })
  ok(s.tmpRemoved >= 2, `应清理至少 2 个过期临时文件（实际 ${s.tmpRemoved}）`)
  ok(!(function () { try { statSync(stale); return true } catch { return false } })(), '过期 .tmp 应删除')
  ok(statSync(fresh).isFile(), '未过期 .tmp 应保留')
  ok(readdirSync(join(root, 'home')).includes('attachments.json'), '非 tmp 文件不应删除')
}

/* 10) 直接扫描函数：纯文本 jsonl 与损坏 zstd */
{
  const dir = join(dshHome, 'sessions', 'workspace-c', 'session-3')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.plain.jsonl'), JSON.stringify({ t: 'a'.repeat(64) }))
  const good = scanSessionsForShas(join(dshHome, 'sessions'), ['a'.repeat(64)])
  ok(good.found.has('a'.repeat(64)) && good.incomplete === false, '应能在明文 jsonl 中命中 sha')
  writeFileSync(join(dir, 'session.bad.jsonl.zstd'), Buffer.from('not-zstd'))
  const bad = scanSessionsForShas(join(dshHome, 'sessions'), ['b'.repeat(64)])
  ok(bad.incomplete === true, 'zstd 解压失败应标记 incomplete（保守）')
}

/* 11) 跟踪表坏文件不崩 */
{
  writeFileSync(trackPath(home), 'not-json')
  const list = readTrack(trackPath(home))
  ok(Array.isArray(list) && list.length === 0, '坏跟踪文件应回退为空数组')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
