/**
 * dsh-bili-duty —— host 半端（个人定制版「直播值守」）
 * ============================================================================
 * 做什么：用你的 B站 账号，对固定的 5 个主播做「值守 + 粉丝团每日任务」。
 *   1. 自动模式：北京时间 08:00–24:00 每 15 分钟查一遍谁开播，进主看房挂着（陪伴）；
 *   2. 手动模式：你在设置页加一条「计划」（主播 + 开播时间），提前 10 分钟进房等待，
 *      到点仍未开播最多等 10 分钟；计划不受工作时间限制；
 *   3. 每日任务：观看直播（live-trace 心跳上报）、发送弹幕（进房问候 + AI 智能弹幕）、点赞
 *      （每 10 分钟一轮 300 次，按房间下发的批次/间隔上限切批）、打赏（每房每天
 *      1 个「粉丝团灯牌」，1 电池，余额不足跳过，不自动充值）；
 *   4. 其它在播主播有未完成任务时，异步去补任务（不打断主看房的观看上报与弹幕）。
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, mergeConfig, normalizeConfig, normalizeStreamer } from './lib/duty-config.mjs'
import { beijingDateKey, createStore } from './lib/duty-state.mjs'
import {
  clickLike,
  deleteDynamic,
  describeError,
  enterRoom,
  findGift,
  getGiftConfig,
  getLikePolicy,
  getSpaceDynamics,
  getWallet,
  isRiskCode,
  sendGift,
} from './lib/duty-actions.mjs'
import { getTraceRoom, getWatchTaskProgress, watchTrace } from './lib/duty-trace.mjs'
import { extractCardReserve, parseLiveCard } from './lib/duty-card.mjs'
import { DanmakuClient, getRoomByUid, getRoomInfo, sendDanmaku } from './lib/live.mjs'
import { generateQr, pollQr, qrSvg, whoAmI } from './lib/auth.mjs'
import { makeLlm } from './lib/llm.mjs'
import { prunePlans, rotateLogIfNeeded } from './lib/duty-clean.mjs'
import { ATTACH_KEEP_DAYS, readTrack, sweepPluginAttachments, trackPath, trackSavedAttachment } from './lib/duty-attach.mjs'

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
const RUNTIME_SWEEP_MS = 6 * 3600_000 // 运行时文件清理（附件/tmp）每 6 小时一轮

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
  // tmp + rename：进程被杀时不会留下半截 JSON / 脏 .tmp
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
  }
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


/** 预约卡解析失败时，把 additional 原文带出来，便于以后适配新字段 */
function additionalDebug(item) {
  const add = item?.orig?.modules?.module_dynamic?.additional || item?.modules?.module_dynamic?.additional
  if (!add) return ''
  try { return JSON.stringify(add).slice(0, 1500) } catch { return '' }
}

