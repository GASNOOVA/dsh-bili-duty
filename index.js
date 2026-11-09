/**
 * dsh-bili-duty —— host 半端（个人定制版「直播值守」）
 * ============================================================================
 * 做什么：用你的 B站 账号，对固定的 5 个主播做「值守 + 粉丝团每日任务」。
 *   1. 自动模式：北京时间 08:00–24:00 每 15 分钟查一遍谁开播，进主看房挂着（陪伴）；
 *   2. 手动模式：你在设置页加一条「计划」（主播 + 开播时间），提前 10 分钟进房等待，
 *      到点仍未开播最多等 10 分钟；计划不受工作时间限制；
 *   3. 每日任务：观看直播（低清流）、发送弹幕（进房问候 + AI 智能弹幕）、点赞
 *      （每 10 分钟一轮 300 次，按房间下发的批次/间隔上限切批）、打赏（每房每天
 *      1 个「粉丝团灯牌」，1 电池，余额不足跳过，不自动充值）；
 *   4. 其它在播主播有未完成任务时，异步去补任务（不打断主看房的拉流与弹幕）。
 *
 * 家目录：`$DSH_HOME/bili-duty/`
 *   config.json  设置页写的那份（含主播名单、计划、任务参数）
 *   state.json   每日任务状态（北京时区自然日重置）
 *   credential.json  插件自己扫码登录的凭证
 *   live.log     运行日志
 *
 * 设计文档：docs/DESIGN-personal.md
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, mergeConfig, normalizeConfig, normalizeStreamer } from './lib/duty-config.mjs'
import { beijingDateKey, createStore } from './lib/duty-state.mjs'
import {
  clickLike,
  describeError,
  enterRoom,
  findGift,
  getGiftConfig,
  getLikePolicy,
  getReserveList,
  getWallet,
  isRiskCode,
  sendGift,
} from './lib/duty-actions.mjs'
import { pullStream } from './lib/duty-watch.mjs'
import { DanmakuClient, getRoomByUid, getRoomInfo, sendDanmaku } from './lib/live.mjs'
import { generateQr, pollQr, qrSvg, whoAmI } from './lib/auth.mjs'
import { makeLlm } from './lib/llm.mjs'

export const name = 'bili-duty'
export const inject = ['webServer']

const MAX_LOGS = 120
const HEARTBEAT_MS = 10_000 // 统一心跳：所有「到点了吗」的判断都在这里
const AUTO_CHECK_MS = 15 * 60_000 // 自动模式检查开播
const LIVE_REFRESH_MS = 60_000 // 主播开播状态刷新
const MAIN_ALIVE_MS = 60_000 // 主看房是否还在播
const TASK_SWEEP_MS = 5 * 60_000 // 巡视其它主播补任务
const PLAN_PRE_MS = 10 * 60_000 // 手动计划提前 10 分钟进房
const PLAN_GRACE_MS = 10 * 60_000 // 到点未开播最多再等 10 分钟
const RISK_PAUSE_MS = 10 * 60_000 // 风控后暂停互动任务

/* ────────────────────────── 小工具 ────────────────────────── */

