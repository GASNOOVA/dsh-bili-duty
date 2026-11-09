/**
 * lib/duty-state.mjs —— dsh-bili-duty「直播值守」的每日任务状态（state.json）
 * ============================================================================
 * 语义：**一个主播 × 一个北京时间自然日** 一份状态。北京时间 0 点跨日后，
 * 当天的任务进度（观看秒数/弹幕/点赞/打赏/问候）全部清零重新开始；
 * 只有「最近进房时间」这类跨天仍有参考价值的信息保留。
 *
 * state.json 结构（硬性约定，读和写都按这个白名单来）：
 * {
 *   day: "2026-11-10",                    // 这份状态属于哪一天（北京时间 YYYY-MM-DD）
 *   rooms: {
 *     "<realRoomId>": {                   // 以直播间真实房间号为键
 *       mid, name,                        // 主播 UID / 昵称（跟随配置更新）
 *       watchedSec, watchReported,        // 当日累计驻留秒数 / 已上报可验证秒数
 *       danmakuDone, danmakuCount,        // 「发送弹幕」是否已达成 / 当日发送总数
 *       likeDone, likeClicks,             // 「点赞」是否已达成 / 当日累计点击数
 *       lastLikeAt,                       // 上一轮点赞的时间戳（10 分钟节流用）
 *       giftDone, giftState,              // 「打赏」是否了结 / done|skipped_balance|disabled|failed|''
 *       lastDanmakuAt, lastGiftAt,        // 上次成功发弹幕 / 尝试打赏的时间戳
 *       greeted, greetedCount,            // 今天是否已进房问候过 / 已发问候条数
 *       errors                            // 最近 3 条错误（调用方负责脱敏）
 *     }
 *   },
 *   meta: {
 *     lastCheckAt,                        // 最近一次自动检查开播状态的时间戳
 *     lastEnterAt: {"<realRoomId>": 0}    // 每个房间最近一次进房时间戳
 *   }
 * }
 *
 * 实现约束：
 * - 零第三方依赖，只用 node:fs / node:path；不发网络请求、不 import 其它模块。
 * - **所有磁盘读写失败都静默容错**（load 返回 null、save 返回 false），绝不把异常
 *   抛给调用方；文件坏了就当今天还没开始，不影响值守主流程。
 * - 写盘走「先写 state.json.tmp 再 rename」，进程被杀也不会留下半份 JSON。
 * - 假定单进程单实例独占一份 state.json，本模块不加锁。
 * - meta 没有独立写方法，约定：
 *     * 调度器每轮检查时调 `roll(now)`，会顺手更新 meta.lastCheckAt；
 *     * 真正进房/切目标房时调 `ensureRoom(realRoomId, {mid,name})`，会更新 lastEnterAt。
 * - `ensureRoom` 返回的是**内部实时状态对象**（不是拷贝）：greeted/greetedCount、
 *   watchReported 这类没有专用方法的字段，调用方可以改完再 `save()`。
 * ============================================================================
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** state.json 文件名（放在家目录下） */
const STATE_FILE = 'state.json'
/** 原子写的临时文件后缀 */
const TMP_SUFFIX = '.tmp'
/** 每个房间最多保留几条错误 */
const MAX_ERRORS = 3
/** 单条错误信息最长保留多少字（避免把整段接口返回塞进 state） */
const MAX_ERROR_LEN = 200
/** meta.lastEnterAt 最多保留多少个房间（防止历史房间无上限增长） */
const MAX_LAST_ENTER = 32
/** giftState 合法取值 */
const GIFT_STATES = new Set(['done', 'skipped_balance', 'disabled', 'failed', ''])

/** 转非负整数（转不动当 0） */
const nonNegInt = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 转非负数字（毫秒时间戳允许为 0） */
const nonNegNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 字符串清洗：null → ''，去空白，截断 */
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max)

/** 房间号清洗：只留数字（真实房间号） */
const roomKey = (v) => str(v, 20).replace(/\D/g, '')

/**
 * 北京时区（UTC+8）的日期键 YYYY-MM-DD。
 * 手动 +8 小时再取 ISO 日期，不依赖 ICU/系统时区，跨平台结果稳定。
 */
