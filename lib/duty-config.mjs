/**
 * lib/duty-config.mjs —— dsh-bili-duty「直播值守」的配置形状与清洗
 * ============================================================================
 * 配置存 `<家>/config.json`，设置页通过 HTTP API 改写。
 * 本模块是纯逻辑，只做三件事：
 *   1) 给一份完整的 DEFAULTS —— 字段、默认值、取值范围都登记在这里；
 *   2) 把外部传来的脏数据按白名单洗成能用的形状（数字 clamp、字符串截断、
 *      数组去重、时间格式校验），DEFAULTS 之外的键一律丢掉；
 *   3) 把设置页提交的「只改几项」的 patch 合并进旧配置。
 * 不读写文件、不发网络请求、不依赖其它模块。
 *
 * 布尔字段沿用旧插件 lib/config.mjs 的约定：
 * - 默认 true 的字段：只有显式 `false` 才关（'no'、0 之类脏值仍按开处理）；
 * - 默认 false 的字段：只有显式 `true` 才开。
 * ============================================================================
 */

/** 默认问候模板库：10 条占位（每条 ≤20 字），用户可在设置页编辑，最多 20 条 */
const DEFAULT_GREETINGS = [
  '来了来了',
  '晚上好呀',
  '打卡报到',
  '主播晚上好',
  '今天也来啦',
  '来看直播啦',
  '先蹲一会儿',
  '主播辛苦啦',
  '今天状态不错呀',
  '来了，先蹲着',
]

/** 主播名单上限（对应设置页「5 个主播」） */
const MAX_STREAMERS = 5
/** 手动计划上限 */
const MAX_PLANS = 50
/** 问候模板库上限 */
const MAX_GREETINGS = 20
/** 问候模板单条长度上限（字） */
const GREETING_MAX_LEN = 20
/** 计划状态白名单（与设计 §3 的每日任务状态一致） */
const PLAN_STATUSES = new Set(['pending', 'fired', 'missed', 'cancelled', 'done'])
/** 合法的工作时间默认值（北京时间语义，由调度方解释） */
const DEFAULT_WORK_HOURS = '08:00-24:00'
/** HH:MM-HH:MM（允许 1 位小时，统一补零；结束允许 24:00 表示到当天午夜） */
const WORK_HOURS_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/

/**
 * 插件配置的完整默认值 —— **所有字段都在这里登记，normalizeConfig 的输出与它一一对应**。
 * 数值字段后面标了 [范围]，normalizeConfig 会 clamp 到范围内。
 */
