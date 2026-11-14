/**
 * scripts/test-manual-check.mjs —— 验证「手动检查」不受值守时段限制
 * 用法：node scripts/test-manual-check.mjs
 * 假 ctx + 假 fetch：5 个主播里只有乃琳Queen 在播；配置的值守时段设为「从不在线」，
 * 断言 /tick 仍能手动进入直播间（自动模式在该时段不会进房）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/tmp/bili-duty-tick-test'
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'dsh')
mkdirSync(join(HOME, 'bili-duty'), { recursive: true })

const streamers = [
  { mid: '672353429', roomId: '22632424', name: '贝拉kira', enabled: true, order: 0 },
  { mid: '672342685', roomId: '22625027', name: '乃琳Queen', enabled: true, order: 1 },
  { mid: '672328094', roomId: '22637261', name: '嘉然今天吃什么', enabled: true, order: 2 },
  { mid: '3537115310721181', roomId: '30849777', name: '心宜不是心仪', enabled: true, order: 3 },
  { mid: '3537115310721781', roomId: '30858592', name: '思诺snow', enabled: true, order: 4 },
]
const config = {
  enabled: true,
  streamers,
  autoEnabled: true,
  autoCheckMs: 1800000,
  workHours: '00:00-00:01', // 几乎全天不在值守时段（UTC）
  workHoursTz: 'UTC',
  plans: [],
  taskWatch: false, // 测试不联网上报观看
  taskLike: false,
  taskGift: false,
  taskDanmaku: false,
  greetingTemplates: [],
}
const cred = { sessdata: 'mock-sessdata', bili_jct: 'mock-csrf', buvid3: 'mock-buvid3', dedeuserid: '23209281', uname: 'tester', saved_at: Date.now() }
writeFileSync(join(HOME, 'bili-duty', 'config.json'), JSON.stringify(config, null, 2))
writeFileSync(join(HOME, 'bili-duty', 'credential.json'), JSON.stringify(cred, null, 2))

const WBI_IMG = 'a'.repeat(64)
const WBI_SUB = 'b'.repeat(64)
const json = (v) => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(v) })
let fetchCalls = 0
global.fetch = async (url) => {
  fetchCalls += 1
  const u = String(url)
  if (u.includes('/x/web-interface/nav')) return json({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } } })
  if (u.includes('/room/v1/Room/getRoomInfoOld')) {
    const mid = new URL(u).searchParams.get('mid')
    if (mid === '672342685') return json({ code: 0, data: { roomid: 22625027, liveStatus: 1, title: '测试直播', uname: '乃琳Queen', online: 1 } })
    return json({ code: 0, data: { roomid: 0, liveStatus: 0, title: '', uname: '', online: 0 } })
  }
  if (u.includes('/room/v1/Room/get_info')) {
    // 旧接口已在 v1.11.12 弃用；保留 mock 只为断言代码不再走这里时会暴露问题（见 test-room-info.mjs）
    return json({ code: 0, data: { room_id: 22625027, uid: '672342685', live_status: 1, title: '测试直播', uname: '乃琳Queen', online: 1 } })
  }
  if (u.includes('/xlive/web-room/v1/index/getInfoByRoom')) {
    return json({ code: 0, data: {
      room_info: { room_id: 22625027, uid: 672342685, live_status: 1, title: '测试直播', online: 1 },
      anchor_info: { base_info: { uname: '乃琳Queen' } },
    } })
  }
  if (u.includes('roomEntryAction')) return json({ code: 0 })
  if (u.includes('getDanmuInfo')) return json({ code: -1, message: 'mock：测试不连弹幕' })
  return json({ code: 0, data: {} })
}

let handler = null
let cleanup = null
const ctx = {
  webServer: { register: (opts) => { handler = opts.handler; return () => { handler = null } } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanup = d; return d },
  get: (name) => {
    if (name === 'dshHomePath') return (sub) => join(HOME, sub)
    if (name === 'llm') return null
    if (name === 'attachments') return null
    return null
  },
}

function callTick() {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url: '/api/bili-duty/tick', on: () => req }
    const res = { statusCode: 200, setHeader: () => {}, end: (t) => { try { resolve(JSON.parse(t)) } catch (e) { reject(e) } } }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const { apply } = await import('../index.js?test=' + Math.random())
apply(ctx)
await new Promise((r) => setTimeout(r, 50))
if (!handler) throw new Error('没注册到 /api/bili-duty 路由')

const out = await callTick()
console.log('tick 返回 =', JSON.stringify({ ok: out.ok, manual: out.manual, outside: out.outside, main: out.main }));
const log = readFileSync(join(HOME, 'bili-duty', 'live.log'), 'utf8')
const asserts = [
  ['ok', out.ok === true],
  ['手动进入成功', out.manual === 'entered'],
  ['进入的是乃琳直播间', Number(out.main?.realRoomId) === 22625027],
  ['主看房名称', out.main?.name === '乃琳Queen'],
  ['进房原因为手动检查', out.main?.reason === '手动检查'],
  ['识别出不在值守时段', out.outside === true],
  ['提示包含值守时段说明', String(out.hint || '').includes('值守时段')],
  ['日志记录手动检查', log.includes('手动检查：进入「乃琳Queen」直播间')],
]
let failed = 0
for (const [name, ok] of asserts) {
  console.log(ok ? `  PASS  ${name}` : `  FAIL  ${name}`)
  if (!ok) failed += 1
}
if (typeof cleanup === 'function') cleanup()
console.log(`\n${failed ? '失败 ' + failed + ' 项' : '全部通过'}（fetch 调用 ${fetchCalls} 次）`)
process.exit(failed ? 1 : 0)
