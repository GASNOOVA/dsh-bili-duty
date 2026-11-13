/**
 * lib/duty-card.mjs —— B站「直播预约卡片」直读解析
 * ============================================================================
 * 动态里的直播卡片（major.live_rcmd.content / major.live）本质是一段 JSON，
 * 里面通常带 live_play_info：room_id / uid / uname / title / live_start_time。
 * 这类结构化卡片**不需要 LLM**：直接解析字段即可，0 token、毫秒级。
 *
 * 只有「纯文字动态」「图片日程表」才需要回退到 LLM。
 *
 * 设计原则：
 *   - 字段名多版本兼容（B站 不同端/不同版本字段名不完全一致）；
 *   - 递归在对象树里找「时间字段」作为锚点，再就近取主播/标题；
 *   - 任何输入都不抛异常，解析不出来返回 null。
 * ============================================================================
 */

/** 时间候选字段（优先级从高到低） */
const TIME_KEYS = [
  'live_start_time', 'liveStartTime', 'start_time', 'startTime', 'start_ts',
  'plan_time', 'planTime', 'scheduled_time', 'scheduledTime',
  'expect_start_time', 'expectStartTime', 'live_time', 'liveTime',
  'stime', 'reserve_time', 'reserveTime', 'begin_time', 'beginTime',
]

/** 主播名候选字段 */
const NAME_KEYS = ['uname', 'up_name', 'upName', 'anchor_name', 'anchorName', 'user_name', 'userName']

/** 主播 UID 候选字段 */
const MID_KEYS = ['uid', 'up_id', 'upId', 'mid', 'anchor_uid', 'anchorUid', 'up_uid', 'upUid']

/** 标题候选字段 */
const TITLE_KEYS = ['title', 'live_title', 'liveTitle', 'room_title', 'roomTitle', 'name']

/** 房间号候选字段 */
const ROOM_KEYS = ['room_id', 'roomId', 'real_room_id', 'realRoomId']

/** 把一个「秒 / 毫秒 / 时间字符串」归一成毫秒时间戳；解析不出返回 NaN */
export function parseCardTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return v // 毫秒
    if (v > 1e9) return v * 1000 // 秒（2001 年之后）
    return NaN
  }
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (!s) return NaN
  if (/^\d+$/.test(s)) return parseCardTime(Number(s))
  // "YYYY-MM-DD HH:mm:ss" / "YYYY/MM/DD HH:mm" 按北京时间解释
  let t = s.replace(/\//g, '-')
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(t)) t = t.replace(' ', 'T') + '+08:00'
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : NaN
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** 广度优先遍历对象树（最多 maxDepth 层，最多 visit 个节点），对每个对象执行 fn */
function walkObjects(root, maxDepth, fn) {
  const queue = [{ node: root, depth: 0 }]
  let visited = 0
  while (queue.length && visited < 300) {
    const { node, depth } = queue.shift()
    if (!node || typeof node !== 'object') continue
    visited += 1
    if (fn(node) === true) return true
    if (depth >= maxDepth) continue
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
    }
  }
  return false
}

/**
 * 卡片文案里的时间按哪个时区解释：B站 动态接口支持 timezone_offset 参数（getTimezoneOffset 约定，
 * 东八区 -480、柏林冬令时 -60），接口返回的「明天 03:00 直播」等 desc 文案已经按这个偏移渲染成
 * 本地时间。因此解析时用与请求相同的偏移把本地墙上时间换回绝对时刻。
 */
function localWallParts(ms, tzOffsetMin) {
  const d = new Date(ms - tzOffsetMin * 60000)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}

/**
 * 解析预约卡 desc 文案里的本地时间，例如：
 *   「11-17 11:00 直播」「11月15日 11:00」「11/17 11:00」「今天 20:00」「明天 19:30」
 * 没有年份时按本地时区当前年份补；若落在 2 天前之前则视为跨年（+1 年）。
 * @param {string} text desc 文案
 * @param {number} [nowMs] 当前时间
 * @param {number} [tzOffsetMin] 本地时区偏移（JS getTimezoneOffset 约定：UTC - 本地，东八区 -480）
 * @returns {number} 毫秒时间戳；解析不出返回 NaN
 */
export function parseReserveDescTime(text, nowMs = Date.now(), tzOffsetMin = -60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return NaN
  const off = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : -60
  const nowWall = new Date(nowMs - off * 60000)
  const build = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) + off * 60000
  const rel = s.match(/(今天|明天|后天)\s*(\d{1,2}):(\d{2})/)
  if (rel) {
    const offset = rel[1] === '今天' ? 0 : rel[1] === '明天' ? 1 : 2
    return Date.UTC(nowWall.getUTCFullYear(), nowWall.getUTCMonth(), nowWall.getUTCDate() + offset, Number(rel[2]), Number(rel[3])) + off * 60000
  }
  let m = s.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*[ T]?\s*(\d{1,2}):(\d{2})/)
  if (!m) return NaN
  const month = Number(m[1])
  const day = Number(m[2])
  const hh = Number(m[3])
  const mm = Number(m[4])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return NaN
  const { y } = localWallParts(nowMs, off)
  for (let k = 0; k < 3; k += 1) {
    const mt = build(y + k, month, day, hh, mm)
    if (mt >= nowMs - 2 * 86400 * 1000) return mt
  }
  return NaN
}