export const DEFAULTS = {
  /** 总开关：关掉 = 值守逻辑完全停摆（设置页仍可正常使用） */
  enabled: true,
  /**
   * 值守的主播名单，**数组顺序就是优先级**（越靠前越优先），最多 5 个。
   * 每项 { mid, roomId, name, enabled, order }：
   *   mid    = 主播 UID（数字串，推荐；改名/换房间都跟着人走）
   *   roomId = 直播间真实房间号（数字串；只给了房间号时用）
   *   name   = 显示名（≤30 字，留空自动补「主播 <mid>」）
   *   enabled= 是否参与值守（默认 true）
   *   order  = 冗余序号；normalizeConfig 会按数组顺序重排为 0..n-1
   */
  streamers: [],
  /** 自动模式开关：开 = 每 autoCheckMs 检查一次主播是否开播 */
  autoEnabled: true,
  /** 自动检查间隔（毫秒）[60000, 3600000]，默认 15 分钟 */
  autoCheckMs: 900000,
  /**
   * 工作时间使用的时区：
   *   beijing（默认）固定 UTC+8；local 宿主机本地时区；
   *   也可以直接填 IANA 时区名（如 Europe/Berlin）——设置页选「本机本地时间」时
   *   会记录浏览器时区，避免宿主容器是 UTC 时出现偏差。
   * 只影响自动模式的进出场判断；手动计划用绝对时间，不受影响。
   */
  workHoursTz: 'beijing',
  /**
   * 自动模式的工作时间（语义由 workHoursTz 决定），格式 "HH:MM-HH:MM"。
   * 默认 08:00-24:00。格式不合法时回落默认值；结束必须晚于开始（24:00 = 当天午夜）。
   * 注意：手动计划不受工作时间限制（设计 §4.2）。
   */
  workHours: DEFAULT_WORK_HOURS,
  /**
   * 手动计划列表（一次性），最多 50 条。每项：
   * { id, mid, name, at, createdAt, status }
   *   at        = 计划开播时间，统一存 ISO(UTC) 字符串（Date.parse 校验，不合法丢弃）
   *   createdAt = 创建时间，ISO 字符串
   *   status    = pending | fired | missed | cancelled | done
   */
  plans: [],
  /** 「观看直播」任务开关（拉流层） */
  taskWatch: true,
  /** 「发送弹幕」任务开关 */
  taskDanmaku: true,
  /** 「点赞」任务开关 */
  taskLike: true,
  /** 「打赏」任务开关（默认关；探针确认可行后再开） */
  taskGift: false,
  /** 智能弹幕开关（跟风复读 / 自由生成） */
  aiDanmaku: true,
  /** 智能弹幕发送间隔（毫秒）[30000, 600000]，默认 5 分钟 */
  aiDanmakuMs: 300000,
  /** 每房每日智能弹幕上限（条）[10, 300] */
  aiDanmakuDailyMax: 100,
  /**
   * 智能弹幕模式：
   *   follow   跟风复读（默认）：纯本地统计，不调用模型。取时间窗口内出现次数最多、
   *                           且达到 aiFollowMinCount 的原句直接复制；没有明显刷屏就不发。
   *   generate 自由生成：根据房间标题 + 最近弹幕让 LLM 写一句（仅此模式需要模型）。
   */
  aiDanmakuMode: 'follow',
  /** 跟风复读的时间窗口（毫秒）[20000, 300000]，默认 60 秒 */
  aiFollowWindowMs: 60_000,
  /** 跟风复读的最低重复次数（同一句在窗口内至少出现几次才值得跟）[2, 20]，默认 3 */
  aiFollowMinCount: 3,
  /** 每房每日弹幕总上限（条）[20, 600]，问候 + AI 之和的兜底 */
  danmakuDailyMax: 150,
  /** 任意两条弹幕之间的全局最小间隔（毫秒）[1000, 60000]，只作兜底 */
  danmakuCooldownMs: 3000,
  /** 模板弹幕通道开关（新版只用于「进房问候」，下播告别已移除） */
  templateDanmaku: true,
  /** 进房问候条数 [1, 20] */
  templateGreetingCount: 10,
  /** 进房问候的条间隔（毫秒）[10000, 120000]，默认 30 秒 */
  templateSpacingMs: 30000,
  /** 问候模板库：默认 10 条中文占位；每项 ≤20 字、去重、最多 20 条 */
  greetingTemplates: [...DEFAULT_GREETINGS],
  /** 每轮点赞点击数 [1, 3000]，默认 300 */
  likeClicksPerRound: 300,
  /** 点赞轮间隔（毫秒）[60000, 3600000]，默认 10 分钟 */
  likeRoundMs: 600000,
  /** 拉流清晰度 qn [80, 400]；P0 实测请求 150 可能被房间回落到 250 */
  watchQn: 150,
  /** 打赏礼物名（用于从礼物配置里精确匹配） */
  giftName: '粉丝团灯牌',
  /**
   * 礼物单价上限，单位 = 金瓜子（100 金瓜子 = 1 电池）[1, 10000]。
   * 默认 100 即 1 电池，这是本项目打赏的硬红线。
   */
  giftMaxPrice: 100,
  /** 全局每日打赏次数上限 [1, 10] */
  giftMaxPerDay: 5,
  /** 用宿主哪个模型做「自由生成」弹幕、动态文字识别、日程表图片识别；留空 = 跟随 DSH 当前默认模型 */
  llmProvider: '',
  /** 同上，模型名（≤60 字符） */
  llmModel: '',
  /**
   * 推理强度：off / low / high / max（默认 low）。
   * 这些低难度文本/识别任务用 low 能显著减少 reasoning token 消耗。
   */
  llmReasoningEffort: 'low',
  /** 单条弹幕最大字数 [5, 40]（B 站普通用户上限 20） */
  maxLen: 20,
  /** 设置页日志最多保留多少行 [20, 500] */
  logMaxLines: 200,
}

/**
 * 数字 clamp：转数字 → 非法回默认值 → 四舍五入取整 → 收进 [lo, hi]。
 * 供本文件与调用方（设置页提交前的兜底、/status 展示）共用。
 */
