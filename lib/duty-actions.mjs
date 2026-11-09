/**
 * lib/duty-actions.mjs —— 「直播值守」的 B站 动作适配器（点赞 / 打赏 / 粉丝牌 / 钱包）
 * ============================================================================
 * 设计原则（与旧 lib/live.mjs 的区别）：
 *   ① **只做适配、不做编排**：每个函数就是「一个接口一次请求」，重试/限速/任务状态
 *      全部由上层（tasks/scheduler）决定，这里不藏任何循环。
 *   ② **永不抛异常**：所有异步函数统一返回 `{ ok, code, message, data }`。
 *      - 成功：ok=true，code=0（B站 业务成功码）
 *      - B站 业务失败：ok=false，code=B站 返回码
 *      - 网络/超时/非 JSON：ok=false，code=-1
 *   ③ 参数**逐字照抄 P0 探针**（scripts/probe.mjs + .probe/out 实测回包）：
 *      点赞 likeReportV3 实测 code=0；送礼 sendGoldMultiUser 实测 code=0（gift_id=31164，
 *      price=100 gold=1 电池，gift_num=1）；钱包 gold=9400；粉丝牌 user_medal_info 已实测形状。
 *      不要凭记忆改字段名 —— B站 这些接口没有公开文档，改一个字段就可能 -400 或风控。
 *   ④ **不打印 cookie / SESSDATA**；出错只回 message 与 code。
 *
 * 依赖：只 import lib/live.mjs 的 headersOf（内含 UA / Cookie / Referer 组装）。
 * ============================================================================
 */
import { headersOf } from './live.mjs'

const API = 'https://api.live.bilibili.com'
const LIVE_REF = 'https://live.bilibili.com/'
const TIMEOUT_MS = 15000 // 所有请求统一 15s 超时（AbortController）

/* ────────────────────────── 基础工具 ────────────────────────── */

/** 统一失败返回（避免每个函数重复写对象） */
function fail(code, message, data = null) {
  return { ok: false, code, message, data }
}

/** 把任意值清洗成「纯数字串」（房间号/UID 常见误传 number 或带空格的字符串） */
function digitsOf(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return s
}

/** 登录态兜底判断：缺 bili_jct 时写操作必然失败，提前返回，不浪费一次风控额度 */
function requireLogin(cred, { csrf = false } = {}) {
  if (!cred || typeof cred !== 'object' || !cred.sessdata) {
    return fail(-101, '没有登录凭证，请先在设置页扫码登录')
  }
  if (csrf && !cred.bili_jct) {
    return fail(-101, '登录凭证缺少 bili_jct（csrf），请重新扫码登录')
  }
  return null
}