/**
 * 解析 B站 新版动态附带的「直播预约」卡片：module_dynamic.additional.type=ADDITIONAL_TYPE_RESERVE
 * 结构示例：{ type:'ADDITIONAL_TYPE_RESERVE', reserve:{ title:'直播预约：…', desc1:{text:'11-17 11:00 直播'},
 *          up_mid:'672328094', rid:5867427, reserve_total:2289, button:{...} } }
 * 注意：reserve.rid 是预约 ID，不是直播间号；房间号仍由主播 UID 解析。
 */
export function parseReserveAdditional(additional, author, nowMs = Date.now(), tzOffsetMin = -60) {
  const r = additional && typeof additional === 'object' ? additional.reserve : null
  if (!r || typeof r !== 'object') return null
  const desc = r.desc1?.text || r.desc?.text || r.desc1 || ''
  let atMs = parseReserveDescTime(desc, nowMs, tzOffsetMin)
  if (!Number.isFinite(atMs)) atMs = parseCardTime(r.expected_time ?? r.start_time ?? r.live_start_time)
  if (!Number.isFinite(atMs)) return null
  const mid = String(r.up_mid ?? r.uid ?? r.mid ?? r.up_id ?? (author ? author.mid : '') ?? '')
  const name = String(r.up_name ?? r.uname ?? (author ? author.name : '') ?? '')
  if (!mid && !name) return null
  return {
    mid,
    name,
    title: String(r.title || ''),
    roomId: '',
    atMs,
    at: new Date(atMs).toISOString(),
    cardType: 'additional_reserve',
  }
}

/**
 * 从任意卡片 JSON 对象里抽取预约信息。
 * @param {object|string} raw 卡片对象，或 content JSON 字符串
 * @returns {{mid:string,name:string,title:string,roomId:string,at:string,atMs:number,cardType:string}|null}
 */
export function parseLiveCard(raw) {
  let card = raw
  if (typeof card === 'string') {
    const s = card.trim()
    if (!s.startsWith('{') && !s.startsWith('[')) return null
    try { card = JSON.parse(s) } catch { return null }
  }
  if (!card || typeof card !== 'object') return null

  let best = null
  walkObjects(card, 3, (obj) => {
    const timeRaw = pick(obj, TIME_KEYS)
    const atMs = parseCardTime(timeRaw)
    if (!Number.isFinite(atMs)) return false
    // 找到时间锚点后，就地（以及它的父级/兄弟节点）找主播与标题
    const mid = String(pick(obj, MID_KEYS) ?? '')
    const name = String(pick(obj, NAME_KEYS) ?? '')
    const title = String(pick(obj, TITLE_KEYS) ?? '')
    const roomId = String(pick(obj, ROOM_KEYS) ?? '')
    best = { mid, name, title, roomId, atMs, at: new Date(atMs).toISOString(), cardType: '' }
    return true
  })
  if (!best) return null

  // 主播名/UID 有时不在时间锚点同一层：再全局补一次
  if (!best.name || !best.mid) {
    walkObjects(card, 3, (obj) => {
      const name = pick(obj, NAME_KEYS)
      const mid = pick(obj, MID_KEYS)
      if (!best.name && name && String(name).trim()) best.name = String(name).trim()
      if (!best.mid && mid !== undefined && mid !== null && mid !== '') best.mid = String(mid)
      return Boolean(best.name && best.mid)
    })
  }
  if (!best.mid && !best.name) return null
  return best
}

/**
 * 从一条动态 item 里找直播预约卡片（含转发动态的 orig）。
 * @param {object} item polymer 动态 item
 * @returns {{mid:string,name:string,title:string,roomId:string,at:string,atMs:number,cardType:string,side:'self'|'orig'}|null}
 */
export function extractCardReserve(item, nowMs = Date.now(), tzOffsetMin = -60) {
  if (!item || typeof item !== 'object') return null
  const sides = [
    ['self', item],
    ['orig', item.orig],
  ]
  for (const [sideName, side] of sides) {
    if (!side || typeof side !== 'object') continue
    const md = side.modules?.module_dynamic || {}
    // 新版预约卡：module_dynamic.additional.type=ADDITIONAL_TYPE_RESERVE（desc1.text 里是「11-17 11:00 直播」）
    const add = md.additional
    if (add && (add.type === 'ADDITIONAL_TYPE_RESERVE' || add.reserve)) {
      const p = parseReserveAdditional(add, side.modules?.module_author, nowMs, tzOffsetMin)
      if (p) return { ...p, cardType: 'additional_reserve', side: sideName }
    }
    const candidates = [
      ['live_rcmd', md.major?.live_rcmd?.content ?? md.major?.live_rcmd],
      ['live', md.major?.live],
      ['additional', md.additional],
    ]
    for (const [cardType, raw] of candidates) {
      if (!raw) continue
      const parsed = parseLiveCard(raw)
      if (parsed) return { ...parsed, cardType, side: sideName }
    }
  }
  return null
}