export function clampNum(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** 字符串清洗：null/undefined → ''，去首尾空白，超长截断到 max 字 */
export function cleanStr(v, max = 200) {
  return String(v ?? '').trim().slice(0, max)
}

/** 只留数字的 ID 清洗（主播 UID / 房间号都是纯数字串） */
const cleanDigits = (v, max = 20) => cleanStr(v, max).replace(/\D/g, '')

/** 工作时间归一化：格式合法就补成规范零填充写法，否则回落默认 */
function normalizeWorkHours(v) {
  const m = WORK_HOURS_RE.exec(cleanStr(v, 20))
  if (!m) return DEFAULT_WORK_HOURS
  const [, sh, sm, eh, em] = m.map(Number)
  // 开始 00:00–23:59；结束 00:00–24:00（24:00 只允许是整点 = 当天午夜）
  if (sm > 59 || em > 59) return DEFAULT_WORK_HOURS
  if (sh > 23 || eh > 24) return DEFAULT_WORK_HOURS
  if (eh === 24 && em !== 0) return DEFAULT_WORK_HOURS
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  // 结束必须晚于开始，避免出现「负长度」的工作时间
  if (endMin <= startMin) return DEFAULT_WORK_HOURS
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(sh)}:${pad(sm)}-${pad(eh)}:${pad(em)}`
}

/**
 * 计划时间解析：接受 ISO / 带时区字符串；
 * 前端 datetime-local 那种**没带时区**的 "YYYY-MM-DD HH:MM(:SS)" 按北京时间（+08:00）解释。
 * 返回规范化的 ISO(UTC) 字符串；不合法返回 ''（调用方据此丢弃）。
 */
function parsePlanTime(v) {
  const s = cleanStr(v, 64)
  if (!s) return ''
  const noZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(s)
  const ms = Date.parse(noZone ? `${s.replace(' ', 'T')}+08:00` : s)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

/**
 * 清洗一条主播记录；至少要有 mid 或 roomId 之一，否则返回 null。
 * 注意：order 这里只做基本清洗（0..9999），优先级以**数组顺序**为准，
 * 由 normalizeConfig 统一重排成 0..n-1。
 */
export function normalizeStreamer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const mid = cleanDigits(raw.mid, 20)
  const roomId = cleanDigits(raw.roomId, 20)
  if (!mid && !roomId) return null
  const name = cleanStr(raw.name, 30)
  return {
    mid,
    roomId,
    name: name || (mid ? `主播 ${mid}` : `房间 ${roomId}`),
    enabled: raw.enabled !== false,
    order: clampNum(raw.order, 0, 9999, 0),
  }
}

/** 主播名单：清洗 → 去重（按 mid，只有房间号的按 roomId）→ 截到 5 个 → 重排 order */
function normalizeStreamers(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const s = normalizeStreamer(item)
    if (!s) continue
    // 有 mid 按主播身份去重（同一个人只留优先级最高的那条）；
    // 只给了房间号的按房间号去重（否则两个空 mid 会被误合并成一条）
    const key = s.mid ? `mid:${s.mid}` : `room:${s.roomId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= MAX_STREAMERS) break
  }
  // 数组顺序 = 优先级；order 重排成 0..n-1，别让旧 order 值打乱顺序
  return out.map((s, i) => ({ ...s, order: i }))
}

/**
 * 计划列表：逐条清洗，at 用 Date.parse 校验（不合法整条丢弃），status 走白名单，
 * 最多保留 50 条（超过时丢最老的、保留最近的 50 条）。
 */
function normalizePlans(raw, nowIso) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const at = parsePlanTime(item.at)
    if (!at) continue // at 不合法 → 整条计划丢弃
    const mid = cleanDigits(item.mid, 20)
    const name = cleanStr(item.name, 30)
    const status = cleanStr(item.status, 20)
    out.push({
      // id 缺省时生成一个稳定可删的兜底 id（时间 + 主播 + 过滤后序号）
      id: cleanStr(item.id, 64) || `plan-${Date.parse(at)}-${mid || 'room'}-${out.length}`,
      mid,
      name: name || (mid ? `主播 ${mid}` : ''),
      at,
      createdAt: parsePlanTime(item.createdAt) || nowIso,
      status: PLAN_STATUSES.has(status) ? status : 'pending',
    })
  }
  return out.slice(-MAX_PLANS)
}

/** 问候模板库：每项 ≤20 字、去重、最多 20 条；用户把库删空时回落到默认库 */
function normalizeGreetings(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_GREETINGS]
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const s = cleanStr(item, GREETING_MAX_LEN)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_GREETINGS) break
  }
  // 没有问候库就没法完成「发送弹幕」任务，空数组按默认库处理
  return out.length ? out : [...DEFAULT_GREETINGS]
}

