/**
 * lib/duty-trace.mjs —— B站 粉丝团「观看直播」上报（live-trace E/X 心跳）
 * ============================================================================
 * 背景：房间进房接口（roomEntryAction）、弹幕长连接、拉流都不算「观看时长」。
 * 粉丝团任务「观看直播满15分钟」要求网页播放器那套 live-trace 心跳：
 *
 *   ① GET  getInfoByRoom（WBI 签名）取 area_id / parent_area_id / 主播 uid
 *   ② POST https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E
 *        id=JSON.stringify([parent_area_id, area_id, seq, room_id])
 *        device=JSON.stringify([buvid, uuid])、ruid、ts、is_patch=0、
 *        heart_beat='[]'、ua、web_location=444.8、csrf
 *      → { timestamp, heartbeat_interval, secret_key, secret_rule }
 *   ③ 每 heartbeat_interval 秒 POST .../x25Kn/X，带 HMAC 链式签名 s；
 *      成功一次 = 上报 heartbeat_interval 秒；连续 15 分钟算完成 1 轮（每日上限 10 轮）。
 *
 * 签名 spyder：把 id/device 还原成
 *   { platform:'web', parent_id, area_id, seq_id, room_id, buvid, uuid, ets, time, ts }
 * 先 JSON.stringify，再按 secret_rule 数组逐轮 HMAC（0=md5,1=sha1,2=sha256,
 * 3=sha224,4=sha512,5=sha384）。
 *
 * 实现参考：andywang425/BLTH 的 watchTask.ts / MedalModule.ts（MIT）。
 * ============================================================================
 */
import { createHmac, randomUUID } from 'node:crypto'
import { UA, headersOf, wbiSign } from './live.mjs'

const TRACE_HOST = 'https://live-trace.bilibili.com'
const REFERER = 'https://live.bilibili.com/'
const WEB_LOCATION = '444.8'
const ALG = { 0: 'md5', 1: 'sha1', 2: 'sha256', 3: 'sha224', 4: 'sha512', 5: 'sha384' }
const LOG_EVERY_SEC = 300

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      cleanup()
      resolve()
    }
    function onAbort() {
      done()
    }
    function cleanup() {
      clearTimeout(timer)
      try { signal?.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }
    }
    try { signal?.addEventListener('abort', onAbort, { once: true }) } catch { /* 忽略 */ }
  })
}

async function getJson(url, cred) {
  const r = await fetch(url, { headers: headersOf(cred, REFERER) })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { code: -1, message: `非 JSON 响应：${t.slice(0, 80)}` } }
}