/** 文本片段（用于非 JSON 响应的 message，绝不包含请求头/Cookie） */
function snippet(text, n = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * 内部统一请求工具：发一次请求 → 归一成 `{ ok, code, message, data }`。
 *
 * - form 存在时用 `application/x-www-form-urlencoded` POST；带 Origin（P0 探针的
 *   httpJson 对 form 请求就是这么发的，实测通过，这里照抄）。
 * - 超时 15s；网络错误/超时/非 JSON → code=-1。
 * - 只返回 B站 的 code/message（data=json.data），**不返回原始响应全文**，
 *   避免把可能含敏感字段的内容泄到日志/状态里。
 */
async function requestJson(url, { method = 'GET', form, cred = null, referer = LIVE_REF } = {}) {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, TIMEOUT_MS)
  try {
    const headers = { ...headersOf(cred, referer) }
    let body
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers.Origin = LIVE_REF.replace(/\/$/, '') // https://live.bilibili.com（与 P0 探针一致）
      body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString()
    }
    const r = await fetch(url, { method, headers, body, signal: ctl.signal })
    const text = await r.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON：下面统一返回 code=-1 + 文本片段 */
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return fail(-1, `非 JSON 响应（HTTP ${r.status}）：${snippet(text)}`)
    }
    // B站 成功时 code 恒为数字 0；这里宽松地接受字符串数字
    let code = null
    if (json.code !== undefined && json.code !== null && json.code !== '') {
      const n = Number(json.code)
      if (Number.isFinite(n)) code = n
    }
    const ok = code === 0
    let message = typeof json.message === 'string' ? json.message.trim() : ''
    if (!message) message = ok ? 'OK' : code === null ? `HTTP ${r.status}` : `code=${code}`
    return { ok, code, message, data: json.data ?? null }
  } catch (e) {
    if (timedOut && e?.name === 'AbortError') {
      return fail(-1, `请求超时（${TIMEOUT_MS / 1000}s）`)
    }
    return fail(-1, `网络错误：${e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
}

const refererOf = (realRoomId) => `${LIVE_REF}${digitsOf(realRoomId)}`

/* ────────────────────────── 进房 ────────────────────────── */

const ENTRY_URL = `${API}/xlive/web-room/v1/index/roomEntryAction`

/**
 * 进房上报（网页端打开直播间时先调这个）。
 * P0 实测：POST 表单 `room_id / platform=pc / csrf / csrf_token / visit_id=''`，
 * code=0、data=null。失败不阻断后续点赞/弹幕（上层自己决定要不要继续）。
 *
 * @param {{sessdata:string,bili_jct:string,dedeuserid?:string}} cred
 * @param {number|string} realRoomId 真实房间号
 */
export async function enterRoom(cred, realRoomId) {
  const nologin = requireLogin(cred, { csrf: true })
  if (nologin) return nologin
  const roomId = digitsOf(realRoomId)
  if (!roomId) return fail(-400, '缺少房间号（realRoomId）')
  return requestJson(ENTRY_URL, {
    method: 'POST',
    cred,
    referer: refererOf(roomId),
    form: {
      room_id: roomId,
      platform: 'pc',
      csrf: cred.bili_jct,
      csrf_token: cred.bili_jct,
      visit_id: '',
    },
  })
}

/* ────────────────────────── 点赞 ────────────────────────── */

const ROOM_INFO_URL = `${API}/xlive/web-room/v1/index/getInfoByRoom`
const LIKE_REPORT_URL = `${API}/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3`

/**
 * 读房间下发的点赞策略（只读）。
 * P0 实测：`data.like_info_v3 = { click_block, count_block, report_click_limit:15,
 * report_time_min:5, report_time_max:10, total_likes }` —— 即「每批最多 15 次、
 * 两批间隔至少 5 秒」。上层据此把 300 次拆成 20 批。
 *
 * @returns {Promise<{ok:boolean,code:number|null,message:string,data:{
 *   clickBlock:boolean|null,countBlock:boolean|null,reportClickLimit:number|null,
 *   reportTimeMin:number|null,totalLikes:number|null}}>}
 *   请求失败时 data 里五个字段同样存在，只是全为 null（形状稳定，方便前端直接读）。
 */
export async function getLikePolicy(cred, realRoomId) {
  const roomId = digitsOf(realRoomId)
  // 拿不到房间号的策略没有意义；这里明确给 null 字段 + ok:false，而不是抛异常
  const empty = { clickBlock: null, countBlock: null, reportClickLimit: null, reportTimeMin: null, totalLikes: null }
  if (!roomId) return { ok: false, code: -400, message: '缺少房间号（realRoomId）', data: empty }
  const r = await requestJson(`${ROOM_INFO_URL}?room_id=${encodeURIComponent(roomId)}`, {
    cred,
    referer: refererOf(roomId),
  })
  const li = r.data?.like_info_v3
  if (!li || typeof li !== 'object') {
    return {
      ...r,
      data: empty,
      // 接口成功但房间没下发 like_info_v3（例如未开播/新版接口变更）也算取不到策略
      message: r.ok ? '房间未下发点赞策略（like_info_v3 缺失）' : r.message,
    }
  }
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  return {
    ok: r.ok,
    code: r.code,
    message: r.message,
    data: {
      clickBlock: typeof li.click_block === 'boolean' ? li.click_block : null,
      countBlock: typeof li.count_block === 'boolean' ? li.count_block : null,
      reportClickLimit: num(li.report_click_limit),
      reportTimeMin: num(li.report_time_min),
      totalLikes: num(li.total_likes),
    },
  }
}

/**
 * 点一批赞（写操作）。
 * P0 实测：form `room_id / anchor_id=主播UID / uid=自己UID / click_time=本批次数 /
 * csrf / csrf_token / visit_id=''`，`click_time=1` 时 code=0。
 * 房间策略 report_click_limit=15 → click_time 必须 ≤15，这里 clamp 到 1~15 防呆；
 * 批次之间的间隔由上层保证（≥5s + 抖动），本函数绝不循环。
 *
 * @param {object} cred
 * @param {number|string} realRoomId 真实房间号
 * @param {number|string} anchorUid 主播 UID（= getRoomInfo 的 uid，不是房间号！）
 * @param {number} count 本批点击次数（1~15）
 */
export async function clickLike(cred, realRoomId, anchorUid, count) {
  const nologin = requireLogin(cred, { csrf: true })
  if (nologin) return nologin
  const roomId = digitsOf(realRoomId)
  const anchor = digitsOf(anchorUid)
  const selfUid = digitsOf(cred.dedeuserid)
  if (!roomId) return fail(-400, '缺少房间号（realRoomId）')
  if (!anchor) return fail(-400, '缺少主播 UID（anchorUid）')
  if (!selfUid) return fail(-101, '登录凭证缺少 DedeUserID，请重新扫码登录')
  const n = Math.max(1, Math.min(15, Math.trunc(Number(count)) || 1)) // 房间下发的单批上限 15
  return requestJson(LIKE_REPORT_URL, {
    method: 'POST',
    cred,
    referer: refererOf(roomId),
    form: {
      room_id: roomId,
      anchor_id: anchor,
      uid: selfUid,
      click_time: n,
      csrf: cred.bili_jct,
      csrf_token: cred.bili_jct,
      visit_id: '',
    },
  })
}

/* ────────────────────────── 礼物配置 / 查找 ────────────────────────── */

const GIFT_CONFIG_URL = `${API}/xlive/web-room/v1/giftPanel/giftConfig`

/**
 * 读直播间礼物面板配置（只读）。
 * P0 实测 query：`room_id / area_id=0 / area_parent_id=0 / platform=pc / source=live`，
 * data 形如 `{ list: [1004 个礼物], combo_resources, ... }`。
 *
 * 注意：data.list 里**同一个名字会有多条记录**（例如「粉丝团灯牌」有 price=100gold /
 * 1000gold / 1silver 等多档），选哪一条交给 findGift 过滤，不要在本函数里猜。
 */
export async function getGiftConfig(cred, realRoomId) {
  const roomId = digitsOf(realRoomId)
  if (!roomId) return fail(-400, '缺少房间号（realRoomId）')
  const q = new URLSearchParams({
    room_id: roomId,
    area_id: '0',
    area_parent_id: '0',
    platform: 'pc',
    source: 'live',
  })
  return requestJson(`${GIFT_CONFIG_URL}?${q.toString()}`, { cred, referer: refererOf(roomId) })
}

/**
 * 从 giftConfig.data.list 里挑出「可投喂的指定礼物」——纯函数、无 IO、永不抛。
 *
 * 过滤规则（严格按设计定的白名单，宁可漏选不可错选）：
 *   ① name **精确匹配**（区分大小写/空格，不做模糊匹配）；
 *   ② coin_type 匹配（默认 gold=金瓜子；100 gold = 1 电池）；
 *   ③ price ≤ maxPrice（上层传 giftMaxPrice，默认 100）；
 *   ④ bag_gift === 0 —— 必须是「背包礼物」？不，恰恰相反：bag_gift=0 表示**现金/金瓜子
 *      直接投喂**；bag_gift=1 的条目是背包礼物/活动礼包，不能直接送出。
 * 返回：过滤后的原始礼物对象数组，按 price 升序（同价保持接口原顺序，不做 id 擅排）。
 *
 * ⚠️ P0 实测的坑：`giftConfig` 里同时存在 **gift_id=31164 与 34001** 两条
 * 「粉丝团灯牌 / price=100 / coin_type=gold / bag_gift=0 / desc=投喂即可加入主播的粉丝团！」，
 * 两者只有动画字段不同。P0 真实送出成功的是 **31164**；本函数按需求规格只做过滤+价格排序，
 * 返回 [34001, 31164]（同价按接口顺序）——**调用方不要盲目取 [0]**，建议优先选已实测的
 * gift_id（例如从配置记录上次成功的 id），或在 P2 用目标主播房再验证一次。
 *
 * @param {Array|{list:Array}} giftList giftConfig 的 data.list（也接受整个 data）
 * @param {string} name 礼物名，默认「粉丝团灯牌」
 * @param {{maxPrice?:number, coinType?:string}} [opts]
 * @returns {Array<object>} 匹配的礼物对象（price 升序）
 */
export function findGift(giftList, name, { maxPrice, coinType = 'gold' } = {}) {
  try {
    const list = Array.isArray(giftList)
      ? giftList
      : Array.isArray(giftList?.list)
        ? giftList.list
        : []
    const targetName = String(name ?? '')
    if (!targetName) return []
    const coin = String(coinType || 'gold')
    const max =
      maxPrice === undefined || maxPrice === null || maxPrice === ''
        ? Infinity
        : Number.isFinite(Number(maxPrice))
          ? Number(maxPrice)
          : Infinity
    const out = list.filter((g) => {
      if (!g || typeof g !== 'object') return false
      if (String(g.name ?? '') !== targetName) return false
      if (String(g.coin_type ?? '') !== coin) return false
      if (Number(g.bag_gift) !== 0) return false
      const price = Number(g.price)
      return Number.isFinite(price) && price <= max
    })
    // 按 price 升序；Array.prototype.sort 在 Node ≥11 是稳定排序，同价保持原始顺序
    out.sort((a, b) => Number(a.price) - Number(b.price))
    return out
  } catch {
    return []
  }
}

/* ────────────────────────── 钱包 ────────────────────────── */

const WALLET_URL = `${API}/xlive/revenue/v1/wallet/myWallet`

/**
 * 读账号钱包（只读）。P0 实测：`data = { gold: 9400, silver: 0, bp: '0', ... }`，
 * 其中 gold 的单位是金瓜子（100 gold = 1 电池）。打赏前置校验用。
 */
export async function getWallet(cred) {
  const nologin = requireLogin(cred)
  if (nologin) return nologin
  return requestJson(WALLET_URL, { cred })
}

/* ────────────────────────── 粉丝牌 ────────────────────────── */

const MEDAL_URL = `${API}/xlive/app-ucenter/v1/fansMedal/user_medal_info`

/**
 * 查「自己对该主播」的粉丝牌/亲密度（只读）。
 * P0 实测 query：`uid=自己UID / up_uid=主播UID`，data 形如：
 *   {
 *     is_gain: false, lookup_medal: null,          // 未入团
 *     up_medal: { uid, medal_name: '蜂群们', level: 1, ... },
 *     curr_weared: { ...自己当前佩戴的其它牌子... }, ...
 *   }
 * 入团后 is_gain=true、lookup_medal 里才有 intimacy / today_feed / level。
 *
 * @param {object} cred
 * @param {number|string} upUid 主播 UID
 */
export async function getMedal(cred, upUid) {
  const nologin = requireLogin(cred)
  if (nologin) return nologin
  const selfUid = digitsOf(cred.dedeuserid)
  const up = digitsOf(upUid)
  if (!selfUid) return fail(-101, '登录凭证缺少 DedeUserID，请重新扫码登录')
  if (!up) return fail(-400, '缺少主播 UID（upUid）')
  const q = new URLSearchParams({ uid: selfUid, up_uid: up })
  return requestJson(`${MEDAL_URL}?${q.toString()}`, { cred })
}

/**
 * 把 getMedal 的 data 归一成打赏前置判断用的摘要——纯函数、无 IO、永不抛。
 *
 * - joined：是否已加入该主播粉丝团（含「已点亮但接口只给 lookup_medal」的情况）；
 *   P0 实测未入团时 data.is_gain=false 且 data.lookup_medal=null；
 *   入团后 is_gain=true 且 lookup_medal 里带 intimacy / today_feed。
 * - intimacy / todayFeed / level：仅 joined 时从 lookup_medal 取，取不到给 null；
 * - medalName：优先 lookup_medal.medal_name，其次 data.up_medal.medal_name
 *   （**未入团时也可能有值**——那是目标主播的灯牌名，仅用于展示/确认，不代表已入团）。
 *
 * @param {object|null} data user_medal_info 的 data
 * @returns {{joined:boolean, intimacy:number|null, todayFeed:number|null, level:number|null, medalName:string}}
 */
export function medalSummary(data) {
  const empty = { joined: false, intimacy: null, todayFeed: null, level: null, medalName: '' }
  try {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    const lookup = d.lookup_medal && typeof d.lookup_medal === 'object' ? d.lookup_medal : null
    const joined = Boolean(d.is_gain) || Boolean(lookup)
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const upMedal = d.up_medal && typeof d.up_medal === 'object' ? d.up_medal : {}
    return {
      joined,
      intimacy: joined ? num(lookup?.intimacy) : null,
      todayFeed: joined ? num(lookup?.today_feed) : null,
      level: joined ? num(lookup?.level) : null,
      medalName: String(lookup?.medal_name || upMedal.medal_name || ''),
    }
  } catch {
    return empty
  }
}

/* ────────────────────────── 送礼 ────────────────────────── */

const GIFT_SEND_URL = `${API}/xlive/revenue/v2/gift/sendGoldMultiUser`

/**
 * 送 1 个「粉丝团灯牌」（写操作、会真实扣费！）。
 *
 * ⚠️ 调用方必须自己保证：① 房间正在开播；② 已登录；③ 礼物 id/价格来自 findGift 且
 *    价格 ≤ 1 电池；④ 每日次数/余额已校验。本函数**不做任何重试**——重试会二次扣费。
 *
 * P0 实测成功（code=0，1 电池）的 form 字段组合见下；特别注意：
 *   - `uid` 是**送礼人自己**（cred.dedeuserid），不是主播（踩过坑）；
 *   - `ruid` 才是主播 UID；`receive_users` 也是主播；
 *   - `biz_id` 是**真实房间号**的字符串；`price` 是字符串（100 = 1 电池）；
 *   - `metadata:''`、`storm_beat_id:'0'`、`send_ruid:'0'`、`all_flag:'0'` 一个都不能少；
 *   - `live_statistics` 是固定 JSON 串（照抄，改内容可能被判定非正常客户端）。
 *
 * @param {object} cred
 * @param {number|string} realRoomId 真实房间号
 * @param {number|string} anchorUid 主播 UID
 * @param {number|string} giftId 礼物 id（P0 实测粉丝团灯牌=31164）
 * @param {number|string} price 礼物价格（P0 实测 100 gold=1 电池）
 * @param {{coinType?:string, num?:number}} [opts]
 */
export async function sendGift(cred, realRoomId, anchorUid, giftId, price, { coinType = 'gold', num = 1 } = {}) {
  const nologin = requireLogin(cred, { csrf: true })
  if (nologin) return nologin
  const selfUid = digitsOf(cred.dedeuserid)
  const roomId = digitsOf(realRoomId)
  const anchor = digitsOf(anchorUid)
  const gid = digitsOf(giftId)
  if (!selfUid) return fail(-101, '登录凭证缺少 DedeUserID，请重新扫码登录')
  if (!roomId) return fail(-400, '缺少房间号（realRoomId）')
  if (!anchor) return fail(-400, '缺少主播 UID（anchorUid）')
  if (!gid) return fail(-400, '缺少礼物 id（giftId）')
  const p = Number(price)
  if (!Number.isFinite(p) || p < 0) return fail(-400, '礼物价格非法（price）')
  const n = Math.max(1, Math.trunc(Number(num)) || 1)
  return requestJson(GIFT_SEND_URL, {
    method: 'POST',
    cred,
    referer: refererOf(roomId),
    form: {
      uid: selfUid, // 送礼人自己（不是主播！）
      gift_id: gid,
      ruid: anchor, // 收礼主播
      send_ruid: '0',
      gift_num: n,
      coin_type: String(coinType || 'gold'),
      bag_id: '0',
      platform: 'pc',
      biz_code: 'Live',
      biz_id: String(roomId),
      storm_beat_id: '0',
      metadata: '',
      price: String(p),
      receive_users: JSON.stringify([{ uid: Number(anchor) }]),
      all_flag: '0',
      csrf: cred.bili_jct,
      csrf_token: cred.bili_jct,
      web_location: '444.8',
      live_statistics: JSON.stringify({
        pc_client: 1,
        jumpfrom: '-99998',
        room_category: '-99998',
        source_event: 0,
        trackid: '',
        official_channel: { program_room_id: '-99998', program_up_id: '-99998' },
      }),
    },
  })
}

/* ────────────────────────── 错误码语义 ────────────────────────── */

/**
 * B站 直播接口错误码 → 中文语义。
 * 只收录「确认过的」码；未收录的码交给调用方展示原始 message。
 * 弹幕相关码（10030/1003211/1003212/10031）沿用旧 lib/live.mjs 的 SEND_ERR 语义。
 */
const ERROR_TEXT = {
  '-101': '账号未登录（凭证失效，请重新扫码登录）',
  '-111': '提交校验失败（csrf/bili_jct 不对，请重新扫码登录）',
  '-352': '触发 B站 风控（请求被拦截/需要验证），请稍后再试或手动登录验证',
  '-412': '触发 B站 风控（请求被拦截），请稍后再试或手动登录验证',
  '-509': '触发 B站 风控（请求过于频繁），请稍后再试',
  '412': '触发 B站 风控（HTTP 412 请求被拦截），请稍后再试或手动登录验证',
  '429': '触发 B站 风控（请求过于频繁），请稍后再试',
  '-400': '请求参数错误（接口字段可能已变更）',
  '-500': 'B站 服务异常，请稍后再试',
  '10030': '弹幕内容包含敏感词或被限制',
  '10031': '发送失败，可能被风控',
  '1003211': '该直播间禁止弹幕',
  '1003212': '发得太快了（B站 限流，歇几秒再发）',
}

const RISK_CODES = new Set([-352, -412, -509, 412, 429])
const LOGIN_ERROR_CODES = new Set([-101, -111])

/**
 * 错误码 → 用户可读的中文说明。**永不抛异常**。
 * - 已收录的码返回固定文案；未收录的码回落到接口原始 message；都没有再兜底。
 * - code=0 返回「成功」。
 *
 * @param {number|string|null|undefined} code
 * @param {string} [message] B站 原始 message（未收录码时兜底展示）
 * @returns {string}
 */
export function describeError(code, message) {
  try {
    // 注意：Number(null) === 0、Number('') === 0，不能直接转 —— 否则「没拿到返回码」
    // 会被误判成「成功」。这里先把空值单独识别出来。
    const missing = code === null || code === undefined || code === ''
    const n = missing ? NaN : Number(code)
    const mapped = Number.isFinite(n) ? ERROR_TEXT[String(n)] : undefined
    if (mapped) return mapped
    if (Number.isFinite(n) && n === 0) return '成功'
    const raw = String(message ?? '').replace(/\s+/g, ' ').trim()
    if (raw) return raw
    if (!Number.isFinite(n)) return '未知错误（未拿到返回码）'
    return `B站 返回错误 code=${n}`
  } catch {
    return '未知错误'
  }
}

/** 是否风控类错误码（-352 / -412 / -509 / 412 / 429）。永不抛异常。 */
export function isRiskCode(code) {
  try {
    const n = Number(code)
    return Number.isFinite(n) && RISK_CODES.has(n)
  } catch {
    return false
  }
}

/** 是否登录失效类错误码（-101 / -111）。永不抛异常。 */
export function isLoginErrorCode(code) {
  try {
    const n = Number(code)
    return Number.isFinite(n) && LOGIN_ERROR_CODES.has(n)
  } catch {
    return false
  }
}