/**
 * 把任意脏输入洗成一份完整、合法的配置。
 * 输出字段与 DEFAULTS 一一对应（白名单：多余字段全部丢掉），数组顺序保持优先级语义。
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const nowIso = new Date().toISOString()
  return {
    enabled: r.enabled !== false,
    streamers: normalizeStreamers(r.streamers),
    autoEnabled: r.autoEnabled !== false,
    autoCheckMs: clampNum(r.autoCheckMs, 60_000, 3_600_000, DEFAULTS.autoCheckMs),
    workHours: normalizeWorkHours(r.workHours),
    workHoursTz: (() => {
      const raw = String(r.workHoursTz || '').trim().slice(0, 64)
      if (raw === 'beijing' || raw === 'local') return raw
      // 允许 IANA 时区名（如 Europe/Berlin），用 Intl 验证一次
      if (raw) {
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: raw })
          return raw
        } catch { /* 非法就回落默认 */ }
      }
      return DEFAULTS.workHoursTz
    })(),
    plans: normalizePlans(r.plans, nowIso),
    taskWatch: r.taskWatch !== false,
    taskDanmaku: r.taskDanmaku !== false,
    taskLike: r.taskLike !== false,
    taskGift: r.taskGift === true,
    aiDanmaku: r.aiDanmaku !== false,
    aiDanmakuMs: clampNum(r.aiDanmakuMs, 30_000, 600_000, DEFAULTS.aiDanmakuMs),
    aiDanmakuDailyMax: clampNum(r.aiDanmakuDailyMax, 10, 300, DEFAULTS.aiDanmakuDailyMax),
    aiDanmakuMode: ['follow', 'generate'].includes(String(r.aiDanmakuMode))
      ? String(r.aiDanmakuMode)
      : DEFAULTS.aiDanmakuMode,
    aiFollowWindowMs: clampNum(r.aiFollowWindowMs, 20_000, 300_000, DEFAULTS.aiFollowWindowMs),
    aiFollowMinCount: clampNum(r.aiFollowMinCount, 2, 20, DEFAULTS.aiFollowMinCount),
    danmakuDailyMax: clampNum(r.danmakuDailyMax, 20, 600, DEFAULTS.danmakuDailyMax),
    danmakuCooldownMs: clampNum(r.danmakuCooldownMs, 1_000, 60_000, DEFAULTS.danmakuCooldownMs),
    templateDanmaku: r.templateDanmaku !== false,
    templateGreetingCount: clampNum(r.templateGreetingCount, 1, 20, DEFAULTS.templateGreetingCount),
    templateSpacingMs: clampNum(r.templateSpacingMs, 10_000, 120_000, DEFAULTS.templateSpacingMs),
    greetingTemplates: normalizeGreetings(r.greetingTemplates),
    likeClicksPerRound: clampNum(r.likeClicksPerRound, 1, 3_000, DEFAULTS.likeClicksPerRound),
    likeRoundMs: clampNum(r.likeRoundMs, 60_000, 3_600_000, DEFAULTS.likeRoundMs),
    watchQn: clampNum(r.watchQn, 80, 400, DEFAULTS.watchQn),
    giftName: cleanStr(r.giftName, 30) || DEFAULTS.giftName,
    giftMaxPrice: clampNum(r.giftMaxPrice, 1, 10_000, DEFAULTS.giftMaxPrice),
    giftMaxPerDay: clampNum(r.giftMaxPerDay, 1, 10, DEFAULTS.giftMaxPerDay),
    llmProvider: cleanStr(r.llmProvider, 40),
    llmModel: cleanStr(r.llmModel, 60),
    llmReasoningEffort: ['off', 'low', 'high', 'max'].includes(String(r.llmReasoningEffort))
      ? String(r.llmReasoningEffort)
      : DEFAULTS.llmReasoningEffort,
    maxLen: clampNum(r.maxLen, 5, 40, DEFAULTS.maxLen),
    logMaxLines: clampNum(r.logMaxLines, 20, 500, DEFAULTS.logMaxLines),
  }
}

/**
 * 只把 patch 里出现过的字段合并进旧配置（设置页可以只传改动的那几项）。
 * 语义与旧插件 lib/config.mjs 相同：先归一化旧配置，再按 DEFAULTS 白名单覆盖，
 * 最后整体再归一化一次。数组字段（streamers/plans/greetingTemplates）是整体替换。
 */
export function mergeConfig(oldCfg, patch) {
  const base = normalizeConfig(oldCfg)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const merged = { ...base }
  for (const k of Object.keys(DEFAULTS)) {
    if (k in patch) merged[k] = patch[k]
  }
  return normalizeConfig(merged)
}
