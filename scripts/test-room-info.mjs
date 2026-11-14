/**
 * scripts/test-room-info.mjs —— 验证「查房间」改走 getInfoByRoom（旧 get_info 会被 B站 412）
 * 用法：node scripts/test-room-info.mjs
 */
import assert from 'node:assert/strict'
import { getRoomInfo } from '../lib/live.mjs'

const cred = { sessdata: 's', bili_jct: 'c', buvid3: 'b', dedeuserid: '1' }
const WBI_IMG = 'a'.repeat(64)
const WBI_SUB = 'b'.repeat(64)
const json = (v, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(v) })
const html = (text, status = 412) => ({ ok: false, status, text: async () => text })

let calls = []
let mode = 'ok'
global.fetch = async (url) => {
  const u = String(url)
  calls.push(u)
  if (u.includes('/x/web-interface/nav')) {
    return json({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } } })
  }
  if (u.includes('/xlive/web-room/v1/index/getInfoByRoom')) {
    if (mode === 'html412') {
      return html('<!DOCTYPE html><html lang="zh-cn"><head><meta http-equiv="Access-Control-Allow-Origin" content="*" /></head><body>412</body></html>')
    }
    if (mode === 'code') return json({ code: -352, message: '风控校验失败' })
    return json({
      code: 0,
      data: {
        room_info: { room_id: 30849777, uid: '3537115310721181', live_status: 1, title: '【2D】唱歌聊天~', online: 85382 },
        anchor_info: { base_info: { uname: '心宜不是心仪' } },
      },
    })
  }
  if (u.includes('/room/v1/Room/get_info')) {
    return json({ code: 0, data: { room_id: 22625027, uid: '672342685', live_status: 1, title: '旧接口', uname: '旧', online: 1 } })
  }
  return json({ code: 0, data: {} })
}

// 1) 正常解析（新接口）
const info = await getRoomInfo(30849777, cred)
assert.equal(info.realRoomId, 30849777)
assert.equal(info.uid, '3537115310721181')
assert.equal(info.liveStatus, 1)
assert.equal(info.title, '【2D】唱歌聊天~')
assert.equal(info.uname, '心宜不是心仪')
assert.equal(info.online, 85382)
assert.ok(calls.some((u) => u.includes('/xlive/web-room/v1/index/getInfoByRoom')), '应走 getInfoByRoom')
assert.ok(calls.some((u) => u.includes('w_rid=') && u.includes('wts=')), '请求应带 WBI 签名')
assert.ok(!calls.some((u) => u.includes('/room/v1/Room/get_info')), '不应再走旧接口')

// 2) 旧接口被 412 时的诊断信息（模拟新接口也返回 HTML 的情况）
mode = 'html412'
let err = null
try { await getRoomInfo(30849777, cred) } catch (e) { err = e }
assert.ok(err && err.message.includes('查房间') && err.message.includes('HTTP 412'), 'HTML 412 应给出可诊断错误')

// 3) 接口 code != 0 抛错
mode = 'code'
err = null
try { await getRoomInfo(30849777, cred) } catch (e) { err = e }
assert.ok(err && err.message.includes('风控校验失败'))

console.log('全部通过：12 项断言')