function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
const writeJson = (file, value) => {
  try { writeFileSync(file, JSON.stringify(value, null, 2), 'utf8') } catch { /* 写不动就算了 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min))
const nowIso = () => new Date().toISOString()

/** 北京时间「现在」的 HH:MM 字符串 */
function beijingClock(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 某时区当前是当天的第几分钟。
 *   beijing      固定 UTC+8（默认，不受宿主机时区影响）
 *   local        宿主机本地时区（容器里通常是 UTC）
 *   <IANA 名称>  如 Europe/Berlin；用 Intl 计算，自动处理夏令时
 */
function minuteOfDayInZone(ms, tz) {
  if (tz === 'beijing') {
    const b = new Date(ms + 8 * 3600 * 1000)
    return b.getUTCHours() * 60 + b.getUTCMinutes()
  }
  if (tz && tz !== 'local') {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(ms))
      const h = Number(parts.find((p) => p.type === 'hour')?.value)
      const mi = Number(parts.find((p) => p.type === 'minute')?.value)
      if (Number.isFinite(h) && Number.isFinite(mi)) return h * 60 + mi
    } catch { /* 时区名不合法就退回宿主本地 */ }
  }
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** "08:00-24:00" → 当前是否在工作时间段（左闭右开；24:00 视为 1440）。tz: beijing / local / IANA 时区名 */
function inWorkHours(range, ms = Date.now(), tz = 'beijing') {
  const m = String(range || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
  if (!m) return true
  const toMin = (h, mi) => Math.min(24 * 60, Number(h) * 60 + Number(mi))
  let start = toMin(m[1], m[2])
  let end = toMin(m[3], m[4])
  if (end <= start) end += 24 * 60
  let cur = minuteOfDayInZone(ms, tz)
  if (cur < start) cur += 24 * 60
  return cur >= start && cur < end
}


/** 把 B站 预约记录归一成 {mid, roomId, name, title, at(ISO)}；字段名做多版本兼容 */
function mapReserveItem(it) {
  const o = it && typeof it === 'object' ? it : {}
  const mid = String(o.uid ?? o.up_uid ?? o.anchor_uid ?? o.mid ?? o.upUid ?? '')
  const roomId = String(o.room_id ?? o.roomId ?? o.real_room_id ?? o.realRoomId ?? '')
  const name = String(o.uname ?? o.up_name ?? o.anchor_name ?? o.name ?? o.title ?? '')
  const title = String(o.title ?? o.live_title ?? o.description ?? '')
  const rawAt = o.start_time ?? o.startTime ?? o.live_time ?? o.begin_time ?? o.scheduled_time ?? o.stime ?? o.at ?? o.reserve_time
  let at = NaN
  if (typeof rawAt === 'number') at = rawAt > 1e12 ? rawAt : rawAt * 1000
  else if (typeof rawAt === 'string' && rawAt.trim()) {
    const n = Number(rawAt)
    if (Number.isFinite(n)) at = n > 1e12 ? n : n * 1000
    else at = Date.parse(rawAt)
  }
  return {
    mid,
    roomId,
    name: name || (mid ? `主播 ${mid}` : ''),
    title,
    at: Number.isFinite(at) ? new Date(at).toISOString() : '',
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => {
      s += c
      if (s.length > 1e6) { req.destroy(); resolve({}) }
    })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
}

/* ────────────────────────── 插件主体 ────────────────────────── */

export function apply(ctx) {
  const home = stateDirOf(ctx)
  const cfgFile = join(home, 'config.json')
  const stateFile = join(home, 'state.json')
  const credFile = join(home, 'credential.json')
  const loggedOutFile = join(home, 'logged-out.json')
  const logFile = join(home, 'live.log')

  const pluginDir = dirname(fileURLToPath(import.meta.url))
  let version = ''
  try { version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '' } catch { version = '' }

  const cfg = normalizeConfig(readJson(cfgFile, DEFAULTS))
  const saveCfg = () => writeJson(cfgFile, cfg)
  const store = createStore(home)
  store.load()

  const logs = []
  const log = (msg) => {
    const line = `[${nowIso().slice(11, 19)}] ${msg}`
    logs.push(line)
    if (logs.length > MAX_LOGS) logs.shift()
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 不致命 */ }
  }

  const llm = makeLlm(ctx, cfg)

  /* ── 凭证 ── */
  const isLoggedOut = () => existsSync(loggedOutFile)
  const loadCred = () => {
    if (isLoggedOut()) return null
    const v = readJson(credFile, null)
    return v?.sessdata ? v : null
  }
  const saveOwnCred = (cred) => {
    try { if (existsSync(loggedOutFile)) unlinkSync(loggedOutFile) } catch { /* 忽略 */ }
    writeJson(credFile, {
      sessdata: String(cred.sessdata || ''),
      bili_jct: String(cred.bili_jct || ''),
      buvid3: String(cred.buvid3 || ''),
      dedeuserid: String(cred.dedeuserid || ''),
      uname: String(cred.uname || ''),
      saved_at: nowIso(),
    })
    return credFile
  }

  /* ── 运行态 ── */
  const rt = {
    main: null, // {mid,name,roomId,realRoomId,title,since,reason}
    waiting: null, // 手动计划等待开播 {plan, meta, since}
    visiting: null, // 正在补任务 {mid,name,realRoomId,why,since}
    liveMap: {}, // mid → {roomId,realRoomId,liveStatus,title,uname,online,at,error}
    danmaku: null, // {client, roomId, recent:[]}
    danmakuStatus: '',
    watch: null, // {roomId, ctl, startedAt, bytes, lastTickAt}
    greet: null, // {realRoomId, meta, queue:[], sent:0, lastAt:0}
    lastDanmakuSentAt: 0,
    lastLikeAt: 0,
    likeRunning: false,
    lastAiAt: 0,
    lastAiText: '',
    aiSent: {}, // realRoomId → count（当日）
    sentTexts: [], // 最近发过的弹幕（去重）
    lastLiveRefreshAt: 0,
    lastAutoCheckAt: 0,
    lastAliveCheckAt: 0,
    lastSweepAt: 0,
    nextAutoCheckAt: 0,
    pausedUntil: 0,
    lastError: '',
    heartbeat: null,
    planTick: 0,
    qr: null,
    credAlive: { at: 0, alive: null, name: '' },
    giftBalance: null, // {gold, silver, at}
  }

  const logErr = (msg) => { rt.lastError = String(msg || ''); log(rt.lastError) }

  /* ── 主播列表 / 开播状态 ── */
  const enabledStreamers = () => cfg.streamers.filter((s) => s.enabled !== false)
  const streamerByMid = (mid) => cfg.streamers.find((s) => String(s.mid) === String(mid)) || null

  async function refreshLive(force = false) {
    const cred = loadCred()
    if (!cred) return
    if (!force && Date.now() - rt.lastLiveRefreshAt < LIVE_REFRESH_MS) return
    rt.lastLiveRefreshAt = Date.now()
    for (const s of enabledStreamers()) {
      try {
        const info = s.mid ? await getRoomByUid(s.mid, cred) : await getRoomInfo(s.roomId, cred)
        const realRoomId = Number(info.realRoomId || info.roomId || 0)
        if (!realRoomId) throw new Error('没拿到房间号')
        rt.liveMap[s.mid] = {
          roomId: Number(info.roomId || info.realRoomId || 0),
          realRoomId,
          liveStatus: Number(info.liveStatus) || 0,
          title: info.title || '',
          uname: info.uname || s.name,
          online: Number(info.online) || 0,
          at: Date.now(),
        }
        // 顺手把主播名/房间号补进配置（设置页能看到真实值）
        if (info.uname && s.name !== info.uname) { s.name = info.uname; saveCfg() }
        if (!s.roomId && realRoomId) { s.roomId = String(realRoomId); saveCfg() }
      } catch (e) {
        rt.liveMap[s.mid] = { ...(rt.liveMap[s.mid] || {}), error: String(e?.message || e), at: Date.now() }
      }
    }
  }

  const liveOf = (mid) => rt.liveMap[mid] || null
  const isLive = (mid) => Number(liveOf(mid)?.liveStatus) === 1

  /* ── 弹幕接收（只作为 AI 上下文，不自动回复） ── */
  function stopDanmaku() {
    const d = rt.danmaku
    rt.danmaku = null
    rt.danmakuStatus = ''
    if (!d?.client) return
    try { d.client.stop() } catch { /* 收摊 */ }
  }

  function startDanmaku(meta) {
    stopDanmaku()
    const cred = loadCred()
    if (!cred) return
    const recent = []
    rt.danmaku = { roomId: meta.realRoomId, recent }
    let client = null
    client = new DanmakuClient({
      roomId: meta.realRoomId,
      cred,
      onDanmaku: (d) => {
        recent.push({ uid: String(d.uid || ''), name: String(d.uname || ''), text: String(d.text || ''), at: Date.now() })
        if (recent.length > 300) recent.shift()
      },
      onEvent: () => {},
      onStatus: (s) => { if (rt.main?.realRoomId === meta.realRoomId) rt.danmakuStatus = s },
      onLog: (m) => log(m),
    })
    rt.danmaku.client = client
    client.start().catch((e) => log(`弹幕连接失败：${String(e?.message || e)}`))
  }

  /* ── 观看直播：拉低清流 ── */
  function stopWatch() {
    const w = rt.watch
    rt.watch = null
    if (w?.ctl) { try { w.ctl.abort() } catch { /* 忽略 */ } }
  }

  function startWatch(meta) {
    stopWatch()
    if (!cfg.taskWatch) return
    const cred = loadCred()
    if (!cred) return
    const ctl = new AbortController()
    const w = { roomId: meta.realRoomId, ctl, startedAt: Date.now(), bytes: 0, lastTickAt: Date.now(), running: true }
    rt.watch = w
    log(`开始观看直播间 ${meta.realRoomId} 的直播流（qn=${cfg.watchQn}）`)
    pullStream(cred, meta.realRoomId, {
      qn: cfg.watchQn,
      maxMs: 8 * 3600 * 1000,
      signal: ctl.signal,
      onProgress: ({ bytes }) => { if (rt.watch === w) w.bytes = bytes },
      onLog: (m) => log(m),
    }).then((r) => {
      if (rt.watch !== w) return
      w.running = false
      if (!r?.aborted) log(`观看流结束：${r?.seconds || 0}s / ${Math.round((r?.bytes || 0) / 1024)}KB${r?.message ? '·' + r.message : ''}`)
    }).catch((e) => {
      if (rt.watch === w) { w.running = false; log(`观看流异常：${String(e?.message || e)}`) }
    })
  }

  /* ── 发一条弹幕（统一限速/计数） ── */
  async function sendChat(meta, text, kind = '弹幕') {
    const cred = loadCred()
    if (!cred) return { ok: false, message: '没有登录凭证' }
    const clipped = String(text || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxLen)
    if (!clipped) return { ok: false, message: '内容为空' }
    if (Date.now() < rt.pausedUntil) return { ok: false, message: '风控暂停中' }
    const st = store.ensureRoom(meta.realRoomId, { mid: meta.mid, name: meta.name })
    if (st.danmakuCount >= cfg.danmakuDailyMax) return { ok: false, message: '今日弹幕已达上限' }
    if (Date.now() - rt.lastDanmakuSentAt < cfg.danmakuCooldownMs) return { ok: false, message: '冷却中' }
    const r = await sendDanmaku(cred, meta.realRoomId, clipped)
    if (r.ok) {
      rt.lastDanmakuSentAt = Date.now()
      rt.sentTexts.push(clipped)
      if (rt.sentTexts.length > 40) rt.sentTexts.shift()
      store.addDanmaku(meta.realRoomId, 1)
      store.save()
      log(`[${kind}] ${meta.name || meta.realRoomId}：「${clipped}」`)
      return { ok: true }
    }
    const msg = describeError(r.code, r.message)
    if (isRiskCode(r.code)) rt.pausedUntil = Date.now() + RISK_PAUSE_MS
    logErr(`[${kind}] 发送失败：${msg}`)
    return { ok: false, message: msg }
  }

  /* ── 进房问候（每房每天一次，默认 10 条、间隔 30 秒） ── */
  function startGreeting(meta) {
    rt.greet = null
    if (!cfg.templateDanmaku) return
    const st = store.ensureRoom(meta.realRoomId, { mid: meta.mid, name: meta.name })
    if (st.greeted) return
    const pool = [...new Set((cfg.greetingTemplates || []).map((x) => String(x || '').trim()).filter(Boolean))]
    if (!pool.length) return
    const count = Math.max(1, Math.min(cfg.templateGreetingCount, cfg.greetingTemplates.length))
    const queue = []
    for (let i = 0; i < count; i += 1) queue.push(pool[i % pool.length])
    rt.greet = { realRoomId: meta.realRoomId, meta, queue, sent: 0, lastAt: 0 }
  }

  async function stepGreeting() {
    const g = rt.greet
    if (!g) return
    if (Date.now() - g.lastAt < cfg.templateSpacingMs) return
    if (!g.queue.length) {
      rt.greet = null
      const st = store.ensureRoom(g.realRoomId, { mid: g.meta.mid, name: g.meta.name })
      st.greeted = true
      st.greetedCount = g.sent
      store.save()
      log(`进房问候完成：${g.sent}/${cfg.templateGreetingCount} 条`)
      return
    }
    g.lastAt = Date.now()
    const text = g.queue.shift()
    const r = await sendChat(g.meta, text, '问候')
    if (r.ok) g.sent += 1
    else if (!r.message.includes('冷却')) g.queue.shift() // 失败就丢掉这条，避免卡住
  }

  /* ── 点赞：每 10 分钟一轮 300 次，按房间策略切批 ── */
  async function runLikeRound(meta, { clicks = cfg.likeClicksPerRound, reason = '' } = {}) {
    if (!cfg.taskLike || rt.likeRunning) return
    const cred = loadCred()
    if (!cred) return
    rt.likeRunning = true
    const tag = reason || meta.name || meta.realRoomId
    try {
      const policy = await getLikePolicy(cred, meta.realRoomId)
      if (!policy.ok) { log(`点赞策略读取失败（${tag}）：${describeError(policy.code, policy.message)}`); return }
      if (policy.data?.clickBlock) { log(`房间不允许点赞（${tag}），跳过`); return }
      const batch = Math.max(1, Math.min(15, Number(policy.data?.reportClickLimit) || 15))
      const gap = Math.max(5, Math.min(60, Number(policy.data?.reportTimeMin) || 5)) * 1000
      await enterRoom(cred, meta.realRoomId)
      let left = Math.max(1, Math.min(3000, Number(clicks) || 300))
      let sent = 0
      while (left > 0) {
        if (Date.now() < rt.pausedUntil) { log('风控暂停中，停止本轮点赞'); break }
        const n = Math.min(batch, left)
        const r = await clickLike(cred, meta.realRoomId, meta.mid, n)
        if (!r.ok) {
          logErr(`点赞失败（${tag}）：${describeError(r.code, r.message)}`)
          if (isRiskCode(r.code)) rt.pausedUntil = Date.now() + RISK_PAUSE_MS
          break
        }
        sent += n
        left -= n
        store.markLike(meta.realRoomId, n)
        store.save()
        if (left > 0) await sleep(gap + jitter(300, 1500))
      }
      if (sent) log(`点赞完成（${tag}）：本轮 ${sent} 次`)
    } finally {
      rt.likeRunning = false
      rt.lastLikeAt = Date.now()
    }
  }

  /* ── 打赏：每房每天 1 个 1 电池粉丝团灯牌（余额不足跳过，不自动充值） ── */
  async function runGift(meta) {
    if (!cfg.taskGift) return
    const st = store.ensureRoom(meta.realRoomId, { mid: meta.mid, name: meta.name })
    if (st.giftDone) return
    const cred = loadCred()
    if (!cred) return
    try {
      const doneToday = store.roomsToday().filter((x) => x.giftState === 'done').length
      if (doneToday >= cfg.giftMaxPerDay) {
        store.markGift(meta.realRoomId, 'disabled')
        store.save()
        log(`今日打赏次数已达上限（${cfg.giftMaxPerDay}），跳过 ${meta.name || meta.realRoomId}`)
        return
      }
      const wallet = await getWallet(cred)
      if (!wallet.ok) { store.markGift(meta.realRoomId, 'failed'); store.save(); logErr(`余额查询失败：${describeError(wallet.code, wallet.message)}`); return }
      const gold = Number(wallet.data?.gold) || 0
      rt.giftBalance = { gold, silver: Number(wallet.data?.silver) || 0, at: Date.now() }
      const conf = await getGiftConfig(cred, meta.realRoomId)
      if (!conf.ok) { store.markGift(meta.realRoomId, 'failed'); store.save(); return }
      const list = findGift(conf.data?.list || [], cfg.giftName, { maxPrice: cfg.giftMaxPrice, coinType: 'gold' })
      // P0 实测成功的是 gift_id=31164；同名同价的礼物可能有多条，优先用实测 id，其次按价格升序取第一条
      const gift = list.find((g) => String(g.id) === '31164') || list[0]
      if (!gift) { store.markGift(meta.realRoomId, 'disabled'); store.save(); log(`找不到「${cfg.giftName}」（≤${cfg.giftMaxPrice} 金瓜子），跳过`); return }
      if (gold < Number(gift.price)) {
        store.markGift(meta.realRoomId, 'skipped_balance')
        store.save()
        log(`电池不足（gold=${gold}，需要 ${gift.price}），跳过 ${meta.name || meta.realRoomId} 的灯牌`)
        return
      }
      const r = await sendGift(cred, meta.realRoomId, meta.mid, gift.id, gift.price)
      if (r.ok) {
        store.markGift(meta.realRoomId, 'done', { giftId: gift.id, price: gift.price })
        store.save()
        rt.giftBalance = { ...(rt.giftBalance || {}), gold: gold - Number(gift.price), at: Date.now() }
        log(`打赏完成（${meta.name || meta.realRoomId}）：「${cfg.giftName}」${gift.price} 金瓜子`)
      } else {
        store.markGift(meta.realRoomId, 'failed')
        store.save()
        logErr(`打赏失败（${meta.name || meta.realRoomId}）：${describeError(r.code, r.message)}`)
      }
    } catch (e) {
      store.markGift(meta.realRoomId, 'failed')
      store.save()
      logErr(`打赏异常：${String(e?.message || e)}`)
    }
  }

  /* ── AI 弹幕（两种模式） ──
   * follow  （默认）跟风复读：LLM 读时间窗口内的弹幕流，挑「正在被刷屏」的那一句原样复制；
   *           模型不可用/没挑出来时，用本地计数兜底（窗口内出现次数 ≥ aiFollowMinCount）。
   * generate         自由生成：根据房间标题 + 最近弹幕自己写一句。
   */
  function aiCountOf(realRoomId) { return Number(rt.aiSent[realRoomId]) || 0 }

  /** 弹幕文本归一化：去零宽字符、压缩空白、截断 */
  function normalizeChatText(text) {
    return String(text || '')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
  }

  /** 跟风复读窗口：从最近弹幕里筛出可复制的候选（排除自己的、@、链接、广告） */
  function followWindowMessages(now = Date.now(), windowMs = cfg.aiFollowWindowMs, extra = null) {
    const from = now - Math.max(5000, windowMs)
    const list = Array.isArray(extra) ? extra : (rt.danmaku?.recent || [])
    const myUid = String(loadCred()?.dedeuserid || '')
    const out = []
    for (const x of list) {
      if (!extra && Number(x.at) < from) continue
      if (myUid && String(x.uid || '') === myUid) continue
      const text = normalizeChatText(x && typeof x === 'object' ? (x.text ?? '') : x)
      if (!text) continue
      if (text.length > cfg.maxLen) continue
      if (/@|https?:\/\/|www\.|加群|抽奖|加微信|QQ群|代练/i.test(text)) continue
      out.push(text)
    }
    return out
  }

  /** 本地计数：窗口内出现次数最多、且达到阈值的文本（LLM 不可用/没挑出来时兜底） */
  function localFollowTop(messages, minCount = cfg.aiFollowMinCount) {
    const counts = new Map()
    for (const text of messages) counts.set(text, (counts.get(text) || 0) + 1)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const top = sorted[0] || null
    return {
      total: messages.length,
      top: sorted.slice(0, 8).map(([text, count]) => ({ text, count })),
      text: top && top[1] >= Math.max(2, minCount) ? top[0] : '',
      count: top ? top[1] : 0,
    }
  }

  /** 跟风复读：让 LLM 在候选里挑「正在被刷屏、最适合跟」的一句；校验不通过就本地兜底 */
  async function generateFollowDanmaku(extraMessages = null) {
    const stat = localFollowTop(followWindowMessages(Date.now(), cfg.aiFollowWindowMs, extraMessages))
    if (stat.total < 3) return { text: '', stat, why: '窗口内弹幕太少' }
    if (llm.available && stat.top.length) {
      const lines = stat.top.map((x) => `${x.count}× 「${x.text}」`).join('\n')
      const prompt = [
        `你在 B站 直播间里当观众。下面是最近 ${Math.round(cfg.aiFollowWindowMs / 1000)} 秒弹幕的统计（格式：出现次数× 原文）：`,
        lines,
        '',
        '请挑出「当前大家正在跟着刷」的那一句，原样输出它的文本（不要加次数、不要加引号、不要解释、不要修改字符）。',
        `只有在窗口内重复 ≥${cfg.aiFollowMinCount} 次、且明显是在跟风刷屏时才输出；否则只输出 NONE。`,
        '不要输出 @ 任何人、不要输出链接或广告。只输出一句话或 NONE。',
      ].join('\n')
      const raw = await llm.generate({
        prompt,
        // 思考模型会先花 reasoning token；低推理强度下 1000 足够，实际输出仍被 maxLen 截断。
        maxTokens: 1000,
        timeoutMs: 30000,
        onError: (e) => log(`跟风弹幕没接上模型：${String(e?.message || e)}`),
      })
      const pick = normalizeChatText(raw)
      if (pick && pick !== 'NONE' && pick.length <= Math.max(20, cfg.maxLen)) {
        const hit = stat.top.find((x) => x.text === pick)
        if (hit && hit.count >= Math.max(2, cfg.aiFollowMinCount)) return { text: pick, stat, why: `LLM 选中（${hit.count} 次）` }
        log(`跟风弹幕：模型返回「${pick}」但不在候选里，改用本地计数`)
      }
    }
    return { text: stat.text, stat, why: stat.text ? `本地计数（${stat.count} 次）` : '没有明显刷屏' }
  }

  /** 自由生成：根据房间标题 + 最近弹幕自己写一句（旧逻辑，保留作可选模式） */
  async function generateAiDanmaku() {
    const m = rt.main
    if (!m || !llm.available) return ''
    const recent = (rt.danmaku?.recent || []).slice(-30)
    const context = recent.map((x) => `${x.name}：${x.text}`).join('\n')
    const prompt = [
      `你在 B站 直播间「${m.name || ''}」看直播。直播标题：${m.title || '（没写）'}。现在是北京时间 ${beijingClock()}。`,
      context ? `最近的弹幕：\n${context}` : '现在还没什么弹幕。',
      '',
      `请用 8~${cfg.maxLen} 个中文字发一条自然的观众弹幕，像真人随口说一句：聊直播内容、接一下气氛都行。`,
      '不要 @ 任何人、不要引战、不要刷屏、不要提 AI 或机器人、不要加引号、不要解释。只输出这句话本身。',
      (rt.sentTexts || []).length ? `不要和这些已经发过的重复：${rt.sentTexts.slice(-10).join(' / ')}` : '',
    ].filter(Boolean).join('\n')
    const text = await llm.generate({
      prompt,
      // 思考模型会先花 reasoning token：小额度会被吃光、返回空串（旧插件踩过）。
      // 弹幕本身只有 ≤20 字，预算给到 1000；实际输出仍然被 maxLen 截断。
      maxTokens: 1000,
      timeoutMs: 30000,
      onError: (e) => log(`AI 弹幕没接上模型：${String(e?.message || e)}`),
    })
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxLen)
  }

  async function maybeAiDanmaku() {
    const m = rt.main
    if (!m || !cfg.aiDanmaku) return
    const follow = cfg.aiDanmakuMode !== 'generate'
    if (follow ? !rt.danmaku : !llm.available) return
    if (Date.now() - rt.lastAiAt < cfg.aiDanmakuMs) return
    const st = store.ensureRoom(m.realRoomId, { mid: m.mid, name: m.name })
    if (aiCountOf(m.realRoomId) >= cfg.aiDanmakuDailyMax) return
    if (st.danmakuCount >= cfg.danmakuDailyMax) return
    if (Date.now() - rt.lastDanmakuSentAt < cfg.danmakuCooldownMs) return
    if (Date.now() < rt.pausedUntil) return
    rt.lastAiAt = Date.now()
    let clipped = ''
    if (follow) {
      const r = await generateFollowDanmaku()
      clipped = r.text
      if (!clipped) { log(`跟风弹幕跳过：${r.why}`); return }
      log(`跟风弹幕候选：${r.stat.top.slice(0, 3).map((x) => `${x.text}×${x.count}`).join(' / ')}；选择「${clipped}」（${r.why}）`)
    } else {
      clipped = await generateAiDanmaku()
      if (!clipped) { log('AI 弹幕生成空结果（本轮跳过）'); return }
    }
    if (rt.lastAiText && rt.lastAiText === clipped) { log(`跟风弹幕与上次相同，跳过：「${clipped}」`); return }
    const r2 = await sendChat(m, clipped, follow ? '跟风弹幕' : 'AI 弹幕')
    if (r2.ok) {
      rt.aiSent[m.realRoomId] = aiCountOf(m.realRoomId) + 1
      rt.lastAiText = clipped
    }
  }

  /* ── 进 / 离主看房 ── */
  async function leaveMain(reason) {
    const m = rt.main
    if (!m) return
    if (reason) log(`离开主看房「${m.name || m.realRoomId}」（${reason}）`)
    rt.main = null
    rt.greet = null
    stopDanmaku()
    stopWatch()
    store.save()
  }

  async function enterMain(meta, reason) {
    if (!meta?.realRoomId) return
    if (rt.main && Number(rt.main.realRoomId) === Number(meta.realRoomId)) return
    await leaveMain('切换')
    rt.main = {
      mid: String(meta.mid || ''),
      name: String(meta.name || ''),
      roomId: Number(meta.roomId || meta.realRoomId),
      realRoomId: Number(meta.realRoomId),
      title: String(meta.title || ''),
      since: Date.now(),
      reason: String(reason || ''),
    }
    rt.lastLikeAt = 0
    rt.lastAiAt = 0
    store.ensureRoom(meta.realRoomId, { mid: String(meta.mid || ''), name: String(meta.name || '') })
    store.save()
    log(`进入主看房 ${meta.realRoomId}「${meta.name || '?'}」${meta.title ? '：' + meta.title : ''}（${reason || '自动'}）`)
    {
      const cred = loadCred()
      if (cred) await enterRoom(cred, meta.realRoomId).catch(() => {})
    }
    startDanmaku(rt.main)
    startWatch(rt.main)
    startGreeting(rt.main)
    if (cfg.taskGift) runGift(rt.main).catch(() => {})
    if (cfg.taskLike) runLikeRound(rt.main, { reason: '进房首轮' }).catch(() => {})
  }

  /* ── 巡视补任务（不打断主看房） ── */
  async function visitTaskRoom(meta, need) {
    if (rt.visiting) return
    rt.visiting = { mid: meta.mid, name: meta.name, realRoomId: meta.realRoomId, why: [], since: Date.now() }
    if (need.danmaku) rt.visiting.why.push('弹幕')
    if (need.like) rt.visiting.why.push('点赞')
    if (need.gift) rt.visiting.why.push('打赏')
    log(`去「${meta.name || meta.realRoomId}」补任务：${rt.visiting.why.join('、')}`)
    try {
      const cred = loadCred()
      if (!cred) return
      await enterRoom(cred, meta.realRoomId)
      if (need.danmaku) {
        const st = store.ensureRoom(meta.realRoomId, { mid: meta.mid, name: meta.name })
        if (!st.danmakuDone) {
          const pool = (cfg.greetingTemplates || []).filter(Boolean)
          const text = pool[Math.floor(Math.random() * pool.length)] || '来了'
          await sendChat(meta, text, '补任务弹幕')
        }
      }
      if (need.like) await runLikeRound(meta, { reason: '补任务' })
      if (need.gift) await runGift(meta)
    } catch (e) {
      logErr(`补任务失败（${meta.name || meta.realRoomId}）：${String(e?.message || e)}`)
    } finally {
      rt.visiting = null
    }
  }

  async function sweepTasks() {
    if (!cfg.enabled || !loadCred() || rt.visiting) return
    for (const s of enabledStreamers()) {
      if (!isLive(s.mid)) continue
      if (rt.main && String(rt.main.mid) === String(s.mid)) continue
      const live = liveOf(s.mid)
      if (!live?.realRoomId) continue
      const meta = { mid: s.mid, name: live.uname || s.name, roomId: live.roomId, realRoomId: live.realRoomId, title: live.title }
      const st = store.ensureRoom(meta.realRoomId, { mid: s.mid, name: meta.name })
      const need = {
        danmaku: cfg.taskDanmaku && !st.danmakuDone,
        like: cfg.taskLike && !st.likeDone,
        gift: cfg.taskGift && !st.giftDone,
      }
      if (!need.danmaku && !need.like && !need.gift) continue
      void visitTaskRoom(meta, need).catch(() => {})
      break // 一次只补一个房间，剩下的下一轮心跳再说
    }
  }

  /* ── 手动计划（一次性） ── */
  function pendingPlans() { return (cfg.plans || []).filter((p) => p.status === 'pending') }

  async function resolvePlanRoom(plan) {
    const cred = loadCred()
    if (!cred) return null
    { const s = streamerByMid(plan.mid); if (s) { const live = liveOf(s.mid); if (live?.realRoomId) return { mid: s.mid, name: live.uname || s.name, roomId: live.roomId, realRoomId: live.realRoomId, title: live.title, liveStatus: live.liveStatus } } }
    try {
      const info = plan.mid ? await getRoomByUid(plan.mid, cred) : await getRoomInfo(plan.roomId, cred)
      const realRoomId = Number(info.realRoomId || info.roomId || 0)
      if (!realRoomId) return null
      return { mid: String(plan.mid || info.uid || ''), name: info.uname || plan.name || '', roomId: Number(info.roomId || realRoomId), realRoomId, title: info.title || '', liveStatus: Number(info.liveStatus) || 0 }
    } catch { return null }
  }

  async function processPlans() {
    const now = Date.now()
    const pending = pendingPlans()
    // 正在等待开播的计划
    if (rt.waiting) {
      const plan = rt.waiting.plan
      const room = await resolvePlanRoom(plan)
      if (room) { rt.waiting.meta = room }
      if (room?.liveStatus === 1) {
        rt.waiting = null
        plan.status = 'fired'
        saveCfg()
        await enterMain(room, '手动计划开播')
        return
      }
      if (now - rt.waiting.enterAt > PLAN_GRACE_MS) {
        plan.status = 'missed'
        saveCfg()
        rt.waiting = null
        log(`计划未等到开播（${plan.name || plan.mid}），标记 missed`)
      }
      return
    }
    if (!pending.length) return
    // 早于「提前 10 分钟」的计划不处理；到窗口的计划取最早的一条
    const due = pending.filter((p) => Date.parse(p.at) - PLAN_PRE_MS <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
    if (!due) return
    const room = await resolvePlanRoom(due)
    if (!room) { due.status = 'missed'; saveCfg(); log(`计划失败：找不到直播间（${due.name || due.mid}）`); return }
    if (room.liveStatus === 1) {
      due.status = 'fired'
      saveCfg()
      await enterMain(room, '手动计划')
      return
    }
    // 未开播：提前进房等待（到点后最多等 10 分钟）
    rt.waiting = { plan: due, meta: room, enterAt: Date.now() }
    log(`手动计划：提前进入「${due.name || due.mid}」房间等待开播（当前未播）`)
  }

  /* ── 自动选台 ── */
  async function autoSelect() {
    if (!cfg.autoEnabled) return
    if (rt.waiting) return // 正在等计划开播时不抢台
    // 只有「即将进入窗口」的手动计划才让自动模式让路；远期计划不影响自动值守
    const soon = pendingPlans().some((p) => Date.parse(p.at) - PLAN_PRE_MS <= Date.now() + 5 * 60_000)
    if (soon) return
    if (!inWorkHours(cfg.workHours, Date.now(), cfg.workHoursTz)) return
    const pick = enabledStreamers().find((s) => isLive(s.mid))
    if (!pick) return
    const live = liveOf(pick.mid)
    if (!live?.realRoomId) return
    if (rt.main && Number(rt.main.realRoomId) === Number(live.realRoomId)) return
    await enterMain({ mid: pick.mid, name: live.uname || pick.name, roomId: live.roomId, realRoomId: live.realRoomId, title: live.title }, '自动模式')
  }

  /* ── 主看房还在播吗 ── */
  async function ensureMainAlive() {
    const m = rt.main
    if (!m) return
    const cred = loadCred()
    if (!cred) return
    try {
      const info = await getRoomInfo(m.realRoomId, cred)
      if (Number(info.liveStatus) !== 1) {
        log(`「${m.name || m.realRoomId}」下播了`)
        await leaveMain('主播下播')
        rt.lastAutoCheckAt = 0 // 让自动模式下一轮立即重新选台
      } else if (info.title) {
        m.title = info.title
      }
    } catch (e) {
      log(`主看房状态检查失败：${String(e?.message || e)}`)
    }
  }

  /* ── 统一心跳：所有定时判断都在这里 ── */
  async function heartbeat() {
    if (!cfg.enabled) return
    if (rt.heartbeatBusy) return
    rt.heartbeatBusy = true
    try {
    const cred = loadCred()
    if (!cred) {
      if (rt.main) await leaveMain('没有登录凭证')
      return
    }
    try {
      const now = Date.now()
      store.roll(now)
      if (now - rt.lastLiveRefreshAt > LIVE_REFRESH_MS) await refreshLive()
      await processPlans()
      if (now - rt.lastAutoCheckAt >= AUTO_CHECK_MS) {
        rt.lastAutoCheckAt = now
        rt.nextAutoCheckAt = now + AUTO_CHECK_MS
        await refreshLive(true)
        if (!rt.waiting && !rt.main) await autoSelect()
      }
      if (rt.main && now - rt.lastAliveCheckAt > MAIN_ALIVE_MS) {
        rt.lastAliveCheckAt = now
        await ensureMainAlive()
      }
      if (rt.main) {
        // 拉流断了就重连
        if (rt.watch && !rt.watch.running) startWatch(rt.main)
        if (rt.watch) {
          const dt = Math.max(0, Math.round((now - rt.watch.lastTickAt) / 1000))
          if (dt > 0) { store.markWatch(rt.main.realRoomId, dt); rt.watch.lastTickAt = now; store.save() }
        }
        await stepGreeting()
        await maybeAiDanmaku()
        if (cfg.taskLike && now - rt.lastLikeAt >= cfg.likeRoundMs && !rt.likeRunning) {
          void runLikeRound(rt.main, { reason: '周期点赞' }).catch(() => {})
        }
      }
      if (now - rt.lastSweepAt > TASK_SWEEP_MS) {
        rt.lastSweepAt = now
        // 自动巡视只在工作时间做；手动计划/主看房自己的任务不受影响
        if (inWorkHours(cfg.workHours, now, cfg.workHoursTz)) void sweepTasks().catch(() => {})
      }
    } catch (e) {
      logErr(`心跳异常：${String(e?.message || e)}`)
    }
    } finally {
      rt.heartbeatBusy = false
    }
  }

  /* ── HTTP 路由 ── */
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && path.endsWith('/status')) {
      const cred = loadCred()
      const tasks = cfg.streamers.map((s) => {
        const live = liveOf(s.mid)
        const realRoomId = Number(live?.realRoomId || s.roomId || 0)
        const st = realRoomId ? store.ensureRoom(realRoomId, { mid: s.mid, name: live?.uname || s.name }) : null
        return {
          mid: s.mid,
          name: live?.uname || s.name,
          roomId: Number(s.roomId || live?.roomId || 0),
          realRoomId,
          enabled: s.enabled !== false,
          liveStatus: Number(live?.liveStatus) || 0,
          liveTitle: live?.title || '',
          online: Number(live?.online) || 0,
          watchMins: st ? Math.round((st.watchedSec || 0) / 60) : 0,
          danmakuDone: Boolean(st?.danmakuDone),
          danmakuCount: Number(st?.danmakuCount) || 0,
          likeDone: Boolean(st?.likeDone),
          likeClicks: Number(st?.likeClicks) || 0,
          giftDone: Boolean(st?.giftDone),
          giftState: st?.giftState || '',
          lastActionAt: st?.lastDanmakuAt || st?.lastLikeAt || st?.lastGiftAt || 0,
          error: (st?.errors || [])[0] || '',
        }
      })
      return sendJson(res, 200, {
        ok: true,
        version,
        home,
        login: {
          loggedIn: Boolean(cred),
          uid: String(cred?.dedeuserid || ''),
          uname: String(cred?.uname || ''),
        },
        config: cfg,
        streamers: tasks,
        mode: {
          auto: cfg.autoEnabled !== false,
          inWorkHours: inWorkHours(cfg.workHours, Date.now(), cfg.workHoursTz),
          workHoursTz: cfg.workHoursTz || 'beijing',
          nextCheckAt: rt.nextAutoCheckAt || 0,
          workHours: cfg.workHours,
        },
        main: rt.main ? { mid: rt.main.mid, name: rt.main.name, roomId: rt.main.realRoomId, title: rt.main.title, since: rt.main.since } : null,
        waiting: rt.waiting ? { mid: rt.waiting.plan?.mid, name: rt.waiting.plan?.name, at: rt.waiting.plan?.at } : null,
        visiting: rt.visiting ? { mid: rt.visiting.mid, name: rt.visiting.name, roomId: rt.visiting.realRoomId, why: rt.visiting.why.join('、'), since: rt.visiting.since } : null,
        plans: (cfg.plans || []).map((p) => ({ id: p.id, mid: p.mid, name: p.name, at: p.at, status: p.status })),
        tasks,
        giftBalance: rt.giftBalance,
        llm: { available: llm.available, ...llm.route() },
        danmakuStatus: rt.danmakuStatus,
        logs: logs.slice(-cfg.logMaxLines),
        lastError: rt.lastError,
        state: { day: beijingDateKey(), pausedUntil: rt.pausedUntil },
      })
    }

    if (req.method === 'POST' && path.endsWith('/config')) {
      const patch = await readBody(req)
      Object.assign(cfg, mergeConfig(cfg, patch))
      saveCfg()
      rt.lastAutoCheckAt = 0
      log('配置已更新')
      return sendJson(res, 200, { ok: true, config: cfg })
    }

    if (req.method === 'POST' && path.endsWith('/streamers')) {
      const body = await readBody(req)
      const action = String(body.action || '')
      if (action === 'add') {
        if (cfg.streamers.length >= 5) return sendJson(res, 200, { ok: false, error: '最多 5 个主播' })
        const s = normalizeStreamer(body.streamer || {})
        if (!s) return sendJson(res, 200, { ok: false, error: '需要主播 UID 或房间号' })
        if (cfg.streamers.some((x) => String(x.mid) === String(s.mid) && s.mid)) return sendJson(res, 200, { ok: false, error: '这个 UID 已经在名单里' })
        s.order = cfg.streamers.length
        cfg.streamers.push(s)
      } else if (action === 'remove') {
        const mid = String(body.mid || '')
        const rid = String(body.roomId || '')
        cfg.streamers = cfg.streamers.filter((x) => {
          if (mid) return String(x.mid) !== mid
          if (rid) return String(x.roomId) !== rid
          return true
        })
      } else if (action === 'move') {
        const i = cfg.streamers.findIndex((x) => String(x.mid) === String(body.mid))
        const to = Number(body.to)
        if (i >= 0 && Number.isInteger(to) && to >= 0 && to < cfg.streamers.length) {
          const [x] = cfg.streamers.splice(i, 1)
          cfg.streamers.splice(to, 0, x)
        }
      } else if (action === 'update') {
        const s = cfg.streamers.find((x) => String(x.mid) === String(body.mid))
        if (s && body.streamer) Object.assign(s, normalizeStreamer({ ...s, ...body.streamer, mid: s.mid, id: s.id }))
      }
      cfg.streamers.forEach((s, i) => { s.order = i })
      saveCfg()
      return sendJson(res, 200, { ok: true, config: cfg, streamers: cfg.streamers })
    }

    if (req.method === 'POST' && path.endsWith('/resolve')) {
      const body = await readBody(req)
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证' })
      const mid = String(body.mid || '').replace(/\D/g, '')
      const roomId = String(body.roomId || '').replace(/\D/g, '')
      try {
        const info = mid ? await getRoomByUid(mid, cred) : await getRoomInfo(roomId, cred)
        const realRoomId = Number(info.realRoomId || info.roomId || 0)
        if (!realRoomId) return sendJson(res, 200, { ok: false, error: '没找到直播间' })
        return sendJson(res, 200, {
          ok: true,
          streamer: { mid: String(mid || info.uid || ''), roomId: String(realRoomId), name: info.uname || '', enabled: true },
          info: { uname: info.uname, title: info.title, liveStatus: info.liveStatus, realRoomId },
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message || e) })
      }
    }

    if (req.method === 'GET' && path.endsWith('/reserves')) {
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证（请先扫码登录）' })
      const r = await getReserveList(cred, { page: 1, pageSize: 50 })
      if (!r.ok) return sendJson(res, 200, { ok: false, error: describeError(r.code, r.message), code: r.code })
      const rawList = Array.isArray(r.data?.list) ? r.data.list : []
      const items = rawList.map(mapReserveItem).filter((x) => x.mid || x.roomId)
      return sendJson(res, 200, {
        ok: true,
        count: items.length,
        items,
        future: items.filter((x) => x.at && Date.parse(x.at) > Date.now()).length,
        debug: {
          rawCount: rawList.length,
          sampleKeys: rawList[0] && typeof rawList[0] === 'object' ? Object.keys(rawList[0]) : null,
        },
      })
    }

    if (req.method === 'POST' && path.endsWith('/plans')) {
      const body = await readBody(req)
      if (body.action === 'import') {
        const items = Array.isArray(body.items) ? body.items : []
        const plans = Array.isArray(cfg.plans) ? cfg.plans : []
        const keyOf = (mid, at) => `${String(mid)}|${Number(at)}`
        const seen = new Set(plans.map((p) => keyOf(p.mid, Date.parse(p.at))))
        const now = Date.now()
        let added = 0
        let skipped = 0
        for (const it of items) {
          const mid = String(it?.mid || '').replace(/\D/g, '')
          const at = Date.parse(String(it?.at || ''))
          if (!mid || !Number.isFinite(at) || at <= now) { skipped += 1; continue }
          const k = keyOf(mid, at)
          if (seen.has(k)) { skipped += 1; continue }
          if (plans.length >= 50) { skipped += 1; continue }
          seen.add(k)
          plans.push({
            id: `plan-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            mid,
            name: String(it?.name || ''),
            at: new Date(at).toISOString(),
            createdAt: nowIso(),
            status: 'pending',
          })
          added += 1
        }
        cfg.plans = plans
        saveCfg()
        log(`从预约导入计划：新增 ${added} 条，跳过 ${skipped} 条`)
        return sendJson(res, 200, { ok: true, added, skipped, plans: cfg.plans })
      }
      if (body.action === 'add') {
        const at = Date.parse(body.plan?.at)
        if (!Number.isFinite(at)) return sendJson(res, 200, { ok: false, error: '时间格式不对' })
        if (at < Date.now() - 60_000) return sendJson(res, 200, { ok: false, error: '这个时间已经过去了' })
        if ((cfg.plans || []).length >= 50) return sendJson(res, 200, { ok: false, error: '计划太多了' })
        const s = streamerByMid(body.plan?.mid)
        cfg.plans.push({
          id: `plan-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          mid: String(body.plan?.mid || ''),
          name: String(body.plan?.name || s?.name || ''),
          at: new Date(at).toISOString(),
          createdAt: nowIso(),
          status: 'pending',
        })
        saveCfg()
        return sendJson(res, 200, { ok: true, plans: cfg.plans })
      }
      if (body.action === 'remove') {
        cfg.plans = (cfg.plans || []).filter((p) => p.id !== body.id)
        saveCfg()
        return sendJson(res, 200, { ok: true, plans: cfg.plans })
      }
      if (body.action === 'clear') {
        cfg.plans = []
        saveCfg()
        return sendJson(res, 200, { ok: true, plans: [] })
      }
      return sendJson(res, 200, { ok: false, error: 'unknown action' })
    }

    if (req.method === 'POST' && path.endsWith('/tick')) {
      rt.lastAutoCheckAt = 0
      await heartbeat()
      return sendJson(res, 200, { ok: true, main: rt.main, lastError: rt.lastError })
    }

    if (req.method === 'POST' && path.endsWith('/stop')) {
      await leaveMain('手动停止')
      rt.waiting = null
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path.endsWith('/task-run')) {
      const body = await readBody(req)
      const mid = String(body.mid || '')
      const s = streamerByMid(mid)
      const live = liveOf(mid)
      const realRoomId = Number(body.roomId || live?.realRoomId || s?.roomId || 0)
      const meta = { mid, name: live?.uname || s?.name || '', roomId: Number(live?.roomId || realRoomId), realRoomId, title: live?.title || '' }
      if (!realRoomId) return sendJson(res, 200, { ok: false, error: '没有房间号' })
      const task = String(body.task || 'all')
      try {
        if (task === 'danmaku' || task === 'all') {
          const text = (cfg.greetingTemplates[0] || '来了')
          await sendChat(meta, text, '手动测试')
        }
        if (task === 'like' || task === 'all') await runLikeRound(meta, { clicks: Math.min(30, cfg.likeClicksPerRound), reason: '手动测试' })
        if (task === 'gift' || task === 'all') await runGift(meta)
        if (task === 'watch' || task === 'all') {
          if (!rt.main) await enterMain(meta, '手动测试')
        }
        return sendJson(res, 200, { ok: true, task })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message || e) })
      }
    }

    /* 扫码登录 */
    if (req.method === 'POST' && path.endsWith('/login/qr')) {
      try {
        const { key, url } = await generateQr()
        rt.qr = { key, at: Date.now() }
        const svg = qrSvg(join(pluginDir, 'vendor', 'qrcode.js'), url)
        log('出了一张登录二维码，等扫码')
        return sendJson(res, 200, { ok: true, key, svg })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message || e) })
      }
    }

    if (req.method === 'POST' && path.endsWith('/login/poll')) {
      const body = await readBody(req)
      const key = String(body.key || rt.qr?.key || '')
      if (!key) return sendJson(res, 200, { ok: false, error: '还没有二维码' })
      try {
        const r = await pollQr(key)
        if (r.status !== 'ok') return sendJson(res, 200, { ok: true, status: r.status, message: r.message || '' })
        const me = await whoAmI(r.cred)
        saveOwnCred({ ...r.cred, uname: me?.uname || '' })
        rt.credAlive = { at: Date.now(), alive: true, name: me?.uname || '' }
        rt.qr = null
        log(`扫码登录成功：${me?.uname || r.cred.dedeuserid || '?'}`)
        rt.lastLiveRefreshAt = 0
        rt.lastAutoCheckAt = 0
        return sendJson(res, 200, { ok: true, status: 'ok', uname: me?.uname || '', mid: me?.mid || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, status: 'error', error: String(e?.message || e) })
      }
    }

    if (req.method === 'POST' && path.endsWith('/logout')) {
      try { if (existsSync(credFile)) unlinkSync(credFile) } catch { /* 忽略 */ }
      try { writeFileSync(loggedOutFile, JSON.stringify({ at: nowIso() })) } catch { /* 忽略 */ }
      rt.qr = null
      rt.credAlive = { at: 0, alive: null, name: '' }
      await leaveMain('退出登录')
      log('已退出登录（插件自己的凭证已删）')
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path.endsWith('/ai-test')) {
      const body = await readBody(req)
      const samples = Array.isArray(body.samples)
        ? body.samples.map((x) => (typeof x === 'string' ? x : x?.text)).filter(Boolean)
        : null
      const mode = cfg.aiDanmakuMode === 'generate' ? 'generate' : 'follow'
      const t0 = Date.now()
      if (mode === 'follow') {
        const r = await generateFollowDanmaku(samples)
        return sendJson(res, 200, {
          ok: Boolean(r.text),
          mode,
          text: r.text,
          why: r.why,
          windowSec: Math.round(cfg.aiFollowWindowMs / 1000),
          minCount: cfg.aiFollowMinCount,
          local: { total: r.stat.total, top: r.stat.top },
          main: rt.main ? rt.main.name : null,
          ms: Date.now() - t0,
        })
      }
      if (!llm.available) return sendJson(res, 200, { ok: false, error: '宿主没有提供 llm 服务' })
      const text = await generateAiDanmaku().catch(() => '')
      return sendJson(res, 200, { ok: Boolean(text), mode, text, main: rt.main ? rt.main.name : null, ms: Date.now() - t0 })
    }

    if (req.method === 'POST' && path.endsWith('/llm-test')) {
      if (!llm.available) return sendJson(res, 200, { ok: false, error: '宿主没有提供 llm 服务' })
      let why = ''
      const t0 = Date.now()
      const text = await llm.generate({
        prompt: '只回复两个字：收到',
        maxTokens: 600,
        timeoutMs: 30000,
        onError: (e) => { why = String(e?.message || e) },
      })
      return sendJson(res, 200, { ok: Boolean(text), text, error: why, ms: Date.now() - t0, ...llm.route() })
    }

    if (req.method === 'POST' && path.endsWith('/open-folder')) {
      const dir = home
      try {
        const isWin = process.platform === 'win32'
        const bin = isWin ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const p = spawn(bin, [dir], { detached: true, stdio: 'ignore' })
        p.on('error', () => { /* 打不开就算了 */ })
        p.unref()
        return sendJson(res, 200, { ok: true, dir })
      } catch (e) {
        return sendJson(res, 200, { ok: false, dir, error: String(e?.message || e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-duty',
      handler: async (req, res) => {
        try { await handle(req, res) } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message || e) })
        }
      },
    }), 'bili-duty: /api/bili-duty 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${String(e?.message || e)}`)
  }

  rt.heartbeat = setInterval(() => { heartbeat().catch(() => {}) }, HEARTBEAT_MS)
  if (rt.heartbeat.unref) rt.heartbeat.unref()
  rt.nextAutoCheckAt = Date.now() + AUTO_CHECK_MS
  log(`已挂载（家=${home}，版本=${version || '?'}，主播=${cfg.streamers.length}，自动=${cfg.autoEnabled ? '开' : '关'}）`)

  ctx.effect(() => () => {
    if (rt.heartbeat) clearInterval(rt.heartbeat)
    rt.heartbeat = null
    try { rt.danmaku?.client?.stop() } catch { /* 收摊 */ }
    try { rt.watch?.ctl?.abort() } catch { /* 收摊 */ }
    store.save()
  }, 'bili-duty: 收摊')
}