async function postTrace(cred, path, params) {
  const qs = await wbiSign(params, cred)
  const r = await fetch(`${TRACE_HOST}${path}?${qs}`, {
    method: 'POST',
    headers: { ...headersOf(cred, REFERER), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { code: -1, message: `非 JSON 响应：${t.slice(0, 80)}` } }
}

/** 从 id/device 还原签名对象并做 HMAC 链 */
export function spyderSign(payload, rule = [], key = '') {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload
  const [parent_id, area_id, seq_id, room_id] = JSON.parse(data.id)
  const [buvid, uuid] = JSON.parse(data.device)
  const obj = { platform: 'web', parent_id, area_id, seq_id, room_id, buvid, uuid, ets: data.ets, time: data.time, ts: data.ts }
  let s = JSON.stringify(obj)
  for (const r of rule) s = createHmac(ALG[r] || 'md5', String(key)).update(s).digest('hex')
  return s
}

/** 取观看心跳需要的房间字段（get_info 不返回 area_id，必须 getInfoByRoom） */
export async function getTraceRoom(cred, realRoomId) {
  const qs = await wbiSign({ room_id: realRoomId, web_location: WEB_LOCATION }, cred)
  const j = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?${qs}`, cred)
  if (j.code !== 0) throw new Error(`查观看房间信息失败：${j.message || j.code}`)
  const ri = j.data?.room_info || {}
  const uid = String(ri.uid || '')
  if (!ri.room_id || !uid) throw new Error('观看房间信息缺字段（room_id/uid）')
  return {
    roomId: Number(ri.room_id),
    uid,
    areaId: Number(ri.area_id) || 0,
    parentAreaId: Number(ri.parent_area_id) || 0,
    liveStatus: Number(ri.live_status) || 0,
    uname: String(j.data?.anchor_info?.base_info?.uname || ''),
  }
}

/** 粉丝团任务进度（含观看任务 sub_title「每日上限 X/Y」） */
export async function getWatchTaskProgress(cred, anchorUid) {
  const csrf = encodeURIComponent(cred?.bili_jct || '')
  const url = `https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo?csrf=${csrf}&target_id=${encodeURIComponent(anchorUid)}&web_location=444.260`
  const j = await getJson(url, cred)
  if (j.code !== 0) throw new Error(`查粉丝团任务失败：${j.message || j.code}`)
  const d = j.data || {}
  const w = (d.task_info || []).find((t) => t.jump_type === 'watchLive') || null
  let current = 0
  let total = 0
  const m = /每日上限\s*(\d+)\s*\/\s*(\d+)/.exec(String(w?.sub_title || ''))
  if (m) { current = Number(m[1]) || 0; total = Number(m[2]) || 0 }
  return {
    intimacy: Number(d.intimacy) || 0,
    nextIntimacy: Number(d.next_intimacy) || 0,
    title: String(w?.title || ''),
    subTitle: String(w?.sub_title || ''),
    done: Boolean(w?.is_done),
    current,
    total,
  }
}

/** 设备标识：优先 LIVE_BUVID，其次登录时拿到的 buvid3（实测也能过 E） */
function deviceBuvid(cred) {
  return String(cred?.LIVE_BUVID || cred?.buvid3 || '')
}

/**
 * 观看上报主循环。
 * @returns {Promise<{aborted:boolean, watchedSec:number, reason?:string}>}
 */
export async function watchTrace({ cred, room, signal, onLog = () => {}, onTick = () => {}, onSession = () => {}, ua = UA }) {
  const buvid = deviceBuvid(cred)
  if (!buvid) throw new Error('缺少设备标识（buvid3），无法上报观看')
  if (!room?.roomId || !room?.uid) throw new Error('观看房间信息不完整')
  const uuid = randomUUID()
  const device = JSON.stringify([buvid, uuid])
  const idAt = (seq) => JSON.stringify([room.parentAreaId, room.areaId, seq, room.roomId])
  const csrf = cred.bili_jct || ''
  const base = { ruid: room.uid, ua, web_location: WEB_LOCATION, csrf }
  let seq = 0
  let watchedSec = 0
  let lastLogSec = 0

  // E：开一轮观看会话
  const e = await postTrace(cred, '/xlive/data-interface/v1/x25Kn/E', {
    id: idAt(seq), device, ...base, ts: Date.now(), is_patch: 0, heart_beat: JSON.stringify([]),
  })
  if (e.code !== 0) throw new Error(`观看会话建立失败：[${e.code}] ${e.message || ''}`)
  seq += 1
  let state = e.data || {}
  let nextAt = (Number(state.timestamp) + Number(state.heartbeat_interval)) * 1000
  onSession({ intervalSec: Number(state.heartbeat_interval) || 0 })
  onLog(`观看心跳已建立：房间 ${room.roomId}${room.uname ? '「' + room.uname + '」' : ''}，间隔 ${state.heartbeat_interval}s`)
  if (!(nextAt > 0)) throw new Error('观看会话返回的 timestamp/heartbeat_interval 异常')

  while (!signal?.aborted) {
    await sleep(nextAt - Date.now(), signal)
    if (signal?.aborted) break
    const idStr = idAt(seq)
    const sd = {
      id: idStr, device, ets: state.timestamp, benchmark: state.secret_key,
      time: state.heartbeat_interval, ts: Date.now(), ua,
    }
    const s = spyderSign(sd, state.secret_rule, state.secret_key)
    const x = await postTrace(cred, '/xlive/data-interface/v1/x25Kn/X', {
      s, id: idStr, device, ...base, ets: sd.ets, benchmark: sd.benchmark, time: sd.time, ts: sd.ts, trackid: '-99998',
    })
    if (x.code !== 0) {
      onLog(`观看心跳失败：[${x.code}] ${x.message || ''}（房间 ${room.roomId}）`)
      return { aborted: false, watchedSec, reason: `code=${x.code}` }
    }
    seq += 1
    const step = Number(state.heartbeat_interval) || 60
    watchedSec += step
    const data = x.data || {}
    state = { ...state, ...data }
    nextAt = (Number(state.timestamp) + Number(state.heartbeat_interval)) * 1000
    onTick(step)
    if (watchedSec - lastLogSec >= LOG_EVERY_SEC) {
      lastLogSec = watchedSec
      onLog(`观看上报中：已上报 ${Math.round(watchedSec / 60)} 分钟（房间 ${room.roomId}）`)
    }
  }
  return { aborted: true, watchedSec }
}
