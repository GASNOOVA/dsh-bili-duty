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
export function extractCardReserve(item) {
  if (!item || typeof item !== 'object') return null
  const sides = [
    ['self', item],
    ['orig', item.orig],
  ]
  for (const [sideName, side] of sides) {
    if (!side || typeof side !== 'object') continue
    const md = side.modules?.module_dynamic || {}
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