/** 把 B站 动态 item 归一成 {id,type,publishedAt,text,images,author,forward}；转发动态会合并 orig 原文 */
function mapDynamicItem(it) {
  const o = it && typeof it === 'object' ? it : {}
  const readSide = (side) => {
    const md = side?.modules?.module_dynamic || {}
    const au = side?.modules?.module_author || {}
    const text = String(md.desc?.text || md.major?.opus?.summary?.text || '').trim()
    const picList = md.major?.draw?.items || md.major?.opus?.pics || []
    const images = picList
      .map((x) => ({ url: String(x?.src || x?.url || ''), width: Number(x?.width) || 0, height: Number(x?.height) || 0 }))
      .filter((x) => x.url)
    let card = ''
    try {
      const rawCard = md.major?.live_rcmd?.content
      if (rawCard) card = typeof rawCard === 'string' ? rawCard : JSON.stringify(rawCard)
    } catch { /* 卡片坏了不影响 */ }
    return {
      text,
      images,
      author: { mid: String(au.mid || ''), name: String(au.name || '') },
      card: String(card || '').slice(0, 1200),
    }
  }
  const own = readSide(o)
  const orig = o.orig ? readSide(o.orig) : null
  const ownPubSec = Number(o.modules?.module_author?.pub_ts)
  const pubMs = Number.isFinite(ownPubSec) && ownPubSec > 0
    ? ownPubSec * 1000
    : Date.parse(String(o.modules?.module_author?.pub_time || '')) || 0
  const parts = []
  if (own.text && own.text !== '转发动态') parts.push(own.text)
  if (orig) {
    const head = `【转发自 ${orig.author.name || '未知主播'}】`
    if (orig.text) parts.push(head + orig.text)
    if (orig.card) parts.push(`${head}【预约/直播卡片】${orig.card}`)
  }
  const images = [...(own.images || []), ...((orig && orig.images) || [])]
  const reserve = extractCardReserve(o)
  return {
    id: String(o.id_str || o.id || ''),
    type: String(o.type || ''),
    publishedAt: pubMs,
    text: (parts.join('\n') || own.text || '').trim(),
    images,
    author: own.author,
    forward: orig ? { author: orig.author, text: orig.text, card: orig.card } : null,
    reserve,
    // 有卡片但解析失败时，把原始 content 带出来，便于以后适配字段
    debugCard: !reserve && (own.card || (orig && orig.card))
      ? String(own.card || (orig && orig.card)).slice(0, 1500)
      : (!reserve ? additionalDebug(o) : ''),
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

  // 启动清理：上次崩溃可能留下半截 .tmp；live.log 超限先轮转一次
  for (const f of [cfgFile, stateFile, credFile]) {
    try { if (existsSync(`${f}.tmp`)) unlinkSync(`${f}.tmp`) } catch { /* 清不掉就算了 */ }
  }
  try { rotateLogIfNeeded(logFile) } catch { /* 轮转失败不致命，继续写 */ }

  const cfg = normalizeConfig(readJson(cfgFile, DEFAULTS))
  const saveCfg = () => writeJson(cfgFile, cfg)
  const store = createStore(home)
  store.load()

  const logs = []
  let logWrites = 0
  const log = (msg) => {
    const line = `[${nowIso().slice(11, 19)}] ${msg}`
    logs.push(line)
    if (logs.length > MAX_LOGS) logs.shift()
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 不致命 */ }
    logWrites += 1
    // 每 200 行检查一次大小（约 16KB），超 512KB 就只留最后 400 行
    if (logWrites % 200 === 0) {
      try { rotateLogIfNeeded(logFile) } catch { /* 忽略 */ }
    }
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
    lastPlansPruneAt: 0,
    lastRuntimeSweepAt: 0,
    runtimeSweepBusy: false,
    runtime: null, // 最近一次运行时清理结果
    lastAttachTrack: null, // 最近一次图片附件跟踪结果（调试用）
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

  /* ── 运行时文件清理（插件自己写入的图片附件 + tmp） ── */
  const fmtBytes = (n) => {
    const v = Number(n) || 0
    if (v < 1024) return `${v}B`
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`
    return `${(v / 1024 / 1024).toFixed(1)}MB`
  }

  async function sweepRuntime() {
    if (rt.runtimeSweepBusy) return rt.runtime
    rt.runtimeSweepBusy = true
    try {
      const now = Date.now()
      const stats = sweepPluginAttachments({ home, dshHome: dirname(home), now })
      rt.lastRuntimeSweepAt = now
      rt.runtime = stats
      if (stats.deleted || stats.referenced || stats.deferred || stats.tmpRemoved || stats.invalid) {
        const parts = []
        if (stats.deleted) parts.push(`删除图片附件 ${stats.deleted} 个（${fmtBytes(stats.bytesFreed)}）`)
        if (stats.referenced) parts.push(`保留 ${stats.referenced} 个仍被会话引用`)
        if (stats.deferred) parts.push(`${stats.deferred} 个待下轮（会话扫描不完整）`)
        if (stats.invalid) parts.push(`忽略 ${stats.invalid} 个失效记录`)
        if (stats.tmpRemoved) parts.push(`清理临时文件 ${stats.tmpRemoved} 个（${fmtBytes(stats.tmpBytes)}）`)
        log(`运行时清理：${parts.join('，')}；附件保留 ${ATTACH_KEEP_DAYS} 天`)
      }
      return rt.runtime
    } catch (e) {
      logErr(`运行时清理失败：${String(e?.message || e)}`)
      return null
    } finally {
      rt.runtimeSweepBusy = false
    }
  }
  // 启动先清一轮（上次崩溃留下的 tmp / 过期的插件图片附件）
  void sweepRuntime().catch(() => {})

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

  /* ── 观看直播：live-trace E/X 心跳上报（进房/弹幕/拉流都不算观看时长） ── */
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
    const w = {
      roomId: meta.realRoomId, ctl, startedAt: Date.now(), running: true, finished: false,
      reportedSec: 0, intervalSec: 0, task: '', error: '', nextRetryAt: 0,
    }
    rt.watch = w
    log(`开始观看上报：房间 ${meta.realRoomId}（live-trace 心跳）`)
    ;(async () => {
      try {
        const room = await getTraceRoom(cred, meta.realRoomId)
        if (rt.watch !== w) return
        w.uid = room.uid
        w.intervalSec = 0
        // 今日观看任务已完成（每日上限 10 轮）就不再空挂心跳
        try {
          const task = await getWatchTaskProgress(cred, room.uid)
          w.task = task.subTitle || `${task.current}/${task.total}`
          if (task.total > 0 && task.current >= task.total) {
            w.finished = true
            w.running = false
            log(`今日观看任务已完成（${task.subTitle}），跳过观看上报`)
            return
          }
          if (task.subTitle) log(`今日观看任务进度：${task.subTitle}`)
        } catch (e) {
          log(`查观看任务进度失败：${String(e?.message || e)}`)
        }
        const r = await watchTrace({
          cred,
          room,
          signal: ctl.signal,
          onLog: (m) => { if (rt.watch === w) log(m) },
          onSession: ({ intervalSec }) => { if (rt.watch === w) w.intervalSec = intervalSec },
          onTick: (sec) => {
            if (rt.watch !== w) return
            w.reportedSec += sec
            store.markWatch(meta.realRoomId, sec)
            store.save()
          },
        })
        if (rt.watch === w) {
          w.running = false
          if (!r.aborted) {
            w.nextRetryAt = Date.now() + 60_000
            log(`观看上报中断：已上报 ${Math.round(r.watchedSec / 60)} 分钟（房间 ${meta.realRoomId}${r.reason ? '·' + r.reason : ''}），1 分钟后重试`)
          }
        }
      } catch (e) {
        if (rt.watch === w) {
          w.running = false
          w.error = String(e?.message || e)
          w.nextRetryAt = Date.now() + 60_000
          if (!ctl.signal.aborted) log(`观看上报异常：${w.error}（1 分钟后重试）`)
        }
      }
    })()
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

  /* ── 智能弹幕（两种模式） ──
   * follow  （默认）跟风复读：纯本地统计，不调用模型。从时间窗口内所有出现次数达到
   *           aiFollowMinCount 的原句中随机挑一句，原样复制；没有合格候选就不发。
   * generate         自由生成：根据房间标题 + 最近弹幕让 LLM 写一句（仅此模式需要模型）。
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

  /** 本地计数：返回频次排行 + 所有达到阈值的候选（候选按次数降序、同频次最近出现优先，仅供参考展示） */
  function localFollowTop(messages, minCount = cfg.aiFollowMinCount) {
    const stats = new Map()
    for (let i = 0; i < messages.length; i++) {
      const text = messages[i]
      const cur = stats.get(text)
      if (cur) { cur.count += 1; cur.lastIndex = i }
      else stats.set(text, { text, count: 1, lastIndex: i })
    }
    const sorted = [...stats.values()].sort((a, b) => b.count - a.count || b.lastIndex - a.lastIndex)
    const threshold = Math.max(2, minCount)
    const candidates = sorted.filter((x) => x.count >= threshold)
    return {
      total: messages.length,
      top: sorted.slice(0, 8).map(({ text, count }) => ({ text, count })),
      candidates: candidates.map(({ text, count }) => ({ text, count })),
      threshold,
      count: sorted[0] ? sorted[0].count : 0,
    }
  }

  /** 跟风复读：纯本地统计（不调用模型），从所有达到阈值的候选里随机挑一句（避免每轮都复读同一句） */
  function pickFollowDanmaku(extraMessages = null) {
    const stat = localFollowTop(followWindowMessages(Date.now(), cfg.aiFollowWindowMs, extraMessages))
    if (stat.total < 3) return { text: '', stat, why: '窗口内弹幕太少' }
    if (!stat.candidates.length) return { text: '', stat, why: '没有达到阈值的刷屏弹幕' }
    const pick = stat.candidates[Math.floor(Math.random() * stat.candidates.length)]
    return { text: pick.text, stat, why: `从 ${stat.candidates.length} 个合格候选中随机选择（这句 ${pick.count} 次）` }
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
      const r = pickFollowDanmaku()
      clipped = r.text
      if (!clipped) { log(`跟风弹幕跳过：${r.why}`); return }
      log(`跟风弹幕候选：${r.stat.top.slice(0, 3).map((x) => `${x.text}×${x.count}`).join(' / ')}；选择「${clipped}」（${r.why}）`)
    } else {
      clipped = await generateAiDanmaku()
      if (!clipped) { log('AI 弹幕生成空结果（本轮跳过）'); return }
    }
    // 跟风复读就是要「随大流」：热点刷屏时同一句可能连续命中，照样发；
    // 只有自由生成保留「与上次相同就跳过」的去重。
    if (!follow && rt.lastAiText && rt.lastAiText === clipped) { log(`智能弹幕与上次相同，跳过：「${clipped}」`); return }
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
      if (cred) {
        // 进房接口只影响「在线状态」，失败不阻塞观看上报，但记一条日志便于排查
        try { await enterRoom(cred, meta.realRoomId) } catch (e) { log(`进房接口失败（不影响观看上报）：${String(e?.message || e)}`) }
      }
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

  /* ── 个人动态 → AI 识别直播预约 ── */
  rt.dynamicsCache = []

  /**
   * 把动态图片 URL 拉下来转成宿主 attachment（多模态模型要的输入）。
   * 限制最多 2 张、单张 ≤12MB；失败跳过，不阻塞文字识别。
   */
  async function imageRefsOf(urls, max = 2) {
    const att = (() => { try { return ctx.get('attachments') } catch { return null } })()
    if (!att?.saveImage) return { refs: [], error: '宿主没有 attachments 服务（不能读图）' }
    const refs = []
    for (const u of (urls || []).slice(0, max)) {
      try {
        const url = String(u || '').replace(/^http:/, 'https:')
        if (!/^https:\/\//.test(url)) continue
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } })
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        if (!buf.length || buf.length > 12 * 1024 * 1024) continue
        const ct = String(r.headers.get('content-type') || '').split(';')[0].trim()
        const mediaType = /^image\/(jpeg|png|webp|gif)$/.test(ct) ? ct : 'image/jpeg'
        const ref = await att.saveImage({ data: new Uint8Array(buf), mediaType, name: 'dynamic-image.jpg' })
        if (ref) {
          refs.push(ref)
          // 记录「本插件新建」的图片附件，保留 7 天后由 sweepRuntime 保守回收；
          // 内容去重命中的旧对象（可能是用户聊天附件）不会进入跟踪表。
          try {
            const hostPath = typeof att.imageHostPath === 'function' ? att.imageHostPath(ref) : ''
            rt.lastAttachTrack = trackSavedAttachment({ home, ref, hostPath })
          } catch { /* 跟踪失败不影响识图 */ }
        }
      } catch { /* 单张失败不影响其它 */ }
    }
    return { refs, error: refs.length ? '' : '图片拉取或转附件失败' }
  }

  /** 用 LLM（deepseek-flash + max 推理）从动态文本里抽取直播预约 */
  async function parseDynamicsWithLlm({ text = '', streamers = [], meta = null, images = [] } = {}) {
    if (!llm.available) return { items: [], raw: '' }
    const nowBj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const roster = (streamers || []).map((x) => `${x.name}（UID ${x.mid}）`).join('、') || '（未配置主播）'
    const pubBj = meta?.publishedAt ? new Date(meta.publishedAt + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') : ''
    const prompt = [
      '你要从一条 B站 个人动态里找出「直播预约 / 直播预告」信息。',
      `当前北京时间：${nowBj}（UTC+8）。`,
      pubBj ? `这条动态的发布时间：${pubBj}（北京时间）。` : '',
      meta?.forwardAuthor ? `这是一条转发动态，原动态作者：${meta.forwardAuthor}。` : '',
      images.length ? `下面附了 ${images.length} 张动态里的图片（很可能是官方直播日程表），请**结合图片**提取具体日期与时间；文字说明里可能只有日期、没有时间。` : '',
      `我的主播名单（名字→UID）：${roster}`,
      '',
      '动态内容（方括号之间）：',
      '［动态开始］',
      String(text || '').slice(0, 4000),
      '［动态结束］',
      '',
      '只输出一个 JSON 数组（不要 markdown 代码块、不要解释），每个元素表示一条直播预约：',
      '{"name":"主播名（用动态里出现的名字，尽量写成名单里的写法）","at":"开播时间，北京时间 ISO，例如 2026-11-11T20:00:00+08:00","title":"场次标题或空字符串","confidence":0.95}',
      '规则：',
      '1) 只提取明确是「预约/预告/某日某点开播」的直播信息；没有就输出 []；',
      '2) 只有日期没年份时用最近的未来日期；出现「今天/明天/今晚8点」这类相对时间时，按上面的当前北京时间换算；',
      '3) at 必须是北京时间（+08:00），不要输出 UTC；无法确定具体时间就跳过这条；',
      '4) name 原样取自动态，不要编造；如果动态是转发、正文没写主播名，就用「原动态作者」作为 name；',
      '5) 严格输出 JSON 数组。',
      images.length ? '6) 日程表图片通常是「列=日期、行=节目」的表格：逐日逐场提取，注意每场下方/旁边的时间（如 18:30、19:30、20:00），不要漏掉同一天的多场。' : '',
      images.length ? '6.1) **列对齐非常关键**：日期列从左到右依次是 11.09、11.10、11.11、11.12、11.13、11.14、11.15。节目块可能相对列头轻微左右交错（设计排版），请用节目块的水平中心与每列日期列头的中心比较来归属，不要用块的左边缘。' : '',
      images.length ? '6.1.1) 校准事实（来自动态文字）：11月13日的【贝拉&嘉然直播】在贝拉kira直播间；11月14日的【A-SOUL夜谈】在乃琳Queen直播间；11月15日的【有点宜思的综艺】在思诺snow直播间——用这三条校正列归属。' : '',
      images.length ? '6.1.2) 每天通常 2 场（个别天 1 场或 3 场）；如果某天出现 3 场以上、或某天 0 场，请重新核对该列。' : '',
      images.length ? '6.1.3) 输出前自检：逐列把节目块与列头水平位置再核对一遍，修正错位后再输出。' : '',
      images.length ? '6.2) 同一天可能有 2~3 场（例如一行里出现多个节目块），全部提取，不要合并。' : '',
      images.length ? '7) 节目名到主播的映射：含「嘉然」→嘉然今天吃什么、含「贝拉」→贝拉kira、含「乃琳」→乃琳Queen、含「心宜」→心宜不是心仪、含「思诺」→思诺snow；团体节目（A-SOUL夜谈/有点宜思的综艺/双人直播等）优先按文字里「在 @某某 的直播间」确定主播，没有说明就取节目名里出现的第一个主播。' : '',
      images.length ? '8) 图片右上角/标题处的日期范围（如 11.09-11.15）用来确定年份与补全日期；只输出还没开始的场次，已过去的跳过。' : '',
    ].join('\n')
    const mkStats = () => ({ types: {}, textChars: 0, reasoningChars: 0, total: 0 })
    const track = (stats) => (c) => {
      stats.total += 1
      const t = String(c?.type || typeof c)
      stats.types[t] = (stats.types[t] || 0) + 1
      if (t === 'text-delta') stats.textChars += String(c?.text || '').length
      if (t === 'reasoning-delta') stats.reasoningChars += String(c?.text || '').length
      if (t === 'usage') stats.usage = { ...(c?.usage || c || {}) }
    }
    const stats = mkStats()
    const callLlm = (effort, maxTokens, st) => llm.generate({
      prompt,
      images,
      maxTokens,
      timeoutMs: images.length ? 240000 : 120000,
      reasoningEffort: effort,
      onError: (e) => log(`动态识别没接上模型：${String(e?.message || e)}`),
      onChunk: track(st),
    })
    // 图片识别预算：先拉满实测一轮 → outputTokens=16898、total=18936、耗时约105s；
    // 取 32000 输出预算（约 1.9 倍余量），日程表更长时也够用。
    const IMAGE_TOKEN_BUDGET = 32000
    let raw = await callLlm('max', images.length ? IMAGE_TOKEN_BUDGET : 4000, stats)
    let usedEffort = 'max'
    // 思考模型可能把输出预算全花在 reasoning 上（正文 0 字）：用 high 再试一次
    if (!String(raw || '').trim() && stats.reasoningChars > 0) {
      log(`动态识别：max 推理吃光了输出预算（reasoning ${stats.reasoningChars} 字），改用 high 重试`)
      const stats2 = mkStats()
      raw = await callLlm('high', images.length ? 12000 : 4000, stats2)
      usedEffort = 'high'
      stats.types2 = stats2.types
      stats.textChars += stats2.textChars
      stats.reasoningChars += stats2.reasoningChars
      stats.total += stats2.total
    }
    log(`动态识别 chunk 统计（effort=${usedEffort}）：${JSON.stringify(stats)}`)
    const out = String(raw || '').trim()
    if (out) log(`动态识别模型原始返回（前 400 字）：${out.slice(0, 400)}`)
    if (!out) return { items: [], raw: '', stats, effort: usedEffort }
    const a = out.indexOf('[')
    const b = out.lastIndexOf(']')
    if (a < 0 || b <= a) return { items: [], raw: out.slice(0, 2000), stats, effort: usedEffort }
    let arr = null
    try { arr = JSON.parse(out.slice(a, b + 1)) } catch { return { items: [], raw: out.slice(0, 2000), stats, effort: usedEffort } }
    if (!Array.isArray(arr)) return { items: [], raw: out.slice(0, 2000), stats, effort: usedEffort }
    const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase()
    const items = []
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue
      const name = String(it.name || '').trim()
      const atTs = Date.parse(String(it.at || ''))
      if (!name || !Number.isFinite(atTs)) continue
      const hit = (streamers || []).find((x) => {
        const a1 = norm(x.name)
        const a2 = norm(name)
        return a1 && a2 && (a1 === a2 || a1.includes(a2) || a2.includes(a1))
      })
      items.push({
        name,
        mid: hit ? String(hit.mid) : '',
        matched: Boolean(hit),
        at: new Date(atTs).toISOString(),
        title: String(it.title || '').trim().slice(0, 60),
        confidence: Number(it.confidence) || 0,
        rawAt: String(it.at || ''),
      })
    }
    return { items, raw: out.slice(0, 2000), stats, effort: usedEffort }
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
      const rolled = store.roll(now)
      // 计划裁剪：跨日或每 6 小时一次；fired/missed 只留最近 7 天，总条数 ≤60
      if (rolled || now - rt.lastPlansPruneAt > 6 * 3600 * 1000) {
        rt.lastPlansPruneAt = now
        const pruned = prunePlans(cfg.plans, now)
        if (pruned.removed > 0) {
          cfg.plans = pruned.plans
          saveCfg()
          log(`清理历史计划 ${pruned.removed} 条（保留最近 7 天，当前 ${cfg.plans.length} 条）`)
        }
      }
      if (now - rt.lastLiveRefreshAt > LIVE_REFRESH_MS) await refreshLive()
      // 运行时文件清理：跨日或每 6 小时一轮（图片附件保留 7 天；tmp 文件 6 小时）
      if (rolled || now - rt.lastRuntimeSweepAt > RUNTIME_SWEEP_MS) void sweepRuntime().catch(() => {})
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
        // 观看心跳断了就重连（每天观看任务已完成时不再重试）
        if (rt.watch && !rt.watch.running && !rt.watch.finished && now >= (rt.watch.nextRetryAt || 0)) startWatch(rt.main)
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
        watch: rt.watch ? {
          roomId: rt.watch.roomId,
          running: Boolean(rt.watch.running),
          reportedMins: Math.round((rt.watch.reportedSec || 0) / 60),
          intervalSec: rt.watch.intervalSec || 0,
          task: rt.watch.task || '',
          error: rt.watch.error || '',
        } : null,
        waiting: rt.waiting ? { mid: rt.waiting.plan?.mid, name: rt.waiting.plan?.name, at: rt.waiting.plan?.at } : null,
        visiting: rt.visiting ? { mid: rt.visiting.mid, name: rt.visiting.name, roomId: rt.visiting.realRoomId, why: rt.visiting.why.join('、'), since: rt.visiting.since } : null,
        plans: (cfg.plans || []).map((p) => ({ id: p.id, mid: p.mid, name: p.name, at: p.at, status: p.status })),
        tasks,
        giftBalance: rt.giftBalance,
        llm: { available: llm.available, ...llm.route() },
        danmakuStatus: rt.danmakuStatus,
        logs: logs.slice(-cfg.logMaxLines),
        lastError: rt.lastError,
        runtime: rt.runtime ? {
          at: rt.runtime.at,
          keepDays: rt.runtime.keepDays || ATTACH_KEEP_DAYS,
          tracked: readTrack(trackPath(home)).length,
          deleted: rt.runtime.deleted,
          bytesFreed: rt.runtime.bytesFreed,
          referenced: rt.runtime.referenced,
          deferred: rt.runtime.deferred,
          tmpRemoved: rt.runtime.tmpRemoved,
          tmpBytes: rt.runtime.tmpBytes,
        } : null,
        state: { day: beijingDateKey(), pausedUntil: rt.pausedUntil },
      })
    }

    if (req.method === 'GET' && path.endsWith('/runtime')) {
      return sendJson(res, 200, {
        ok: true,
        home,
        dshHome: dirname(home),
        keepDays: ATTACH_KEEP_DAYS,
        tracked: readTrack(trackPath(home)).length,
        last: rt.runtime || null,
      })
    }

    if (req.method === 'POST' && path.endsWith('/runtime')) {
      const body = await readBody(req)
      if (String(body.action || '') !== 'sweep') return sendJson(res, 200, { ok: false, error: '不支持的 action' })
      const result = await sweepRuntime()
      return sendJson(res, 200, { ok: Boolean(result), result, tracked: readTrack(trackPath(home)).length })
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

    if (req.method === 'POST' && path.endsWith('/card-parse')) {
      const body = await readBody(req)
      const fromItem = body.item ? extractCardReserve(body.item) : null
      const parsed = fromItem || (body.card ? parseLiveCard(body.card) : null)
      return sendJson(res, 200, { ok: Boolean(parsed), parsed, item: Boolean(body.item) })
    }

    if (req.method === 'POST' && path.endsWith('/dynamics/delete')) {
      const body = await readBody(req)
      const id = String(body.id || '').replace(/\D/g, '')
      if (!id) return sendJson(res, 200, { ok: false, error: '动态 ID 不合法' })
      // 只允许删自己空间里刚读出来的动态，防止误删别人的
      const cached = (rt.dynamicsCache || []).find((x) => String(x.id) === id)
      if (!cached) return sendJson(res, 200, { ok: false, error: '这条动态不在最近读取的列表里，请先点「读取我的动态」' })
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证' })
      const r = await deleteDynamic(cred, id)
      if (!r.ok) {
        logErr(`删除动态失败（${id}）：${describeError(r.code, r.message)}`)
        return sendJson(res, 200, { ok: false, error: describeError(r.code, r.message), code: r.code })
      }
      rt.dynamicsCache = (rt.dynamicsCache || []).filter((x) => String(x.id) !== id)
      log(`已删除动态 ${id}`)
      return sendJson(res, 200, { ok: true, id })
    }

    if (req.method === 'POST' && path.endsWith('/vision-test')) {
      const body = await readBody(req)
      const url = String(body.url || '').trim()
      if (!url) return sendJson(res, 200, { ok: false, error: '需要图片 URL' })
      if (!llm.available) return sendJson(res, 200, { ok: false, error: '宿主没有提供 llm 服务' })
      const got = await imageRefsOf([url], 1)
      if (!got.refs.length) return sendJson(res, 200, { ok: false, error: got.error || '图片转附件失败' })
      let why = ''
      const chunks = []
      const t0 = Date.now()
      const text = await llm.generate({
        prompt: String(body.prompt || '这张图里有什么？用一句话中文概括。'),
        images: got.refs,
        maxTokens: 1500,
        timeoutMs: 120000,
        reasoningEffort: 'max',
        onError: (e) => { why = String(e?.message || e) },
        onChunk: (c) => { if (chunks.length < 6) chunks.push(JSON.stringify(c).slice(0, 300)) },
      })
      return sendJson(res, 200, { ok: Boolean(text), text, error: why, ms: Date.now() - t0, imageCount: got.refs.length, chunks })
    }

    if (req.method === 'GET' && path.endsWith('/dynamics')) {
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证（请先扫码登录）' })
      const me = String(cred.dedeuserid || '')
      if (!me) return sendJson(res, 200, { ok: false, error: '凭证里没有自己的 UID' })
      const r = await getSpaceDynamics(cred, me)
      if (!r.ok) return sendJson(res, 200, { ok: false, error: describeError(r.code, r.message), code: r.code })
      const rawItems = Array.isArray(r.data?.items) ? r.data.items : []
      const items = rawItems.map(mapDynamicItem)
      rt.dynamicsCache = items
      return sendJson(res, 200, {
        ok: true,
        count: items.length,
        selfMid: me,
        items: items.map((x) => ({ ...x, images: x.images.slice(0, 4) })),
        debug: { rawCount: rawItems.length, sampleKeys: rawItems[0] ? Object.keys(rawItems[0]) : null },
      })
    }

    if (req.method === 'POST' && path.endsWith('/dynamics/parse')) {
      const body = await readBody(req)
      let text = String(body.text || '').trim()
      let images = []
      let sourceId = ''
      let meta = null
      let card = null
      let cached = null
      if (body.card) card = parseLiveCard(body.card)
      if (body.id) {
        const it = (rt.dynamicsCache || []).find((x) => String(x.id) === String(body.id))
        if (it) {
          cached = it
          text = it.text
          images = it.images || []
          sourceId = it.id
          meta = { publishedAt: it.publishedAt, author: it.author?.name || '', forwardAuthor: it.forward?.author?.name || '' }
          if (!card && it.reserve) card = it.reserve
        }
      }
      // ① 卡片直读：结构化 JSON，0 token
      if (card && card.atMs && body.skipCard !== true) {
        const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase()
        const hit = (cfg.streamers || []).find((x) => {
          if (card.mid && String(x.mid) === String(card.mid)) return true
          const a1 = norm(x.name)
          const a2 = norm(card.name)
          return a1 && a2 && (a1 === a2 || a1.includes(a2) || a2.includes(a1))
        })
        const items = [{
          name: hit ? hit.name : (card.name || ''),
          mid: hit ? String(hit.mid) : String(card.mid || ''),
          matched: Boolean(hit),
          at: new Date(card.atMs).toISOString(),
          title: card.title || '',
          confidence: 1,
          rawAt: '',
          source: 'card',
        }]
        log(`动态卡片直读：${items[0].name || items[0].mid} · ${items[0].at}`)
        return sendJson(res, 200, { ok: true, source: 'card', sourceId, count: 1, items, textPreview: text.slice(0, 200) })
      }
      // ①预约识别区域只支持卡片直读：cardOnly 时没有卡片直接返回，不再走文字 LLM
      if (body.cardOnly === true) {
        return sendJson(res, 200, {
          ok: false,
          error: '这条动态里没有直播预约卡片（①预约识别只支持卡片直读；文字内容请走②日程表识别或手动计划）',
        })
      }

      if (!text && !(images.length && body.withImages !== false)) {
        return sendJson(res, 200, {
          ok: false,
          error: images.length ? '这条动态只有图片、没有文字（可带 withImages:true 走图片识别）' : '没有可解析的文字内容',
        })
      }
      if (!llm.available) return sendJson(res, 200, { ok: false, error: '宿主没有提供 llm 服务' })
      const t0 = Date.now()
      let imageRefs = []
      let imageError = ''
      if (images.length && body.withImages !== false) {
        const got = await imageRefsOf(images.map((x) => x.url), 2)
        imageRefs = got.refs
        imageError = got.error
        if (imageRefs.length) log(`动态识别：附上 ${imageRefs.length} 张图片（多模态）`)
      }
      const parsed = await parseDynamicsWithLlm({ text, streamers: cfg.streamers, meta, images: imageRefs })
      const items = parsed.items
      log(`动态识别：${items.length} 条预约（${Date.now() - t0}ms）`)
      return sendJson(res, 200, {
        ok: true,
        source: 'llm',
        sourceId,
        count: items.length,
        items,
        imageCount: imageRefs.length,
        imageError,
        rawPreview: parsed.raw ? parsed.raw.slice(0, 1200) : '',
        chunkStats: parsed.stats || null,
        effort: parsed.effort || '',
        textPreview: text.slice(0, 200),
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
      // 手动检查是用户明确点的按钮：不受「工作时间」和自动开关限制。
      // 自动模式在非值守时段不选台（设计如此），但手动检查应该能直接进在播房间。
      let manual = ''
      if (!rt.main && !rt.waiting) {
        await refreshLive(true)
        const pick = enabledStreamers().find((s) => isLive(s.mid))
        const live = pick ? liveOf(pick.mid) : null
        if (pick && live?.realRoomId) {
          await enterMain({
            mid: pick.mid,
            name: live.uname || pick.name,
            roomId: live.roomId,
            realRoomId: live.realRoomId,
            title: live.title,
          }, '手动检查')
          manual = 'entered'
          log(`手动检查：进入「${live.uname || pick.name}」直播间（手动检查不受值守时段限制）`)
        } else {
          manual = pick ? 'room-not-ready' : 'no-live'
        }
      }
      const outside = !inWorkHours(cfg.workHours, Date.now(), cfg.workHoursTz)
      return sendJson(res, 200, {
        ok: true,
        main: rt.main,
        lastError: rt.lastError,
        manual,
        outside,
        hint: outside ? `当前不在值守时段（${cfg.workHours}，${cfg.workHoursTz}），自动模式不会进房；手动检查不受此限制` : '',
      })
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
        const r = pickFollowDanmaku(samples)
        return sendJson(res, 200, {
          ok: Boolean(r.text),
          mode,
          source: 'local',
          text: r.text,
          why: r.why,
          windowSec: Math.round(cfg.aiFollowWindowMs / 1000),
          minCount: cfg.aiFollowMinCount,
          local: { total: r.stat.total, top: r.stat.top, candidates: r.stat.candidates },
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
