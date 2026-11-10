/**
 * 观看上报（live-trace E/X）单元测试。
 * 用假 fetch 模拟 B站接口，不碰网络；验证签名、E/X 时序、失败分支、任务进度解析。
 * 运行：node scripts/test-trace.mjs
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import { getTraceRoom, getWatchTaskProgress, spyderSign, watchTrace } from '../lib/duty-trace.mjs'

const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png'
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png'

function resp(obj) {
  return { text: async () => JSON.stringify(obj) }
}

function mockFetch(handlers) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, opts })
    for (const [re, fn] of handlers) if (re.test(u)) return fn(u, opts)
    throw new Error('未预期的请求：' + u.slice(0, 120))
  }
  return calls
}

const cred = { bili_jct: 'csrf-token', buvid3: 'buvid3-value', sessdata: 's', dedeuserid: '1' }
const navHandler = [/web-interface\/nav/, () => resp({ code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } })]

let pass = 0
async function test(name, fn) {
  await fn()
  pass += 1
  console.log('✓ ' + name)
}

await test('spyderSign：按 secret_rule 链式 HMAC，字段/id/device 解包正确', () => {
  const sd = {
    id: JSON.stringify([9, 371, 3, 22625027]),
    device: JSON.stringify(['buvid-x', 'uuid-y']),
    ets: 1794321292,
    time: 60,
    ts: 1794321400000,
  }
  const rule = [2, 5, 1, 4]
  const key = 'seacasdgyijfhofiuxoannn'
  const got = spyderSign(sd, rule, key)
  // 同算法独立重算（结构由测试固定，防止实现悄悄改字段）
  const obj = {
    platform: 'web', parent_id: 9, area_id: 371, seq_id: 3, room_id: 22625027,
    buvid: 'buvid-x', uuid: 'uuid-y', ets: 1794321292, time: 60, ts: 1794321400000,
  }
  let want = JSON.stringify(obj)
  for (const r of rule) want = createHmac({ 0: 'md5', 1: 'sha1', 2: 'sha256', 3: 'sha224', 4: 'sha512', 5: 'sha384' }[r], key).update(want).digest('hex')
  assert.equal(got, want)
  assert.match(got, /^[0-9a-f]{128}$/) // 最后一步 sha512 → 128 hex
})

await test('watchTrace：E + 2 次 X 成功，onTick 累计 interval 秒，abort 正常退出', async () => {
  const base = Math.floor(Date.now() / 1000)
  const calls = mockFetch([
    navHandler,
    [/x25Kn\/E\?/, () => resp({ code: 0, message: '0', data: { timestamp: base, heartbeat_interval: 1, secret_key: 'k', secret_rule: [2], patch_status: 2 } })],
    [/x25Kn\/X\?/, () => resp({ code: 0, message: '0', data: { timestamp: Math.floor(Date.now() / 1000), heartbeat_interval: 1, secret_key: 'k', secret_rule: [2] } })],
  ])
  const ticks = []
  const logs = []
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 2600)
  const r = await watchTrace({
    cred,
    room: { roomId: 22625027, uid: '672342685', areaId: 371, parentAreaId: 9, uname: '乃琳Queen' },
    signal: ctl.signal,
    onTick: (s) => ticks.push(s),
    onLog: (m) => logs.push(m),
    onSession: () => {},
  })
  assert.equal(r.aborted, true)
  assert.ok(ticks.length >= 2, '至少成功 2 次心跳，实际 ' + ticks.length)
  assert.equal(r.watchedSec, ticks.reduce((a, b) => a + b, 0))
  assert.ok(r.watchedSec >= 2)
  assert.ok(logs.some((m) => m.includes('观看心跳已建立')))
  const urls = calls.map((c) => c.url)
  assert.ok(urls.some((u) => u.includes('/x25Kn/E?') && u.includes('w_rid=')), 'E 必须 WBI 签名')
  assert.ok(urls.some((u) => u.includes('/x25Kn/X?') && u.includes('s=') && u.includes('w_rid=')), 'X 必须带 s 与 WBI 签名')
})

await test('watchTrace：E 返回非 0 → 抛错（由 index.js 记日志并稍后重试）', async () => {
  mockFetch([
    navHandler,
    [/x25Kn\/E\?/, () => resp({ code: -352, message: '风控校验失败' })],
  ])
  await assert.rejects(
    () => watchTrace({ cred, room: { roomId: 1, uid: '2', areaId: 3, parentAreaId: 4 }, signal: new AbortController().signal }),
    /观看会话建立失败：\[-352\]/,
  )
})

await test('watchTrace：X 返回非 0 → 不抛错，返回 reason=code=-500 并记日志', async () => {
  const base = Math.floor(Date.now() / 1000)
  mockFetch([
    navHandler,
    [/x25Kn\/E\?/, () => resp({ code: 0, message: '0', data: { timestamp: base - 2, heartbeat_interval: 0, secret_key: 'k', secret_rule: [2] } })],
    [/x25Kn\/X\?/, () => resp({ code: -500, message: '服务异常' })],
  ])
  const logs = []
  const r = await watchTrace({
    cred,
    room: { roomId: 1, uid: '2', areaId: 3, parentAreaId: 4 },
    signal: new AbortController().signal,
    onLog: (m) => logs.push(m),
  })
  assert.equal(r.aborted, false)
  assert.equal(r.reason, 'code=-500')
  assert.equal(r.watchedSec, 0)
  assert.ok(logs.some((m) => m.includes('观看心跳失败：[-500]')))
})

await test('getTraceRoom：解析 getInfoByRoom 的 area_id / parent_area_id / uid', async () => {
  mockFetch([
    navHandler,
    [/getInfoByRoom/, () => resp({
      code: 0,
      data: {
        room_info: { room_id: 22625027, uid: 672342685, area_id: 371, parent_area_id: 9, live_status: 1 },
        anchor_info: { base_info: { uname: '乃琳Queen' } },
      },
    })],
  ])
  const room = await getTraceRoom(cred, 22625027)
  assert.deepEqual(room, { roomId: 22625027, uid: '672342685', areaId: 371, parentAreaId: 9, liveStatus: 1, uname: '乃琳Queen' })
})

await test('getWatchTaskProgress：从 sub_title 解析每日上限 X/Y 与 intimacy', async () => {
  mockFetch([
    [/GetActivatedMedalInfo/, () => resp({
      code: 0,
      data: {
        intimacy: 264, next_intimacy: 8760,
        task_info: [
          { jump_type: 'like', title: '点赞直播', sub_title: '', is_done: true },
          { jump_type: 'watchLive', title: '观看直播满15分钟', sub_title: '每日上限 3/10', is_done: false },
        ],
      },
    })],
  ])
  const t = await getWatchTaskProgress(cred, '672342685')
  assert.equal(t.current, 3)
  assert.equal(t.total, 10)
  assert.equal(t.done, false)
  assert.equal(t.intimacy, 264)
  assert.equal(t.title, '观看直播满15分钟')
})

console.log(`\n全部通过：${pass} 项`)