export function beijingDateKey(ms = Date.now()) {
  const n = Number(ms)
  const t = Number.isFinite(n) ? n : Date.now()
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 新建一个房间的空白当日状态（字段顺序与 state.json 约定一致） */
function blankRoom(meta = {}) {
  return {
    mid: str(meta.mid, 20),
    name: str(meta.name, 30),
    watchedSec: 0,
    watchReported: 0,
    danmakuDone: false,
    danmakuCount: 0,
    likeDone: false,
    likeClicks: 0,
    lastLikeAt: 0,
    giftDone: false,
    giftState: '',
    lastDanmakuAt: 0,
    lastGiftAt: 0,
    greeted: false,
    greetedCount: 0,
    errors: [],
  }
}

/** 把磁盘上读到的一条房间状态洗成完整形状（缺字段补默认、类型不对纠正） */
function normalizeRoom(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const errors = Array.isArray(r.errors)
    ? r.errors.map((x) => str(x, MAX_ERROR_LEN)).filter(Boolean).slice(-MAX_ERRORS)
    : []
  const giftState = str(r.giftState, 20)
  return {
    mid: str(r.mid, 20),
    name: str(r.name, 30),
    watchedSec: nonNegInt(r.watchedSec),
    watchReported: nonNegInt(r.watchReported),
    danmakuDone: r.danmakuDone === true,
    danmakuCount: nonNegInt(r.danmakuCount),
    likeDone: r.likeDone === true,
    likeClicks: nonNegInt(r.likeClicks),
    lastLikeAt: nonNegNum(r.lastLikeAt),
    giftDone: r.giftDone === true,
    giftState: GIFT_STATES.has(giftState) ? giftState : '',
    lastDanmakuAt: nonNegNum(r.lastDanmakuAt),
    lastGiftAt: nonNegNum(r.lastGiftAt),
    greeted: r.greeted === true,
    greetedCount: nonNegInt(r.greetedCount),
    errors,
  }
}

/** 清洗 meta（时间戳 + lastEnterAt 表，最多保留最近 32 个房间） */
function normalizeMeta(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const enters = []
  if (r.lastEnterAt && typeof r.lastEnterAt === 'object' && !Array.isArray(r.lastEnterAt)) {
    for (const [k, v] of Object.entries(r.lastEnterAt)) {
      const rid = roomKey(k)
      const t = nonNegNum(v)
      if (rid && t) enters.push([rid, t])
    }
  }
  // 按时间倒序留下的才是「最近进房」的房间，超出上限的老记录丢掉
  enters.sort((a, b) => b[1] - a[1])
  const lastEnterAt = {}
  for (const [rid, t] of enters.slice(0, MAX_LAST_ENTER)) lastEnterAt[rid] = t
  return { lastCheckAt: nonNegNum(r.lastCheckAt), lastEnterAt }
}

/** 新建一份空白状态（day 由调用方决定，默认今天） */
function freshState(day = beijingDateKey()) {
  return { day, rooms: {}, meta: { lastCheckAt: 0, lastEnterAt: {} } }
}

/**
 * 创建每日任务状态存储（绑定一个家目录）。
 * 返回对象：{ load, save, roll, snapshot, ensureRoom, addDanmaku, markLike,
 *             markGift, markWatch, setError, roomsToday }
 * 所有方法都不抛异常；写盘失败返回 false，读盘失败返回 null。
 *
 * @param {string} home 家目录（state.json 所在目录，不存在会自动创建）
 */
export function createStore(home) {
  const homeDir = str(home, 1024)
  const file = homeDir ? join(homeDir, STATE_FILE) : ''
  let state = freshState()

  /** 深拷贝（state 全是 JSON 可序列化的普通对象，JSON 往返最省事） */
  const clone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v))
    } catch {
      return null
    }
  }

  /**
   * 内部跨日检查：day 不是今天就整份重置 rooms、day 设为今天。
   * 按约定保留 meta.lastEnterAt（进房时间戳跨天仍有参考价值），lastCheckAt 归零。
   * 返回是否发生了跨日重置。
   */
  function ensureDay(nowMs) {
    const day = beijingDateKey(nowMs)
    if (state.day === day) return false
    state.day = day
    state.rooms = {}
    state.meta.lastCheckAt = 0
    // meta.lastEnterAt 保留不清
    return true
  }

  /**
   * 从 state.json 读取状态并做清洗/跨日重置。
   * 返回读取后的状态深拷贝；文件不存在（首次运行）返回空白状态；
   * 读取或 JSON 解析失败返回 null（内部状态同时重置为空白，不抛异常）。
   */
  function load() {
    if (!file) return null
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      // 首次运行没有文件是正常情况：从空白状态开始
      if (e && e.code === 'ENOENT') {
        state = freshState()
        return clone(state)
      }
      return null // 权限等异常：静默，主流程照常跑
    }
    let raw = null
    try {
      raw = JSON.parse(text)
    } catch {
      // JSON 坏了：当今天还没开始，不抛异常
      state = freshState()
      return null
    }
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    state = {
      day: str(r.day, 10),
      rooms: {},
      meta: normalizeMeta(r.meta),
    }
    if (r.rooms && typeof r.rooms === 'object' && !Array.isArray(r.rooms)) {
      for (const [k, v] of Object.entries(r.rooms)) {
        const rid = roomKey(k)
        if (!rid) continue
        state.rooms[rid] = normalizeRoom(v)
      }
    }
    // 读到的不是今天 → 整份任务进度作废（保留 lastEnterAt）
    ensureDay(Date.now())
    return clone(state)
  }

  /**
   * 原子写 state.json：先写 state.json.tmp，成功后 rename 覆盖正式文件。
   * 返回 true 表示已落盘；任何失败都静默返回 false（并尽力清掉 tmp）。
   */
  function save() {
    if (!file) return false
    // 写盘前先过一遍日界，避免把昨天的状态又写回去
    ensureDay(Date.now())
    const tmp = file + TMP_SUFFIX
    try {
      mkdirSync(homeDir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        /* 清不掉就算了 */
      }
      return false
    }
  }

  /**
   * 调度器的「日界检查」入口：跨日则重置任务进度；无论是否跨日都顺手把
   * meta.lastCheckAt 记成 now（自动模式用它算下次检查时间，重启后不重复检查）。
   * 返回 true 表示刚刚发生了跨日重置（调用方通常应马上 save()）。
   */
  function roll(now = Date.now()) {
    const rolled = ensureDay(now)
    const ms = Number(now)
    state.meta.lastCheckAt = Number.isFinite(ms) && ms > 0 ? ms : Date.now()
    return rolled
  }

  /** 当前状态的深拷贝（JSON 克隆；保证已过日界，/status 等只读场景用它） */
  function snapshot() {
    ensureDay(Date.now())
    return clone(state) || freshState()
  }

  /**
   * 内部取房助手：房间状态不存在就按 meta 建一条，存在则用 meta.mid/name 跟新主播信息。
   * 不碰 meta.lastEnterAt —— 只有公开的 ensureRoom 才代表「进房」。
   * 返回实时状态对象；房间号非法返回 null。
   */
  function getRoom(realRoomId, meta) {
    const rid = roomKey(realRoomId)
    if (!rid) return null
    ensureDay(Date.now())
    let room = state.rooms[rid]
    if (!room) {
      room = blankRoom(meta)
      state.rooms[rid] = room
    } else if (meta && typeof meta === 'object') {
      const mid = str(meta.mid, 20)
      const name = str(meta.name, 30)
      if (mid) room.mid = mid
      if (name) room.name = name
    }
    return room
  }

  /**
   * 确保某房间的当日状态存在（不存在则按 meta 初始化），并记录进房时间。
   * 已存在时用 meta.mid/name 同步主播信息（改名/换房间后跟新）。
   * 返回该房间的实时状态对象；房间号非法返回 null。
   * 注意：这是 **实时引用**，改完字段后需自行 save()。
   * 约定：只在真正进房/切目标房时调用它（它会把 lastEnterAt 更新为当前时间）。
   */
  function ensureRoom(realRoomId, meta) {
    const room = getRoom(realRoomId, meta)
    if (!room) return null
    const rid = roomKey(realRoomId)
    state.meta.lastEnterAt[rid] = Date.now()
    const keys = Object.keys(state.meta.lastEnterAt)
    if (keys.length > MAX_LAST_ENTER) {
      keys.sort((a, b) => state.meta.lastEnterAt[a] - state.meta.lastEnterAt[b])
      for (const k of keys.slice(0, keys.length - MAX_LAST_ENTER)) delete state.meta.lastEnterAt[k]
    }
    return room
  }

  /** 记成功发出 n 条弹幕：累计数增加，标记当日「发送弹幕」任务已达成。返回累计条数 */
  function addDanmaku(realRoomId, n = 1) {
    const room = getRoom(realRoomId)
    if (!room) return null
    const k = Math.max(1, Math.round(Number(n) || 1))
    room.danmakuCount = nonNegInt(room.danmakuCount) + k
    room.danmakuDone = room.danmakuCount > 0
    room.lastDanmakuAt = Date.now()
    return room.danmakuCount
  }

  /** 记一轮点赞成功：累计点击数增加，标记当日「点赞」任务已达成。返回累计点击数 */
  function markLike(realRoomId, clicks) {
    const room = getRoom(realRoomId)
    if (!room) return null
    room.likeClicks = nonNegInt(room.likeClicks) + nonNegInt(clicks)
    room.likeDone = true
    room.lastLikeAt = Date.now()
    return room.likeClicks
  }

  /**
   * 记一次打赏结果（调用方保证每房每天最多尝试一次）：
   *   done            → 成功送出，当日打赏了结
   *   skipped_balance → 余额不足主动跳过，当日打赏了结（不重试、不充值）
   *   disabled        → 打赏开关关着，未尝试（不算完成）
   *   failed          → 接口失败（不算完成；是否重试由调用方按风控策略决定）
   *   ''              → 清空状态（一般不用）
   * 返回写入后的 giftState；房间号非法返回 null。
   */
  function markGift(realRoomId, result) {
    const room = getRoom(realRoomId)
    if (!room) return null
    const value = str(result, 20)
    const giftState = GIFT_STATES.has(value) ? value : 'failed'
    room.giftState = giftState
    room.giftDone = giftState === 'done' || giftState === 'skipped_balance'
    if (giftState) room.lastGiftAt = Date.now()
    return giftState
  }

  /** 累计观看秒数（调用方每次心跳传增量；只记 watchedSec，不碰 watchReported）。返回累计秒数 */
  function markWatch(realRoomId, sec) {
    const room = getRoom(realRoomId)
    if (!room) return null
    room.watchedSec = nonNegInt(room.watchedSec) + nonNegInt(sec)
    return room.watchedSec
  }

  /** 记一条错误（调用方先脱敏）；每个房间只保留最近 3 条。返回当前错误条数 */
  function setError(realRoomId, msg) {
    const room = getRoom(realRoomId)
    if (!room) return null
    const text = str(msg, MAX_ERROR_LEN)
    if (text) {
      room.errors.push(text)
      if (room.errors.length > MAX_ERRORS) room.errors.splice(0, room.errors.length - MAX_ERRORS)
    }
    return room.errors.length
  }

  /**
   * 今天的房间状态列表（深拷贝数组，每项 = 该房状态 + realRoomId 字符串）。
   * 调用方常用法：store.roomsToday().filter((x) => x.giftState === 'done').length。
   * now 用于按指定时刻判断日界（调度器 tick 里传同一个 now 保持一致）。
   */
  function roomsToday(now = Date.now()) {
    ensureDay(now)
    const out = []
    for (const [realRoomId, room] of Object.entries(state.rooms)) {
      const copy = normalizeRoom(room)
      copy.realRoomId = realRoomId
      out.push(copy)
    }
    return out
  }

  return {
    load,
    save,
    roll,
    snapshot,
    ensureRoom,
    addDanmaku,
    markLike,
    markGift,
    markWatch,
    setError,
    roomsToday,
  }
}
