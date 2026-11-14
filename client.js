/**
 * dsh-bili-duty —— 浏览器半端（设置里的一页：「直播值守」）
 * ============================================================================
 * 自注册协议（与其它第三方 DSH 插件一致）：
 *   window.__ModuleLoader__.load({ id:'dsh-bili-duty', factory:(require)=>({inject,apply}) })
 *   · id 必须等于 package.json 的包名，否则加载器判定「loaded without registering」。
 *   · factory 内只 require('react')；需要别的模块必须写进 package.json 的 dsh.client.external。
 *   · factory 返回 Cordis 插件 { inject:['slots'], apply(ctx) }；
 *     apply 里注册「侧边栏图标（sidebar.panellist）+ 主界面页面（main）」——
 *     不再占用「设置」页，入口和 Mnemon 一样在左侧导航栏（小电视图标）。
 *   · hooks 必须写在组件里所有 early return 之前，否则 React #310。
 *
 * 页面 = 6 个区块：① 状态 hero ② B 站账号 ③ 5 个主播 ④ 值守模式（自动 + 手动计划）
 * ⑤ 任务设置 ⑥ 调试。
 *
 * 保存语义（重要，修掉旧版「开关保存覆盖未保存输入」的 bug）：
 *   · 开关类：点击即 POST /config 即时保存，只把「本次保存的那个字段」合并回草稿；
 *   · 输入类（数字 / 文本 / 下拉 / 问候语）：只改本地 form 草稿，底部「保存全部设置」统一提交；
 *   · 任何即时保存都不会用服务端整份 config 覆盖 form，其它输入框里未保存的内容原样保留。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-duty',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    /* ────────────────────────── HTTP 小工具 ──────────────────────────
       契约：业务错误 = HTTP 200 + { ok:false, error }（调用方自己看 r.ok）；
       HTTP 非 2xx 视为请求失败并抛错；状态轮询每 5 秒一次。 */
    const API = '/api/bili-duty'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))
    const errText = (e) => String((e && (e.message || e.error)) || e || '未知错误')

    /* ────────────────────────── 样式（data-bd-*） ──────────────────────────
       沿用旧设置页的 data-* 卡片/开关/按钮风格，前缀改成 bd；颜色继续用
       --dsw-alias-* 变量 + 兜底，暗色/亮色都能看；品牌色粉 #fb7299 / 蓝 #00aeec。 */
    const CSS = `
[data-bd-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:760px;font-size:13px;}
[data-bd-main]{height:100%;overflow-y:auto;box-sizing:border-box;padding:18px 24px 30px;}
[data-bd-main] [data-bd-page]{margin:0 auto;}
[data-bd-hero]{position:relative;border-radius:14px;padding:16px 18px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));}
[data-bd-hero]::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,#fb7299,#00aeec);}
[data-bd-hero-top]{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
[data-bd-title]{font-size:15px;font-weight:700;letter-spacing:.01em;}
[data-bd-pill]{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:600;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));}
[data-bd-pill][data-tone="live"]{color:#fb7299;border-color:rgba(251,114,153,.5);background:rgba(251,114,153,.1);}
[data-bd-pill][data-tone="bad"]{color:#f59e0b;border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.1);}
[data-bd-pill][data-tone="idle"]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-dot]{width:7px;height:7px;border-radius:50%;background:#fb7299;display:inline-block;margin-right:5px;animation:bd-breathe 2.4s ease-in-out infinite;}
@keyframes bd-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
[data-bd-grid]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}
[data-bd-stat]{padding:9px 10px;border-radius:9px;min-width:0;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.09));}
[data-bd-stat] b{display:block;font-size:14px;font-weight:650;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-bd-stat] span{display:block;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-sec]{display:flex;flex-direction:column;gap:9px;}
[data-bd-h]{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-h]::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-bd-subsec]{font-size:12px;font-weight:650;margin-top:3px;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-bd-grow]{flex:1;min-width:120px;}
[data-bd-label]{font-size:12.5px;}
[data-bd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;font-family:inherit;transition:border-color .15s;}
[data-bd-input]:focus{outline:none;border-color:#00aeec;}
textarea[data-bd-input]{resize:vertical;min-height:96px;line-height:18px;}
select[data-bd-input]{cursor:pointer;}
[data-bd-field-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}
[data-bd-field]{display:flex;flex-direction:column;gap:5px;min-width:0;}
[data-bd-field-top]{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
[data-bd-range]{font-size:10px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-btn]{padding:7px 12px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;transition:background .15s;}
[data-bd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
[data-bd-btn][data-primary]{background:#00aeec;border-color:#00aeec;color:#fff;}
[data-bd-btn][data-primary]:hover{background:#0aa0d8;}
[data-bd-btn][data-danger]{color:#fb7299;border-color:rgba(251,114,153,.4);}
[data-bd-btn][disabled]{opacity:.45;cursor:default;}
[data-bd-btn][data-mini]{padding:4px 8px;font-size:11px;border-radius:7px;}
[data-bd-btn][data-bd-big]{padding:10px 22px;font-size:13.5px;font-weight:700;border-radius:11px;}
[data-bd-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;padding:0;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;}
[data-bd-sw][data-on]{background:#00aeec;}
[data-bd-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;display:block;}
[data-bd-sw][data-on] i{left:19px;}
[data-bd-sw][disabled]{opacity:.45;cursor:default;}
[data-bd-tags]{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;}
[data-bd-tag]{font-size:10px;line-height:15px;padding:1px 7px;border-radius:6px;white-space:nowrap;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-tag][data-tone="ok"]{color:#22c55e;background:rgba(34,197,94,.12);}
[data-bd-tag][data-tone="bad"]{color:#f59e0b;background:rgba(245,158,11,.12);}
[data-bd-tag][data-tone="live"]{color:#fb7299;background:rgba(251,114,153,.14);}
[data-bd-list]{display:flex;flex-direction:column;gap:7px;}
[data-bd-item]{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-bd-item][data-off]{opacity:.5;}
[data-bd-rank]{flex:none;width:22px;height:22px;border-radius:7px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fb7299,#00aeec);color:#fff;margin-top:2px;}
[data-bd-name-row]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-bd-name]{font-size:12.5px;font-weight:600;}
[data-bd-sub]{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg]{font-size:11.5px;line-height:17px;padding:8px 10px;border-radius:9px;word-break:break-all;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-msg][data-tone="good"]{color:#22c55e;background:rgba(34,197,94,.09);}
[data-bd-msg][data-tone="warn"]{color:#f59e0b;background:rgba(245,158,11,.09);}
[data-bd-log]{margin:0;padding:10px 11px;border-radius:9px;max-height:200px;overflow:auto;font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.2));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bd-qr]{flex:none;width:160px;height:160px;padding:8px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.14);}
[data-bd-qr] svg{display:block;width:100%;height:100%;}
[data-bd-savebar]{margin-top:6px;padding:14px 16px;border-radius:12px;position:sticky;bottom:8px;z-index:2;border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.3));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));backdrop-filter:blur(10px);box-shadow:0 4px 16px rgba(0,0,0,.18);}
[data-bd-who]{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-bd-who] em{font-style:normal;font-size:10px;font-weight:600;padding:1px 6px;border-radius:5px;background:rgba(0,174,236,.14);color:#00aeec;}
[data-bd-plan]{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-bd-plan-time]{flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;}
[data-bd-plan-name]{flex:1;min-width:80px;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-plan-cd]{white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bd-plan-title]{flex-basis:100%;min-width:0;font-size:10.5px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`
    /* ────────────────────────── 默认值与格式化工具 ──────────────────────────
       DEFAULT_GREETINGS / DEFAULT_UI 与 lib/duty-config.mjs 的 DEFAULTS 保持同步：
       这里只在后端没返回某字段时兜底；真正的合法范围由服务端 normalizeConfig 再 clamp 一次。 */
    const DEFAULT_GREETINGS = ['来了来了', '主播晚上好', '今天也在播呢', '蹲到啦', '前排听歌', '来了，蹲一会儿', '今天状态不错', '好久不见', '加油呀', '打卡打卡']
    const DEFAULT_UI = {
      autoCheckMin: '15', workHours: '08:00-24:00', workHoursTz: 'beijing', greetingCount: '10', greetingSpacingSec: '30',
      aiIntervalSec: '300', aiDailyMax: '100', danmakuDailyMax: '150', danmakuCooldownSec: '3',
      aiMode: 'follow', aiFollowWindowSec: '60', aiFollowMinCount: '3',
      maxLen: '20', likeClicks: '300', likeRoundMin: '10', likeDailyMax: '600', giftDailyMax: '5', watchQn: '150',
    }
    const WH_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d\s*-\s*(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$/
    const optionPairs = (pairs) => pairs.map(([value, label]) => ({ value, label }))
    const TASK_OPTIONS = optionPairs([['all', '全部任务（按顺序跑一遍）'], ['watch', '观看直播（上报心跳）'], ['danmaku', '发送弹幕（含进房问候）'], ['like', '点赞（一轮）'], ['gift', '打赏（1 个粉丝团灯牌）']])
    const TASK_LABEL = Object.fromEntries(TASK_OPTIONS.map((o) => [o.value, o.label]))
    const PLAN_TONE = { pending: 'idle', fired: 'live', missed: 'bad', cancelled: 'idle', done: 'ok' }
    const PLAN_LABEL = { pending: '等待中', fired: '已进房', missed: '已错过', cancelled: '已取消', done: '已完成' }
    const GIFT_LABEL = { done: '打赏完成 ✓', skipped_balance: '打赏跳过（余额不足）', disabled: '打赏未开启', failed: '打赏失败' }

    const pad2 = (n) => String(n).padStart(2, '0')
    const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local' } catch { return 'local' } }
    /* B站 动态接口的 timezone_offset 参数 = JS getTimezoneOffset()（东八区 -480、柏林冬令时 -60）；
       卡片文案里的「明天 03:00」会按这个偏移渲染，解析时也要用同一个偏移。 */
    const browserTzOffset = () => { try { return new Date().getTimezoneOffset() } catch { return -60 } }
    const clampInt = (v, min, max, dflt) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt
    }
    const fmtDur = (ms) => {
      const total = Math.floor(Math.max(0, Number(ms) || 0) / 1000)
      if (total < 60) return total + ' 秒'
      const m = Math.floor(total / 60)
      if (m < 60) return m + ' 分 ' + (total % 60) + ' 秒'
      return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
    }
    const fmtClock = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
    const fmtBytes = (n) => {
      const v = Math.max(0, Number(n) || 0)
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
      return (v / 1024 / 1024).toFixed(1) + ' MB'
    }
    /* 界面时间统一按浏览器本地时区展示（用户在柏林就显示柏林时间）。
       B站 预约卡片文案里的「明天 03:00」是北京时间，解析时已换算成绝对时刻，
       这里再按本地时区展示；北京时间只作为悬停提示。opts.tz=false 可去掉「（本地时间）」后缀。 */
    const fmtPlanTime = (iso, opts) => {
      const ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return String(iso || '—')
      const d = new Date(ts)
      const text = `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      return opts && opts.tz === false ? text : text + '（本地时间）'
    }
    /* 北京时间（B站 官方时间），只用于悬停提示/日志对照 */
    const fmtBeijingTime = (iso) => {
      const ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return String(iso || '—')
      const d = new Date(ts + 8 * 3600 * 1000)
      return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
    }
    /* 本机时间别名（兼容旧调用） */
    const fmtLocalTime = (iso) => fmtPlanTime(iso, { tz: false })
    const toLocalInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
    const parseGreetings = (text) => String(text || '').split(/\r?\n/)
      .map((line) => line.trim().slice(0, 20))
      .filter((s, i, arr) => s && arr.indexOf(s) === i)
      .slice(0, 20)
    const sortRows = (list) => (Array.isArray(list) ? list : [])
      .map((s, i) => ({
        mid: String(s.mid || ''),
        roomId: String(s.roomId || ''),
        name: String(s.name || ''),
        enabled: s.enabled !== false,
        order: Number.isFinite(Number(s.order)) ? Number(s.order) : i,
      }))
      .filter((s) => s.mid || s.roomId)
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
    /* 后端 config（毫秒）→ 本地 form 草稿（分钟/秒等界面单位） */
    const configToForm = (cfg) => {
      const c = cfg || {}
      return {
        autoEnabled: c.autoEnabled !== false,
        taskWatch: c.taskWatch !== false,
        taskDanmaku: c.taskDanmaku !== false,
        taskLike: c.taskLike !== false,
        taskGift: c.taskGift === true,
        templateDanmaku: c.templateDanmaku !== false,
        aiDanmaku: c.aiDanmaku !== false,
        autoCheckMin: String(Math.round((Number(c.autoCheckMs) || 900000) / 60000)),
        workHours: String(c.workHours || DEFAULT_UI.workHours),
        workHoursTz: c.workHoursTz === 'beijing' ? 'beijing' : 'local',
        greetingCount: String(c.templateGreetingCount ?? DEFAULT_UI.greetingCount),
        greetingSpacingSec: String(Math.round((Number(c.templateSpacingMs) || 30000) / 1000)),
        greetingText: (Array.isArray(c.greetingTemplates) ? c.greetingTemplates : DEFAULT_GREETINGS).join('\n'),
        aiMode: c.aiDanmakuMode === 'generate' ? 'generate' : 'follow',
        aiFollowWindowSec: String(Math.round((Number(c.aiFollowWindowMs) || 60000) / 1000)),
        aiFollowMinCount: String(c.aiFollowMinCount ?? DEFAULT_UI.aiFollowMinCount),
        aiIntervalSec: String(Math.round((Number(c.aiDanmakuMs) || 300000) / 1000)),
        aiDailyMax: String(c.aiDanmakuDailyMax ?? DEFAULT_UI.aiDailyMax),
        danmakuDailyMax: String(c.danmakuDailyMax ?? DEFAULT_UI.danmakuDailyMax),
        danmakuCooldownSec: String(Math.round((Number(c.danmakuCooldownMs) || 3000) / 1000)),
        maxLen: String(c.maxLen ?? DEFAULT_UI.maxLen),
        likeClicks: String(c.likeClicksPerRound ?? DEFAULT_UI.likeClicks),
        likeRoundMin: String(Math.round((Number(c.likeRoundMs) || 600000) / 60000)),
        likeDailyMax: String(c.likeDailyMax ?? DEFAULT_UI.likeDailyMax),
        giftDailyMax: String(c.giftMaxPerDay ?? DEFAULT_UI.giftDailyMax),
        watchQn: String(c.watchQn ?? DEFAULT_UI.watchQn),
        streamers: sortRows(c.streamers),
      }
    }
    /* 本地 form 草稿 → 提交给 POST /config 的 patch（前后端都会 clamp，这里先按提示范围修一遍） */
    const formToPatch = (f) => ({
      autoEnabled: !!f.autoEnabled,
      autoCheckMs: clampInt(Number(f.autoCheckMin) * 60000, 60000, 3600000, 900000),
      workHours: String(f.workHours || '').trim() || DEFAULT_UI.workHours,
      workHoursTz: f.workHoursTz === 'beijing' ? 'beijing' : browserTz(),
      taskWatch: !!f.taskWatch,
      taskDanmaku: !!f.taskDanmaku,
      taskLike: !!f.taskLike,
      taskGift: !!f.taskGift,
      templateDanmaku: !!f.templateDanmaku,
      templateGreetingCount: clampInt(f.greetingCount, 1, 20, 10),
      templateSpacingMs: clampInt(Number(f.greetingSpacingSec) * 1000, 10000, 120000, 30000),
      greetingTemplates: parseGreetings(f.greetingText),
      aiDanmaku: !!f.aiDanmaku,
      aiDanmakuMode: f.aiMode === 'generate' ? 'generate' : 'follow',
      aiDanmakuMs: clampInt(Number(f.aiIntervalSec) * 1000, 30000, 600000, 300000),
      aiDanmakuDailyMax: clampInt(f.aiDailyMax, 10, 300, 100),
      aiFollowWindowMs: clampInt(Number(f.aiFollowWindowSec) * 1000, 20000, 300000, 60000),
      aiFollowMinCount: clampInt(f.aiFollowMinCount, 2, 20, 3),
      danmakuDailyMax: clampInt(f.danmakuDailyMax, 20, 600, 150),
      danmakuCooldownMs: clampInt(Number(f.danmakuCooldownSec) * 1000, 1000, 60000, 3000),
      maxLen: clampInt(f.maxLen, 5, 40, 20),
      likeClicksPerRound: clampInt(f.likeClicks, 1, 3000, 300),
      likeRoundMs: clampInt(Number(f.likeRoundMin) * 60000, 60000, 3600000, 600000),
      likeDailyMax: clampInt(f.likeDailyMax, 1, 10000, 600),
      giftMaxPerDay: clampInt(f.giftDailyMax, 1, 10, 5),
      watchQn: clampInt(f.watchQn, 80, 400, 150),
      streamers: sortRows(f.streamers).map((s, i) => ({ ...s, order: i })),
    })

    /* 只读状态里的一些小查询（对服务端数组做防御，字段缺失时页面不至于整块崩掉） */
    const arr = (v) => (Array.isArray(v) ? v : [])
    const isLive = (s) => Number(s && s.liveStatus) === 1
    const taskOf = (st, s) => {
      const tasks = arr(st.tasks)
      return tasks.find((t) => String(t.mid) === String(s.mid)) ||
        tasks.find((t) => String(t.roomId) === String(s.roomId)) || null
    }
    const infoOf = (st, s) => arr(st.streamers).find((x) => String(x.mid) === String(s.mid)) || null
    const taskDone = (t, cfg) => {
      if (!t) return false
      const c = cfg || {}
      if (c.taskWatch === false && c.taskDanmaku === false && c.taskLike === false && !c.taskGift) return false
      if (c.taskWatch !== false && !(Number(t.watchMins) > 0)) return false
      if (c.taskDanmaku !== false && !t.danmakuDone) return false
      if (c.taskLike !== false && !t.likeDone) return false
      if (c.taskGift === true && !(t.giftState === 'done' || t.giftState === 'skipped_balance')) return false
      return true
    }
    const giftText = (t) => (t && t.giftState ? (GIFT_LABEL[t.giftState] || '打赏' + t.giftState) : '打赏未做')
    const balanceText = (st) => {
      const w = (st && (st.giftBalance || st.wallet || st.balance)) || {}
      if (Number.isFinite(Number(w.gold))) return `电池余额：${(Number(w.gold) / 100).toFixed(2)} 电池（gold ${w.gold}）`
      if (Number.isFinite(Number(w.battery))) return `电池余额：${w.battery} 电池`
      return '电池余额：打赏开启后自动查询'
    }
    const planCountdown = (p, now) => {
      const at = Date.parse(p.at)
      if (!Number.isFinite(at)) return '时间无效'
      if (p.status === 'pending') return at > now ? '还有 ' + fmtDur(at - now) : '到点未开播，等待中'
      if (p.status === 'fired') return '值守中'
      return ''
    }

    /* ────────────────────────── 基础 UI 组件 ────────────────────────── */
    function Note({ children, style }) {
      return h('div', { 'data-bd-note': '', style }, children)
    }
    function Row({ children, style }) {
      return h('div', { 'data-bd-row': '', style }, children)
    }
    function Section({ title, children }) {
      return h('div', { 'data-bd-sec': '' }, h('div', { 'data-bd-h': '' }, title), children)
    }
    function Sub({ children }) {
      return h('div', { 'data-bd-subsec': '' }, children)
    }
    function FieldGrid({ children }) {
      return h('div', { 'data-bd-field-grid': '' }, children)
    }
    function Tag({ children, tone, title }) {
      return h('span', { 'data-bd-tag': '', 'data-tone': tone, title: title || undefined }, children)
    }
    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }
    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h(Row, null,
        h('div', { 'data-bd-grow': '' },
          h('div', { 'data-bd-label': '' }, label),
          note ? h(Note, null, note) : null),
        h(Switch, { on, onChange, disabled }))
    }
    function NumField({ label, note, value, onChange, min, max, unit, disabled }) {
      return h('div', { 'data-bd-field': '' },
        h('div', { 'data-bd-field-top': '' },
          h('span', { 'data-bd-label': '' }, label),
          h('span', { 'data-bd-range': '' }, `${min}–${max}${unit || ''}`)),
        h('input', {
          'data-bd-input': '', 'data-num': '', type: 'number', inputMode: 'numeric',
          min, max, value: value ?? '', disabled: Boolean(disabled),
          onChange: (e) => onChange(e.target.value),
        }),
        note ? h(Note, null, note) : null)
    }
    function TextField({ label, note, value, onChange, placeholder, disabled }) {
      return h('div', { 'data-bd-field': '' },
        h('div', { 'data-bd-field-top': '' }, h('span', { 'data-bd-label': '' }, label)),
        h('input', {
          'data-bd-input': '', value: value ?? '', placeholder: placeholder || '', disabled: Boolean(disabled),
          onChange: (e) => onChange(e.target.value),
        }),
        note ? h(Note, null, note) : null)
    }
    function TextAreaField({ label, note, value, onChange, rows }) {
      return h('div', { 'data-bd-field': '' },
        h('div', { 'data-bd-field-top': '' }, h('span', { 'data-bd-label': '' }, label)),
        h('textarea', {
          'data-bd-input': '', rows: rows || 6, value: value ?? '',
          onChange: (e) => onChange(e.target.value),
        }),
        note ? h(Note, null, note) : null)
    }
    function SelectField({ label, note, value, onChange, options, disabled }) {
      return h('div', { 'data-bd-field': '' },
        h('div', { 'data-bd-field-top': '' }, h('span', { 'data-bd-label': '' }, label)),
        h('select', {
          'data-bd-input': '', value: value ?? '', disabled: Boolean(disabled),
          onChange: (e) => onChange(e.target.value),
        }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        note ? h(Note, null, note) : null)
    }
    /* 每个主播的今日任务徽章：观看分钟 · 弹幕 · 点赞 · 打赏 */
    function TaskTags({ t, cfg }) {
      if (!t) return h('div', { 'data-bd-tags': '' }, h(Tag, { tone: 'idle' }, '今日暂无任务数据'))
      const tags = [
        h(Tag, { key: 'w', tone: Number(t.watchMins) > 0 ? 'ok' : undefined }, '观看 ' + (Number(t.watchMins) || 0) + ' 分'),
        h(Tag, { key: 'd', tone: t.danmakuDone ? 'ok' : 'bad' }, t.danmakuDone ? '弹幕 ✓' + (t.danmakuCount ? '（' + t.danmakuCount + '）' : '') : '弹幕未做'),
        h(Tag, { key: 'l', tone: t.likeDone ? 'ok' : 'bad' }, t.likeDone ? '点赞 ✓' + (t.likeClicks ? '（' + t.likeClicks + '）' : '') : '点赞未做'),
      ]
      if (cfg && cfg.taskGift) tags.push(h(Tag, { key: 'g', tone: (t.giftState === 'done' || t.giftState === 'skipped_balance') ? 'ok' : 'bad' }, giftText(t)))
      if (t.error) tags.push(h(Tag, { key: 'e', tone: 'bad', title: String(t.error) }, '有错误'))
      return h('div', { 'data-bd-tags': '' }, tags)
    }

    /* ────────────────────────── ① 状态 hero ────────────────────────── */
    function StatusHero({ st, cfg, busy, now, onTick, onStop }) {
      const streamers = st.streamers || []
      const enabled = streamers.filter((s) => s.enabled !== false)
      const done = enabled.filter((s) => taskDone(taskOf(st, s), cfg)).length
      const live = streamers.filter(isLive).length
      const mode = st.mode || {}
      const next = mode.auto === false ? 0 : (Number(mode.nextCheckAt) || 0)
      const main = st.main
      const visit = st.visiting
      const login = st.login || {}
      let pillText = '待命中'
      let tone = 'idle'
      if (st.config && st.config.enabled === false) pillText = '值守已关闭'
      else if (!login.loggedIn) { pillText = '未登录账号'; tone = 'bad' }
      else if (main) { pillText = '值守中'; tone = 'live' }
      else if (mode.auto === false) pillText = '自动模式已关'
      return h('div', { 'data-bd-hero': '' },
        h('div', { 'data-bd-hero-top': '' },
          h('span', { 'data-bd-title': '' }, '直播值守'),
          h('span', { 'data-bd-pill': '', 'data-tone': tone }, tone === 'live' ? h('span', { 'data-bd-dot': '' }) : null, pillText),
          h('span', { 'data-bd-note': '', style: { marginLeft: 'auto' } }, 'v' + (st.version || '?'))),
        h('div', { 'data-bd-grid': '' },
          h('div', { 'data-bd-stat': '' },
            h('b', {}, main ? (main.name || '未知主播') : '—'),
            h('span', {}, main ? '主看房 · 房间 ' + (main.roomId || '—') : '还没有主看房')),
          h('div', { 'data-bd-stat': '' },
            h('b', {}, mode.auto === false ? '已关闭' : '已开启'),
            h('span', {}, mode.auto === false ? '自动检查不生效' : (mode.inWorkHours === false ? '工作时间外（仅计划执行）' : '工作时间内'))),
          h('div', { 'data-bd-stat': '' },
            h('b', {}, done + '/' + enabled.length),
            h('span', {}, '今日任务完成 · ' + live + ' 位在播')),
          h('div', { 'data-bd-stat': '' },
            h('b', {}, next ? fmtDur(Math.max(0, next - now)) : '—'),
            h('span', {}, next ? '下次自动检查 ' + fmtClock(next) : '自动检查未开启'))),
        h(Row, { style: { marginTop: '10px' } },
          h(Tag, { tone: main ? 'live' : 'idle' }, '主看房'),
          h('span', { 'data-bd-note': '' }, main
            ? `${main.name || '未知主播'} · 房间 ${main.roomId || '—'} · 已守 ${fmtDur(now - (Number(main.since) || Date.parse(main.since) || now))}`
            : '暂无（没有在播的主播，或还没到检查时间）'),
          visit ? h(Tag, { tone: 'bad' }, '任务房') : null,
          visit ? h('span', { 'data-bd-note': '' }, `${visit.name || '未知主播'} · ${visit.why || '补任务'}`) : null),
        st.watch ? h(Row, { style: { marginTop: '6px' } },
          h(Tag, { tone: st.watch.error ? 'bad' : (st.watch.running ? 'ok' : 'idle') }, '观看上报'),
          h('span', { 'data-bd-note': '' }, `已上报 ${st.watch.reportedMins || 0} 分`
            + (st.watch.task ? ' · 今日 ' + st.watch.task : '')
            + (st.watch.intervalSec ? ' · 心跳 ' + st.watch.intervalSec + 's' : '')
            + (st.watch.error ? ' · ' + st.watch.error : ''))) : null,
        st.lastError ? h('div', { 'data-bd-msg': '', 'data-tone': 'warn', style: { marginTop: '10px' } }, '⚠ 最近错误：' + st.lastError) : null,
        h(Row, { style: { marginTop: '12px' } },
          h('button', { 'data-bd-btn': '', disabled: busy === 'tick', onClick: onTick }, busy === 'tick' ? '检查中…' : '立即检查'),
          h('button', {
            'data-bd-btn': '', 'data-danger': '',
            disabled: busy === 'stop' || (!main && !visit), onClick: onStop,
          }, busy === 'stop' ? '停止中…' : '停止当前场'),
          main && main.roomId
            ? h('a', { 'data-bd-btn': '', href: 'https://live.bilibili.com/' + main.roomId, target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '打开直播间')
            : null))
    }

    /* ────────────────────────── ② B 站账号（扫码登录） ────────────────────────── */
    function AccountCard({ st, refresh, setMsg }) {
      const [qr, setQr] = React.useState(null)   // { key, svg }
      const [qrMsg, setQrMsg] = React.useState('')
      const [qrBusy, setQrBusy] = React.useState(false)
      const login = st.login || {}
      /* 扫码轮询：hook 必须在任何 early return 之前（本组件没有 early return，保持这个顺序） */
      React.useEffect(() => {
        if (!qr || !qr.key) return
        let alive = true
        const ask = async () => {
          try {
            const r = await jpost('/login/poll', { key: qr.key })
            if (!alive) return
            if (r.ok && r.status === 'ok') {
              setQr(null)
              setQrMsg('')
              setMsg({ tone: 'good', text: '登录成功' + (r.uname ? '：' + r.uname : '') })
              refresh()
              return
            }
            if (r.status === 'expired') {
              setQr(null)
              setQrMsg('二维码过期了 —— 点「重新生成」再来一张')
              return
            }
            if (r.status === 'scanned') setQrMsg('扫到了，请在手机上点确认')
            else if (r.status === 'waiting') setQrMsg('用手机 B站 → 「扫一扫」扫这张码')
            else if (!r.ok) setQrMsg(r.error || '查询登录状态失败')
          } catch { /* 下一轮再问 */ }
        }
        ask()
        const t = setInterval(ask, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [qr, refresh, setMsg])
      const startLogin = async () => {
        setQrBusy(true)
        setQrMsg('正在向 B站 要二维码…')
        try {
          const r = await jpost('/login/qr')
          if (!r.ok) { setQrMsg(r.error || '要不到二维码'); return }
          setQr({ key: r.key, svg: r.svg })
          setQrMsg('用手机 B站 → 「扫一扫」扫这张码')
        } catch (e) {
          setQrMsg('要不到二维码：' + errText(e))
        } finally { setQrBusy(false) }
      }
      const logout = async () => {
        if (!window.confirm('退出后需要重新扫码才能登录，确定退出吗？')) return
        try {
          const r = await jpost('/logout')
          if (!r.ok) throw new Error(r.error || '退出失败')
          setQr(null)
          setQrMsg('')
          setMsg({ tone: 'good', text: '已退出登录，想换号再扫一次码就行' })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '退出失败：' + errText(e) }) }
      }
      return h(Section, { title: 'B 站账号' },
        h('div', { 'data-bd-who': '' },
          h('span', {}, login.loggedIn ? (login.uname ? '已登录 · ' + login.uname : '已登录') : '还没有登录'),
          login.loggedIn ? h('em', {}, '本机凭证') : null),
        login.loggedIn && login.uid ? h(Note, null, 'UID ' + login.uid + ' · 发弹幕、点赞、打赏都使用这个账号') : null,
        login.loggedIn
          ? h(Row, null,
            h('div', { 'data-bd-grow': '' }, h(Note, null, '凭证只保存在本机插件家目录，不会上传。想换号：先退出，再重新扫码。')),
            h('button', { 'data-bd-btn': '', 'data-danger': '', onClick: logout }, '退出登录'))
          : h(Row, null,
            h('div', { 'data-bd-grow': '' }, h(Note, null, '扫一次码，插件自己存一份本机凭证，以后不用再登。')),
            h('button', {
              'data-bd-btn': '', 'data-primary': '', disabled: qrBusy,
              onClick: startLogin,
            }, qrBusy ? '正在要码…' : qr ? '重新生成二维码' : '扫码登录')),
        (qr || qrMsg)
          ? h(Row, { style: { alignItems: 'flex-start', marginTop: '4px' } },
            qr ? h('div', { 'data-bd-qr': '', dangerouslySetInnerHTML: { __html: qr.svg } }) : null,
            h('div', { 'data-bd-grow': '' },
              h(Note, null, qrMsg || ''),
              qr ? h(Note, { style: { marginTop: '6px', opacity: 0.8 } }, '手机：B站 → 我的 → 扫一扫 → 确认登录') : null))
          : null)
    }

    /* ────────────────────────── ③ 5 个主播 ────────────────────────── */
    function StreamersCard({ st, form, busy, actions, setMsg }) {
      const [addUid, setAddUid] = React.useState('')
      const [addName, setAddName] = React.useState('')
      const [addRoom, setAddRoom] = React.useState('')
      const [addHint, setAddHint] = React.useState('')
      const [querying, setQuerying] = React.useState(false)
      const [editing, setEditing] = React.useState(null) // { index, uid, name }
      const list = form.streamers || []
      const full = list.length >= 5
      const saving = busy === 'save'

      /* 「查询」按钮：只做 UID → 昵称/房间号的便利查询；
         后端若没实现 /resolve（契约里没列），查询失败也不影响手动添加。 */
      const lookup = async () => {
        const k = String(addUid || '').trim()
        if (!k) { setAddHint('先填主播 UID（数字）'); return }
        setQuerying(true)
        setAddHint('正在查询…')
        try {
          let found = null
          try {
            const r = await jpost('/resolve', { mid: k })
            if (r.ok && (r.stream || r.info)) found = { ...(r.stream || {}), ...(r.info || {}) }
          } catch { /* 该路由不存在时按查不到处理 */ }
          if (!found) {
            try {
              const r = await jpost('/resolve', { roomId: k })
              if (r.ok && (r.stream || r.info)) found = { ...(r.stream || {}), ...(r.info || {}) }
            } catch { /* 同上 */ }
          }
          if (found) {
            const name = found.uname || found.name || ''
            const roomId = found.roomId || found.realRoomId || ''
            if (name) setAddName((prev) => prev || String(name))
            setAddRoom(String(roomId || ''))
            setAddHint('查到了：' + (name || '未知昵称') + (roomId ? ' · 房间号 ' + roomId : ''))
          } else {
            setAddHint('没有可用的查询接口（后端会在值守检查开播时自动解析昵称/房间号）—— 填好名字直接点「添加」即可')
          }
        } catch (e) {
          setAddHint('查询失败：' + errText(e) + '（可以直接手动添加）')
        } finally { setQuerying(false) }
      }
      const add = () => {
        const uid = String(addUid || '').trim()
        if (!/^\d{4,20}$/.test(uid)) { setAddHint('UID 应该是 4–20 位纯数字（B站个人主页地址里那串数字）'); return }
        if (list.some((s) => String(s.mid) === uid)) { setAddHint('这个主播已经在列表里了'); return }
        if (full) { setAddHint('最多 5 个主播，要先删一个'); return }
        actions.add({ mid: uid, roomId: addRoom, name: String(addName || '').trim() })
        setAddUid(''); setAddName(''); setAddRoom(''); setAddHint('')
        setMsg({ tone: 'good', text: '已添加主播：' + (String(addName || '').trim() || uid) })
      }

      const rowAction = (s, i) => {
        if (saving) return null
        if (editing && editing.index === i) {
          return h(Row, null,
            h('button', {
              'data-bd-btn': '', 'data-primary': '', 'data-mini': '',
              onClick: () => { if (actions.update(i, { mid: editing.uid, name: editing.name })) setEditing(null) },
            }, '保存'),
            h('button', { 'data-bd-btn': '', 'data-mini': '', onClick: () => setEditing(null) }, '取消'))
        }
        return h(Row, null,
          h(Switch, { on: s.enabled !== false, onChange: (v) => actions.toggle(i, v), disabled: saving }),
          h('button', { 'data-bd-btn': '', 'data-mini': '', disabled: i === 0, title: '上移（更优先）', onClick: () => actions.move(i, -1) }, '↑'),
          h('button', { 'data-bd-btn': '', 'data-mini': '', disabled: i === list.length - 1, title: '下移', onClick: () => actions.move(i, 1) }, '↓'),
          h('button', {
            'data-bd-btn': '', 'data-mini': '',
            onClick: () => setEditing({ index: i, uid: String(s.mid || ''), name: String(s.name || '') }),
          }, '编辑'),
          h('button', {
            'data-bd-btn': '', 'data-mini': '', 'data-danger': '',
            onClick: () => { if (window.confirm('从列表删除「' + (s.name || s.mid) + '」？')) actions.remove(i) },
          }, '删除'))
      }

      return h(Section, { title: '5 个主播（顺序即优先级）' },
        h(Note, null, '按顺序值守：列表越靠前优先级越高。开播状态与今日任务徽章由后台自动更新；昵称/UID 可在行内「编辑」。'),
        h('div', { 'data-bd-list': '' },
          list.map((s, i) => {
            const info = infoOf(st, s) || s
            const t = taskOf(st, s)
            const live = isLive(info)
            const editingThis = editing && editing.index === i
            return h('div', { 'data-bd-item': '', 'data-off': s.enabled === false ? '' : undefined, key: s.mid || 'row' + i },
              h('div', { 'data-bd-rank': '' }, String(i + 1)),
              h('div', { 'data-bd-grow': '' },
                editingThis
                  ? h('div', { 'data-bd-field-grid': '' },
                    h(TextField, {
                      label: '主播 UID', value: editing.uid, placeholder: '数字 UID',
                      onChange: (v) => setEditing((e) => ({ ...e, uid: v })),
                      note: '改了 UID 后房间号会由后台重新解析',
                    }),
                    h(TextField, {
                      label: '显示名字', value: editing.name, placeholder: '方便自己认人',
                      onChange: (v) => setEditing((e) => ({ ...e, name: v })),
                      note: '最多 30 个字',
                    }))
                  : h('div', null,
                    h('div', { 'data-bd-name-row': '' },
                      h('span', { 'data-bd-name': '' }, s.name || '（未命名主播）'),
                      h(Tag, { tone: live ? 'live' : 'idle' }, live ? '直播中' : '未开播'),
                      s.enabled === false ? h(Tag, { tone: 'idle' }, '已停用') : null,
                      info.liveTitle ? h(Tag, { title: String(info.liveTitle) }, String(info.liveTitle).slice(0, 18)) : null),
                    h('div', { 'data-bd-sub': '' }, 'UID ' + (s.mid || '—') + (s.roomId ? ' · 房间 ' + s.roomId : ' · 房间号待解析')),
                    h(TaskTags, { t, cfg: form }))),
              rowAction(s, i))
          }),
          !list.length ? h(Note, null, '还没有主播。在下面添加 1–5 个，值守才会开始工作。') : null),
        h(Sub, null, '添加主播（最多 5 个，顺序即优先级）'),
        h(Row, null,
          h('div', { 'data-bd-grow': '' },
            h('input', {
              'data-bd-input': '', value: addUid, placeholder: '主播 UID（数字），如 23209281',
              onChange: (e) => { setAddUid(e.target.value); setAddRoom(''); setAddHint('') },
              onKeyDown: (e) => { if (e.key === 'Enter') lookup() },
            })),
          h('div', { 'data-bd-grow': '' },
            h('input', {
              'data-bd-input': '', value: addName, placeholder: '显示名字（可留空，查询后自动填）',
              onChange: (e) => { setAddName(e.target.value); setAddHint('') },
            })),
          h('button', { 'data-bd-btn': '', disabled: querying || full, onClick: lookup }, querying ? '查询中…' : '查询'),
          h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: saving || full, onClick: add }, '添加')),
        addHint ? h(Note, null, addHint) : null,
        h(Note, null, full
          ? '已经满 5 个了，要加新的先删一个（在行尾点「删除」）。'
          : 'UID 就是 B 站个人主页地址里的那串数字。添加后由后台解析直播间号；暂时查不到也能先加，等开播时状态会自动更新。'))
    }

    /* ────────────────────────── ④ 值守模式（自动 + 手动计划） ────────────────────────── */
    function ModeCard({ st, form, setForm, saveToggle, onAddPlan, onRemovePlan, onRefresh, busy, now }) {
      const [planMid, setPlanMid] = React.useState('')
      const [planAt, setPlanAt] = React.useState('')
      const streamers = form.streamers || []
      const midValue = streamers.some((s) => String(s.mid) === String(planMid))
        ? planMid
        : (streamers[0] ? String(streamers[0].mid) : '')
      const mode = st.mode || {}
      const next = mode.auto === false ? 0 : (Number(mode.nextCheckAt) || 0)
      const plans = (st.plans || []).slice().sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
      /* ── 个人动态 → 两类识别（①预约/文字/卡片 ②日程表图片）→ 导入计划 ── */
      const [dyns, setDyns] = React.useState(null)
      const [dynLoading, setDynLoading] = React.useState('')
      const [dynMsg, setDynMsg] = React.useState(null)
      const [delAfterImport, setDelAfterImport] = React.useState(true)
      const [resvArea, setResvArea] = React.useState(null)
      const [schedArea, setSchedArea] = React.useState(null)
      const areaKey = (r) => String(r.mid || r.name) + '|' + String(r.at || '')
      const bumpArea = (kind, fn) => (kind === 'reserve' ? setResvArea(fn) : setSchedArea(fn))
      const loadDynamics = async () => {
        setDynLoading('list'); setDynMsg(null)
        try {
          const d = await jget('/dynamics?tzOffset=' + browserTzOffset())
          if (!d || d.ok === false) throw new Error((d && d.error) || '读取失败')
          const items = Array.isArray(d.items) ? d.items : []
          setDyns(items)
          const textCnt = items.filter((x) => String(x.text || '').trim() || x.reserve).length
          const imgCnt = items.filter((x) => (x.images || []).length).length
          setDynMsg({ tone: 'good', text: `读到 ${items.length} 条动态（文字/卡片 ${textCnt} 条，图片 ${imgCnt} 条）` })
        } catch (e) {
          setDyns(null)
          setDynMsg({ tone: 'warn', text: '读取动态失败：' + errText(e) })
        } finally { setDynLoading('') }
      }
      const removeDynamic = async (id) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('确定删除这条动态？（不可恢复）')) return
        setDynLoading('delete')
        try {
          const r = await jpost('/dynamics/delete', { id })
          if (!r || r.ok === false) throw new Error((r && r.error) || '删除失败')
          setDyns((list) => (Array.isArray(list) ? list.filter((x) => String(x.id) !== String(id)) : list))
          setDynMsg({ tone: 'good', text: '已删除这条动态' })
        } catch (e) {
          setDynMsg({ tone: 'warn', text: '删除失败：' + errText(e) })
        } finally { setDynLoading('') }
      }
      const identify = async (kind, id) => {
        const loading = kind === 'reserve' ? 'parse-reserve' : 'parse-schedule'
        setDynLoading(loading); setDynMsg(null); bumpArea(kind, () => null)
        try {
          const body = kind === 'reserve' ? { id, withImages: false, cardOnly: true } : { id, withImages: true, skipCard: true }
          const r = await jpost('/dynamics/parse', body)
          if (!r || r.ok === false) throw new Error((r && r.error) || '识别失败')
          const items = Array.isArray(r.items) ? r.items : []
          const picked = {}
          for (const it of items) if (it.mid && it.at) picked[areaKey(it)] = true
          const viaCard = r.source === 'card'
          let text = ''
          if (items.length) {
            text = viaCard ? `从预约卡片直接读取 ${items.length} 条（未用模型）`
              : (kind === 'reserve' ? `AI 识别出 ${items.length} 条预约` : `日程表识别出 ${items.length} 条场次`) + (r.imageCount ? `（含 ${r.imageCount} 张图片）` : '')
            if (items.some((x) => !x.matched || !x.mid)) text += '；有未匹配到主播名单的项，导入时会跳过'
          } else {
            text = viaCard ? '卡片里没解析出预约信息'
              : (kind === 'reserve' ? '这条动态里没有识别出明确的直播预约' : '图片里没有识别出明确的日程场次')
          }
          bumpArea(kind, () => ({ items, picked, sourceId: String(id || ''), msg: { tone: items.length ? 'good' : 'warn', text } }))
        } catch (e) {
          bumpArea(kind, () => ({ items: [], picked: {}, sourceId: '', msg: { tone: 'warn', text: '识别失败：' + errText(e) } }))
        } finally { setDynLoading('') }
      }
      const importArea = async (kind) => {
        const area = kind === 'reserve' ? resvArea : schedArea
        if (!area) return
        const items = area.items.filter((r) => area.picked[areaKey(r)] && r.mid && r.at)
        if (!items.length) {
          bumpArea(kind, (a) => ({ ...a, msg: { tone: 'warn', text: '先勾选要导入的条目（未匹配主播/时间不确定的会跳过）' } }))
          return
        }
        const loading = kind === 'reserve' ? 'import-reserve' : 'import-schedule'
        setDynLoading(loading)
        try {
          const r = await jpost('/plans', { action: 'import', items: items.map((x) => ({ mid: x.mid, name: x.name, title: x.title || '', at: x.at })) })
          if (!r || r.ok === false) throw new Error((r && r.error) || '导入失败')
          let text = `已导入 ${r.added} 条计划` + (r.updated ? `，补充标题 ${r.updated} 条` : '') + (r.skipped ? `，跳过 ${r.skipped} 条` : '')
          let tone = 'good'
          if (delAfterImport && area.sourceId && r.added > 0) {
            try {
              const d = await jpost('/dynamics/delete', { id: area.sourceId })
              if (d && d.ok) {
                setDyns((list) => (Array.isArray(list) ? list.filter((x) => String(x.id) !== String(area.sourceId)) : list))
                text += '；已删除对应的转发动态'
              } else {
                text += '；但删除动态失败：' + ((d && d.error) || '未知原因')
                tone = 'warn'
              }
            } catch (e) {
              text += '；但删除动态失败：' + errText(e)
              tone = 'warn'
            }
          }
          bumpArea(kind, () => ({ items: [], picked: {}, sourceId: '', msg: { tone, text } }))
          if (onRefresh) onRefresh()
        } catch (e) {
          bumpArea(kind, (a) => ({ ...a, msg: { tone: 'warn', text: '导入失败：' + errText(e) } }))
        } finally { setDynLoading('') }
      }
      /* 动态列表（kind: reserve=文字/卡片，schedule=带图片） */
      const areaList = (kind) => {
        const pool = (dyns || []).filter((d) => (kind === 'reserve'
          ? Boolean(d.reserve)
          : (d.images || []).length > 0))
        if (!pool.length) return [h(Note, { key: kind + '-empty' }, kind === 'reserve' ? '没有可直读的预约卡片动态' : '没有带图片的动态')]
        return pool.map((d) => h('div', { 'data-bd-plan': '', key: kind + '-' + d.id },
          h('span', {
            'data-bd-plan-time': '',
            title: d.publishedAt ? `发布时间：本地 ${fmtPlanTime(new Date(d.publishedAt).toISOString(), { tz: false })}（北京时间 ${fmtBeijingTime(new Date(d.publishedAt).toISOString())}）` : '',
          }, d.publishedAt ? fmtPlanTime(new Date(d.publishedAt).toISOString(), { tz: false }) : '时间未知'),
          h('span', { 'data-bd-plan-name': '', title: d.reserve?.title || d.text || '' },
            ((d.reserve && d.reserve.title ? `【${d.reserve.title}】` : '') + (d.text || '（无文字）')).slice(0, 56) + ((d.images || []).length ? `　[图×${d.images.length}]` : '')),
          d.reserve ? h(Tag, { tone: 'live' }, '预约卡片') : null,
          h('button', {
            'data-bd-btn': '', 'data-mini': '', disabled: dynLoading !== '',
            onClick: () => identify(kind, d.id),
          }, dynLoading === (kind === 'reserve' ? 'parse-reserve' : 'parse-schedule') ? '识别中…'
            : (kind === 'reserve' ? '直接读取卡片' : '识别日程表（图片）')),
          h('button', {
            'data-bd-btn': '', 'data-mini': '', 'data-danger': '', disabled: dynLoading !== '',
            onClick: () => removeDynamic(d.id),
          }, dynLoading === 'delete' ? '删除中…' : '删除')))
      }
      /* 识别结果 + 导入（每个区域各自一份） */
      const areaResult = (kind) => {
        const area = kind === 'reserve' ? resvArea : schedArea
        if (!area) return []
        const out = []
        if (area.msg) out.push(h('div', { 'data-bd-msg': '', 'data-tone': area.msg.tone }, area.msg.text))
        if (area.items && area.items.length) {
          out.push(h('div', { 'data-bd-list': '' }, area.items.map((r, i) => h('div', { 'data-bd-plan': '', key: kind + '-item-' + areaKey(r) + '-' + i },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', flex: '1', minWidth: 0, cursor: r.mid && r.at ? 'pointer' : 'default' } },
              h('input', {
                type: 'checkbox', disabled: !(r.mid && r.at),
                checked: Boolean(area.picked[areaKey(r)]),
                onChange: (e) => bumpArea(kind, (a) => ({ ...a, picked: { ...a.picked, [areaKey(r)]: e.target.checked } })),
              }),
              h('span', {
                'data-bd-plan-time': '',
                title: r.at ? `北京时间 ${fmtBeijingTime(r.at)}` : '',
              }, r.at ? fmtPlanTime(r.at) : '时间未知'),
              h('span', { 'data-bd-plan-name': '', title: r.title || '' }, r.name || '未知主播'),
              r.title ? h('span', { 'data-bd-plan-cd': '', title: r.title }, '· ' + r.title.slice(0, 20)) : null,
              h(Tag, { tone: r.mid && r.at ? 'live' : 'bad' }, r.mid && r.at ? '匹配到名单' : '未匹配/时间不确定'))))))
          out.push(h(Row, { key: kind + '-import' },
            h('button', {
              'data-bd-btn': '', 'data-primary': '',
              disabled: dynLoading !== '' || !Object.values(area.picked).some(Boolean),
              onClick: () => importArea(kind),
            }, dynLoading === (kind === 'reserve' ? 'import-reserve' : 'import-schedule') ? '导入中…' : '导入所选为计划'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary,#9aa0a6)', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: delAfterImport, onChange: (e) => setDelAfterImport(e.target.checked) }),
              '导入成功后删除这条转发动态')))
        }
        return out
      }
      return h(Section, { title: '值守模式' },
        h(ToggleRow, {
          label: '自动模式',
          note: '每 ' + (form.autoCheckMin || '?') + ' 分钟检查一次 5 个主播谁在播；只在下述工作时间内进入新房间。',
          on: form.autoEnabled !== false,
          onChange: (v) => saveToggle('autoEnabled', v, v ? '自动模式已开启' : '自动模式已关闭'),
          disabled: busy === 'save',
        }),
        next ? h(Note, null, '下次自动检查：' + fmtClock(next) + '（约 ' + fmtDur(Math.max(0, next - now)) + '后）') : null,
        h(FieldGrid, null,
          h(NumField, {
            label: '检查间隔', unit: '分钟', min: 1, max: 60,
            value: form.autoCheckMin,
            onChange: (v) => setForm((f) => ({ ...f, autoCheckMin: v })),
            note: '范围 1–60 分钟，默认 15 分钟',
          }),
          h(TextField, {
            label: '工作时间（' + (form.workHoursTz === 'local' ? '本机本地时间' : '北京时间') + '）', value: form.workHours, placeholder: '08:00-24:00',
            onChange: (v) => setForm((f) => ({ ...f, workHours: v })),
            note: '格式如 08:00-24:00；仅自动模式生效，手动计划不受限',
          }),
          h(SelectField, {
            label: '工作时间时区', value: form.workHoursTz,
            onChange: (v) => setForm((f) => ({ ...f, workHoursTz: v })),
            options: optionPairs([['beijing', '北京时间（UTC+8，默认）'], ['local', '本机本地时间（浏览器时区）']]),
            note: form.workHoursTz === 'local'
              ? '按浏览器所在时区解释上面的工作时间；保存时会记录具体时区（' + browserTz() + '），自动处理夏令时'
              : '按北京时间解释上面的工作时间；手动计划用绝对时间，不受影响',
          })),
        h(Sub, null, '手动计划（一次性）'),
        h(Note, null, '填主播和计划开播时间：输入框按本机时区（' + browserTz() + '）填写，计划列表/识别结果也统一按本机时区显示；B站 预约卡片里的北京时间会自动换算成本地时间。插件会提前 10 分钟进房；到点仍未开播最多再等 10 分钟；触发一次后结束。自动模式关掉也照常执行。'),
        h(Row, null,
          h('div', { 'data-bd-grow': '' },
            h('select', {
              'data-bd-input': '', value: midValue,
              onChange: (e) => setPlanMid(e.target.value),
              disabled: !streamers.length,
            }, streamers.length
              ? streamers.map((s) => h('option', { key: s.mid, value: String(s.mid) }, (s.name || s.mid) + '（' + s.mid + '）'))
              : h('option', { value: '' }, '先在上面添加主播'))),
          h('div', { 'data-bd-grow': '' },
            h('input', {
              'data-bd-input': '', type: 'datetime-local', value: planAt,
              min: toLocalInput(Date.now() + 60000),
              onChange: (e) => setPlanAt(e.target.value),
            })),
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: busy === 'plan' || !midValue,
            onClick: async () => { const ok = await onAddPlan(midValue, planAt); if (ok) setPlanAt('') },
          }, busy === 'plan' ? '添加中…' : '添加计划')),
        plans.length
          ? h('div', { 'data-bd-list': '' }, plans.map((p) => h('div', { 'data-bd-plan': '', key: p.id || String(p.at) },
            h('span', {
              'data-bd-plan-time': '',
              title: `北京时间 ${fmtBeijingTime(p.at)}`,
            }, fmtPlanTime(p.at)),
            h('span', { 'data-bd-plan-name': '', title: p.name || p.mid }, p.name || String(p.mid)),
            h(Tag, { tone: PLAN_TONE[p.status] || 'idle' }, PLAN_LABEL[p.status] || p.status || '未知'),
            h('span', { 'data-bd-plan-cd': '' }, planCountdown(p, now)),
            h('button', {
              'data-bd-btn': '', 'data-mini': '', 'data-danger': '', disabled: busy === 'plan',
              onClick: () => onRemovePlan(p.id),
            }, '删除'),
            p.title ? h('span', { 'data-bd-plan-title': '', title: p.title }, p.title) : null)))
          : h(Note, null, '还没有手动计划。临时想守某个主播的某场直播，就在这里加一条。'),
        h(Sub, null, '从个人动态识别导入'),
        h(Row, null,
          h('button', {
            'data-bd-btn': '', disabled: dynLoading !== '',
            onClick: loadDynamics,
          }, dynLoading === 'list' ? '读取中…' : '读取我的动态'),
          h(Note, null, '先读取空间里的动态；下面按「预约（文字/卡片）」和「日程表（图片）」分成两个区域，各自识别、各自导入。')),
        dynMsg ? h('div', { 'data-bd-msg': '', 'data-tone': dynMsg.tone }, dynMsg.text) : null,
        h(Sub, null, '① 预约识别（卡片）'),
        h(Note, null, '只识别动态里的直播预约卡片：结构化 JSON 直接解析，不用模型、毫秒级。支持旧版 live_rcmd 卡和新版「直播预约」卡（additional.reserve，时间在文案里）；卡片文案里的「明天 03:00」已按浏览器本地时区渲染，解析时按同一时区换算，导入的计划直接就是本地时间。没有预约卡片的文字动态不会出现在这里。'),
        dyns ? h('div', { 'data-bd-list': '' }, areaList('reserve')) : null,
        ...areaResult('reserve'),
        h(Sub, null, '② 日程表识别（图片）'),
        h(Note, null, '识别带图片的官方日程表（多模态模型，单次约 100 秒），按图里的日期时间一次生成多条计划。'),
        dyns ? h('div', { 'data-bd-list': '' }, areaList('schedule')) : null,
        ...areaResult('schedule'),
        h(Note, null, '说明：手动计划与自动模式互不冲突，可以同时存在；同一时刻多条计划到期时，按计划时间早的优先。'))
    }

    /* ────────────────────────── ⑤ 任务设置 ────────────────────────── */
    function TasksCard({ st, form, setForm, saveToggle, busy }) {
      const saving = busy === 'save'
      return h(Section, { title: '任务设置' },
        h(Note, null, '开关点击即保存；数字、文本和下拉改动留在本地，滚到页面底部点「保存全部设置」才生效。所有数字在保存时会按提示范围自动修正。'),
        h(ToggleRow, {
          label: '观看直播', note: '进房后用网页端 live-trace 心跳上报观看时长（连续 15 分钟算 1 轮，每天最多 10 轮）；不再拉流，省流量。任务房不上报。',
          on: form.taskWatch !== false, onChange: (v) => saveToggle('taskWatch', v, v ? '已开启观看任务' : '已关闭观看任务'), disabled: saving,
        }),
        h(ToggleRow, {
          label: '发送弹幕', note: '每天每个房间至少成功发 1 条；下面两条通道共用每日总上限与全局限速。',
          on: form.taskDanmaku !== false, onChange: (v) => saveToggle('taskDanmaku', v, v ? '已开启弹幕任务' : '已关闭弹幕任务'), disabled: saving,
        }),
        h(ToggleRow, {
          label: '点赞直播间', note: `每次进房至少完成一轮；全天所有房间合计上限 ${st.like?.max ?? 600} 次（今日已 ${st.like?.today ?? 0} 次），达到后当天不再点赞；失败即停，不硬重试。`,
          on: form.taskLike !== false, onChange: (v) => saveToggle('taskLike', v, v ? '已开启点赞任务' : '已关闭点赞任务'), disabled: saving,
        }),
        h(ToggleRow, {
          label: '打赏粉丝团灯牌', note: '默认关闭。每房每天最多 1 次「粉丝团灯牌」，价格硬上限 1 电池；余额不足自动跳过，绝不自动充值。',
          on: form.taskGift === true, onChange: (v) => saveToggle('taskGift', v, v ? '已开启打赏任务（请确认已了解风险）' : '已关闭打赏任务'), disabled: saving,
        }),
        h(Sub, null, '弹幕'),
        h(ToggleRow, {
          label: '进房问候模板', note: '每房每天只在当天首次进房时发一次，从下面模板库随机不重复取若干条。',
          on: form.templateDanmaku !== false, onChange: (v) => saveToggle('templateDanmaku', v, v ? '已开启进房问候' : '已关闭进房问候'), disabled: saving,
        }),
        h(FieldGrid, null,
          h(NumField, {
            label: '问候条数', unit: '条', min: 1, max: 20, value: form.greetingCount,
            onChange: (v) => setForm((f) => ({ ...f, greetingCount: v })), note: '范围 1–20 条，默认 10 条',
          }),
          h(NumField, {
            label: '条间隔', unit: '秒', min: 10, max: 120, value: form.greetingSpacingSec,
            onChange: (v) => setForm((f) => ({ ...f, greetingSpacingSec: v })), note: '范围 10–120 秒，默认 30 秒',
          })),
        h(TextAreaField, {
          label: '问候语模板库', rows: 6, value: form.greetingText,
          onChange: (v) => setForm((f) => ({ ...f, greetingText: v })),
          note: '每行一条，最多 20 行，每条不超过 20 字；重复行会被自动去掉。条数不够时循环使用。',
        }),
        h(ToggleRow, {
          label: '智能弹幕（跟风复读 / 自由生成）', note: '跟风复读（默认）纯本地统计，不调用模型：从窗口内达到重复次数的句子里随机挑一句原样复制；自由生成才调用模型。',
          on: form.aiDanmaku !== false, onChange: (v) => saveToggle('aiDanmaku', v, v ? '已开启智能弹幕' : '已关闭智能弹幕'), disabled: saving,
        }),
        h(SelectField, {
          label: '弹幕模式', value: form.aiMode,
          onChange: (v) => setForm((f) => ({ ...f, aiMode: v })),
          options: optionPairs([['follow', '跟风复读（默认，本地统计，不调用模型）'], ['generate', '自由生成（调用模型，按直播内容写一句）']]),
          note: '跟风复读：窗口内所有 ≥ 最少重复次数的句子进入候选池，每轮随机挑一句原样发送（不固定复读最高频那句）。全部本地完成，不消耗 token、不依赖模型。',
        }),
        form.aiMode === 'follow'
          ? h(FieldGrid, null,
              h(NumField, {
                label: '跟风窗口', unit: '秒', min: 20, max: 300, value: form.aiFollowWindowSec,
                onChange: (v) => setForm((f) => ({ ...f, aiFollowWindowSec: v })), note: '范围 20–300 秒，默认 60 秒；只看这个时间窗口内的弹幕',
              }),
              h(NumField, {
                label: '最少重复次数', unit: '次', min: 2, max: 20, value: form.aiFollowMinCount,
                onChange: (v) => setForm((f) => ({ ...f, aiFollowMinCount: v })), note: '范围 2–20 次，默认 3 次；窗口内重复达到这个次数才跟',
              }))
          : null,
        h(FieldGrid, null,
          h(NumField, {
            label: '智能弹幕间隔', unit: '秒', min: 30, max: 600, value: form.aiIntervalSec,
            onChange: (v) => setForm((f) => ({ ...f, aiIntervalSec: v })), note: '范围 30–600 秒，默认 300 秒（越短越容易被风控）',
          }),
          h(NumField, {
            label: '每房每日智能弹幕上限', unit: '条', min: 10, max: 300, value: form.aiDailyMax,
            onChange: (v) => setForm((f) => ({ ...f, aiDailyMax: v })), note: '范围 10–300 条，默认 100 条；跟风模式不消耗 token',
          })),
        h(Sub, null, '弹幕上限与限速（风控兜底）'),
        h(FieldGrid, null,
          h(NumField, {
            label: '每房每日总上限', unit: '条', min: 20, max: 600, value: form.danmakuDailyMax,
            onChange: (v) => setForm((f) => ({ ...f, danmakuDailyMax: v })), note: '范围 20–600 条，默认 150 条（问候 + AI 合计）',
          }),
          h(NumField, {
            label: '全局最小间隔', unit: '秒', min: 1, max: 60, value: form.danmakuCooldownSec,
            onChange: (v) => setForm((f) => ({ ...f, danmakuCooldownSec: v })), note: '任意两条弹幕之间的硬下限，范围 1–60 秒，默认 3 秒',
          }),
          h(NumField, {
            label: '弹幕最大长度', unit: '字', min: 5, max: 40, value: form.maxLen,
            onChange: (v) => setForm((f) => ({ ...f, maxLen: v })), note: '范围 5–40 字，默认 20 字',
          })),
        h(Sub, null, '点赞'),
        h(FieldGrid, null,
          h(NumField, {
            label: '每轮点击数', unit: '次', min: 1, max: 3000, value: form.likeClicks,
            onChange: (v) => setForm((f) => ({ ...f, likeClicks: v })), note: '范围 1–3000 次，默认 300 次',
          }),
          h(NumField, {
            label: '轮间隔', unit: '分钟', min: 1, max: 60, value: form.likeRoundMin,
            onChange: (v) => setForm((f) => ({ ...f, likeRoundMin: v })), note: '范围 1–60 分钟，默认 10 分钟',
          }),
          h(NumField, {
            label: '每日总上限（全局）', unit: '次', min: 1, max: 10000, value: form.likeDailyMax,
            onChange: (v) => setForm((f) => ({ ...f, likeDailyMax: v })), note: '所有房间当天合计，默认 600 次；达到后当天不再点赞',
          })),
        h(Sub, null, '打赏'),
        h(Row, null,
          h('div', { 'data-bd-grow': '' }, h(Note, null, balanceText(st))),
          h('div', { style: { width: '170px' } },
            h(NumField, {
              label: '每日上限（全局）', unit: '次', min: 1, max: 10, value: form.giftDailyMax,
              onChange: (v) => setForm((f) => ({ ...f, giftDailyMax: v })), note: '范围 1–10 次，默认 5 次',
            }))),
        h(Note, null, '打赏说明：只送「粉丝团灯牌」且单价不超过 1 电池；每房每天最多 1 次；余额不足直接跳过；失败不重试、不自动充值。'),
        h(Note, null, '合规提示：自动化发弹幕、点赞、打赏属于对平台的非官方自动化操作，可能触发风控、限流或封号；请只在你自己账号上按需使用，风险自担。'))
    }

    /* ────────────────────────── ⑥ 调试 ────────────────────────── */
    function DebugCard({ st, form, busy, onTick, onStop, onRunTask, onTestLlm, onRuntimeSweep, llmResult }) {
      const [mid, setMid] = React.useState('')
      const [task, setTask] = React.useState('all')
      const streamers = (st.streamers && st.streamers.length ? st.streamers : form.streamers) || []
      const midValue = streamers.some((s) => String(s.mid) === String(mid))
        ? mid
        : (streamers[0] ? String(streamers[0].mid) : '')
      const llm = st.llm || {}
      return h(Section, { title: '调试' },
        h(Row, null,
          h('button', { 'data-bd-btn': '', disabled: busy === 'tick', onClick: onTick }, busy === 'tick' ? '检查中…' : '立即检查'),
          h('button', { 'data-bd-btn': '', 'data-danger': '', disabled: busy === 'stop' || (!st.main && !st.visiting), onClick: onStop }, busy === 'stop' ? '停止中…' : '停止当前场'),
          h('button', { 'data-bd-btn': '', disabled: busy === 'llm', onClick: onTestLlm }, busy === 'llm' ? '测试中…' : '模型自测')),
        llmResult ? h('div', { 'data-bd-msg': '', 'data-tone': llmResult.tone }, llmResult.text) : null,
        h(Sub, null, '手动跑一次任务'),
        h(Row, null,
          h('div', { 'data-bd-grow': '' },
            h('select', {
              'data-bd-input': '', value: midValue,
              onChange: (e) => setMid(e.target.value),
              disabled: !streamers.length,
            }, streamers.length
              ? streamers.map((s) => h('option', { key: s.mid, value: String(s.mid) }, (s.name || s.mid) + '（' + s.mid + '）'))
              : h('option', { value: '' }, '还没有主播'))),
          h('div', { 'data-bd-grow': '' },
            h('select', {
              'data-bd-input': '', value: task,
              onChange: (e) => setTask(e.target.value),
            }, TASK_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: busy === 'task' || !midValue,
            onClick: () => onRunTask(midValue, task),
          }, busy === 'task' ? '执行中…' : '运行')),
        h(Note, null, '手动任务会立刻在你选的直播间执行一次（观看 = 上报 15 分钟观看心跳，可能触发平台风控，请谨慎使用）。'),
        h(Sub, null, '运行时文件清理'),
        h(Note, null, st.runtime
          ? `上次清理：${fmtClock(st.runtime.at)} · 跟踪插件图片 ${st.runtime.tracked} 个 · 删除 ${st.runtime.deleted} 个（${fmtBytes(st.runtime.bytesFreed)}）· 保留被会话引用 ${st.runtime.referenced} 个 · 清理临时文件 ${st.runtime.tmpRemoved} 个 · 图片附件保留 ${st.runtime.keepDays} 天`
          : '插件启动后与每 6 小时自动清理一次；插件识图写入的图片附件保留 7 天，被会话引用的永不删除。'),
        h(Row, null,
          h('button', { 'data-bd-btn': '', disabled: busy === 'runtime', onClick: onRuntimeSweep }, busy === 'runtime' ? '清理中…' : '立即清理')),
        h(Sub, null, '运行日志'),
        h('pre', { 'data-bd-log': '' }, (st.logs || []).join('\n') || '（还没有日志）'),
        h(Note, null, '家目录：' + (st.home || '—')),
        h(Note, null, '模型：' + (llm.available
          ? `${llm.provider || '?'} / ${llm.model || '?'} / 推理 ${llm.reasoningEffort || '默认'}`
          : '宿主没有提供 llm 服务：跟风复读不受影响；仅自由生成会静默跳过（问候模板仍会完成每日弹幕任务）')))
    }

    /* ────────────────────────── 整页 ────────────────────────── */
    function Panel() {
      const [st, setSt] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [now, setNow] = React.useState(Date.now())
      const [llmResult, setLlmResult] = React.useState(null)
      /* 服务端快照：每 5 秒刷新。form 只在第一次拿到时初始化，
         之后不再被 /status 覆盖 —— 否则会冲掉用户正在填的内容。 */
      const refresh = React.useCallback(async () => {
        try {
          const d = await jget('/status')
          if (!d || d.ok === false) throw new Error((d && d.error) || '状态异常')
          setSt(d)
          setForm((old) => old || configToForm(d.config))
        } catch (e) {
          setMsg((m) => (m && m.tone === 'warn' ? m : { tone: 'warn', text: '读不到插件状态：' + errText(e) }))
        }
      }, [])
      React.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 5000)
        return () => clearInterval(t)
      }, [refresh])
      React.useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [])
      if (!st || !form) return h('div', { 'data-bd-page': '' }, h('div', { 'data-bd-msg': '', 'data-tone': 'warn' }, '正在读取「直播值守」状态…' + (msg ? '（' + msg.text + '）' : '')))

      /* 即时保存（开关类）：只把本次 patch 里的字段合并回草稿，其它输入不动（旧版 bug 修复点） */
      const save = async (patch, okText) => {
        setBusy('save')
        try {
          const r = await jpost('/config', patch)
          if (!r.ok) throw new Error(r.error || '保存失败')
          setSt((s) => (s ? { ...s, config: r.config } : s))
          setForm((old) => {
            if (!old) return old
            const next = { ...old }
            for (const k of Object.keys(patch)) {
              const v = r.config ? r.config[k] : undefined
              if (v !== undefined) next[k] = v
            }
            return next
          })
          setMsg({ tone: 'good', text: okText || '已保存' })
          refresh()
          return true
        } catch (e) {
          setMsg({ tone: 'warn', text: '保存失败：' + errText(e) })
          return false
        } finally { setBusy('') }
      }
      const saveToggle = async (key, value, okText) => {
        const prev = form[key]
        setForm((f) => (f ? { ...f, [key]: value } : f))
        const ok = await save({ [key]: value }, okText)
        if (!ok) setForm((f) => (f ? { ...f, [key]: prev } : f))
      }
      /* 主播名单的增删改排序：整体提交 streamers 数组（契约允许直接走 /config） */
      const saveStreamers = async (next, okText) => {
        const payload = next.map((s, i) => ({
          mid: String(s.mid || '').trim(),
          roomId: String(s.roomId || '').trim(),
          name: String(s.name || '').trim().slice(0, 30),
          enabled: s.enabled !== false,
          order: i,
        })).filter((s) => s.mid || s.roomId)
        const before = form.streamers || []
        setBusy('save')
        setForm((f) => (f ? { ...f, streamers: next } : f))
        try {
          const r = await jpost('/config', { streamers: payload })
          if (!r.ok) throw new Error(r.error || '保存失败')
          const saved = Array.isArray(r.config && r.config.streamers) ? sortRows(r.config.streamers) : null
          setForm((f) => (f ? { ...f, streamers: saved && (saved.length || !payload.length) ? saved : next } : f))
          setSt((s) => (s ? { ...s, config: r.config } : s))
          setMsg({ tone: 'good', text: okText || '已保存' })
          refresh()
        } catch (e) {
          setForm((f) => (f ? { ...f, streamers: before } : f))
          setMsg({ tone: 'warn', text: '保存失败：' + errText(e) })
        } finally { setBusy('') }
      }
      const actions = {
        add: (payload) => {
          const list = form.streamers || []
          if (list.length >= 5) { setMsg({ tone: 'warn', text: '最多 5 个主播' }); return }
          if (list.some((s) => String(s.mid) === String(payload.mid))) { setMsg({ tone: 'warn', text: '这个主播已经在列表里了' }); return }
          const name = String(payload.name || '').trim().slice(0, 30) || ('主播' + payload.mid)
          saveStreamers([...list, {
            mid: String(payload.mid), roomId: String(payload.roomId || ''),
            name, enabled: true, order: list.length,
          }], '已添加主播')
        },
        remove: (i) => saveStreamers((form.streamers || []).filter((_, j) => j !== i), '已删除主播'),
        move: (i, dir) => {
          const list = (form.streamers || []).slice()
          const j = i + dir
          if (j < 0 || j >= list.length) return
          const t = list[i]
          list[i] = list[j]
          list[j] = t
          saveStreamers(list, '已调整优先级')
        },
        toggle: (i, on) => saveStreamers((form.streamers || []).map((s, j) => (j === i ? { ...s, enabled: on } : s)), on ? '已启用该主播' : '已停用该主播'),
        update: (i, patch) => {
          const uid = String(patch.mid || '').trim()
          if (uid && !/^\d{4,20}$/.test(uid)) { setMsg({ tone: 'warn', text: '主播 UID 应该是 4–20 位纯数字' }); return false }
          const name = String(patch.name || '').trim().slice(0, 30)
          if (!name) { setMsg({ tone: 'warn', text: '名字不能为空（方便你自己认人）' }); return false }
          saveStreamers((form.streamers || []).map((s, j) => {
            if (j !== i) return s
            const midChanged = uid && uid !== String(s.mid)
            return { ...s, mid: uid || s.mid, name, roomId: midChanged ? '' : s.roomId }
          }), '已更新主播信息')
          return true
        },
      }
      /* 手动操作（即时调后端） */
      const onTick = async () => {
        setBusy('tick')
        try {
          const r = await jpost('/tick')
          if (!r.ok) throw new Error(r.error || '检查失败')
          const cur = r.main || null
          let text
          if (cur) {
            text = `已进入「${cur.name || '直播间'}」`
            if (r.outside) text += '（手动检查，不受值守时段限制）'
          } else if (r.manual === 'no-live') {
            text = '检查完成：当前没有主播在播'
          } else if (r.manual === 'room-not-ready') {
            text = '检查完成：找到在播主播但房间信息未就绪，请再点一次'
          } else {
            text = '检查完成：没有可进入的直播间'
          }
          if (!cur && r.hint) text += `；${r.hint}`
          setMsg({ tone: cur ? 'good' : 'info', text })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '检查失败：' + errText(e) }) } finally { setBusy('') }
      }
      const onStop = async () => {
        if (!window.confirm('停止当前场次并离开直播间？')) return
        setBusy('stop')
        try {
          const r = await jpost('/stop')
          if (!r.ok) throw new Error(r.error || '停止失败')
          setMsg({ tone: 'good', text: '已停止当前场次' })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '停止失败：' + errText(e) }) } finally { setBusy('') }
      }
      const onRunTask = async (mid, task) => {
        setBusy('task')
        try {
          const r = await jpost('/task-run', { mid, task })
          if (!r.ok) throw new Error(r.error || '执行失败')
          setMsg({ tone: 'good', text: '已执行一次：' + (TASK_LABEL[task] || task) + '（刷新后看状态与日志）' })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '执行失败：' + errText(e) }) } finally { setBusy('') }
      }
      const onTestLlm = async () => {
        setBusy('llm')
        try {
          const r = await jpost('/llm-test')
          if (r.ok) setLlmResult({ tone: 'good', text: `模型可用：${r.provider || '?'} / ${r.model || '?'} —— ${r.text || '（空回复）'}` })
          else setLlmResult({ tone: 'warn', text: '模型不可用：' + (r.error || '空回复') })
        } catch (e) { setLlmResult({ tone: 'warn', text: '测试失败：' + errText(e) }) } finally { setBusy('') }
      }
      const onRuntimeSweep = async () => {
        setBusy('runtime')
        try {
          const r = await jpost('/runtime', { action: 'sweep' })
          if (!r.ok) throw new Error(r.error || '清理失败')
          const x = r.result || {}
          setMsg({
            tone: 'good',
            text: `运行时清理完成：删除图片附件 ${x.deleted || 0} 个（${fmtBytes(x.bytesFreed || 0)}），保留被会话引用 ${x.referenced || 0} 个，清理临时文件 ${x.tmpRemoved || 0} 个（跟踪 ${r.tracked || 0} 个）`,
          })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '清理失败：' + errText(e) }) } finally { setBusy('') }
      }
      const onAddPlan = async (mid, atLocal) => {
        if (!mid) { setMsg({ tone: 'warn', text: '先选择要计划的主播' }); return false }
        if (!atLocal) { setMsg({ tone: 'warn', text: '先选择计划开播时间' }); return false }
        const ts = Date.parse(atLocal)
        if (!Number.isFinite(ts)) { setMsg({ tone: 'warn', text: '时间格式不对，请重新选择' }); return false }
        const s = (form.streamers || []).find((x) => String(x.mid) === String(mid))
        setBusy('plan')
        try {
          const r = await jpost('/plans', {
            action: 'add',
            plan: { mid: String(mid), name: (s && s.name) || '', at: new Date(ts).toISOString() },
          })
          if (!r.ok) throw new Error(r.error || '添加失败')
          const iso = new Date(ts).toISOString()
          setMsg({ tone: 'good', text: '已添加计划：' + fmtPlanTime(iso) + '（北京时间 ' + fmtBeijingTime(iso) + '；提前 10 分钟进房）' })
          refresh()
          return true
        } catch (e) { setMsg({ tone: 'warn', text: '添加计划失败：' + errText(e) }); return false } finally { setBusy('') }
      }
      const onRemovePlan = async (id) => {
        if (!window.confirm('删除这条手动计划？')) return
        setBusy('plan')
        try {
          const r = await jpost('/plans', { action: 'remove', id })
          if (!r.ok) throw new Error(r.error || '删除失败')
          setMsg({ tone: 'good', text: '计划已删除' })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '删除失败：' + errText(e) }) } finally { setBusy('') }
      }
      /* 底部保存栏：把本地草稿一次性提交（输入类字段） */
      const saveAll = async () => {
        const wh = String(form.workHours || '').trim()
        if (!WH_RE.test(wh)) { setMsg({ tone: 'warn', text: '工作时间格式要像 08:00-24:00（24 小时制）' }); return }
        setBusy('save')
        try {
          const r = await jpost('/config', formToPatch(form))
          if (!r.ok) throw new Error(r.error || '保存失败')
          if (!r.config) throw new Error('服务端没有返回配置')
          setForm(configToForm(r.config))
          setSt((s) => (s ? { ...s, config: r.config } : s))
          setMsg({ tone: 'good', text: '全部设置已保存' })
          refresh()
        } catch (e) {
          setMsg({ tone: 'warn', text: '保存失败：' + errText(e) })
        } finally { setBusy('') }
      }

      return h('div', { 'data-bd-page': '' },
        h(StatusHero, { st, cfg: form, busy, now, onTick, onStop }),
        msg ? h('div', { 'data-bd-msg': '', 'data-tone': msg.tone }, msg.text) : null,
        h(Note, null, '说明：开关类改动会立即保存；数字、文本、下拉和主播名单编辑要滚到页面最底部点「保存全部设置」。'),
        h(AccountCard, { st, refresh, setMsg }),
        h(StreamersCard, { st, form, busy, actions, setMsg }),
        h(ModeCard, { st, form, setForm, saveToggle, onAddPlan, onRemovePlan, onRefresh: refresh, busy, now }),
        h(TasksCard, { st, form, setForm, saveToggle, busy }),
        h(DebugCard, { st, form, busy, onTick, onStop, onRunTask, onTestLlm, onRuntimeSweep, llmResult }),
        h('div', { 'data-bd-sec': '', 'data-bd-savebar': '' },
          h('div', { 'data-bd-h': '' }, '保存'),
          h('div', { 'data-bd-note': '' }, '输入框、下拉、问候语和主播名单的改动都先留在本地；点下面的按钮才真正生效。开关类在点击时已即时保存。'),
          h(Row, null,
            h('button', {
              'data-bd-btn': '', 'data-primary': '', 'data-bd-big': '',
              disabled: busy === 'save', onClick: saveAll,
            }, busy === 'save' ? '保存中…' : '保存全部设置'),
            h('div', { 'data-bd-grow': '' },
              h('div', { 'data-bd-note': '', style: { textAlign: 'right', color: msg && msg.tone === 'warn' ? '#f59e0b' : undefined } },
                msg ? msg.text : `主播 ${(form.streamers || []).length}/5 · 手动计划 ${(st.plans || []).length} 条`)))),
        h(Note, null, '所有任务数据每天 0 点（北京时间）重新开始；点「保存全部设置」后页面会以服务端返回的配置为准。'))
    }

    /* 面板万一渲染崩了，别整节白屏 —— 把错误摆出来当线索 */
    /** B站小电视风格图标（天线 + 两只眼睛 + 微笑），随主题/选中色变化 */
    function BiliTvIcon({ size = 18, active = false } = {}) {
      const c = active ? '#fb7299' : 'currentColor'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        h('rect', { x: 2.4, y: 6.8, width: 19.2, height: 14, rx: 3.2, stroke: c, strokeWidth: 1.8 }),
        h('path', { d: 'M7.7 6.6 5.6 3.2M16.3 6.6l2.1-3.4', stroke: c, strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('circle', { cx: 9.1, cy: 12.9, r: 1.15, fill: c }),
        h('circle', { cx: 14.9, cy: 12.9, r: 1.15, fill: c }),
        h('path', { d: 'M8.9 16.7c1.7 1.3 4.5 1.3 6.2 0', stroke: c, strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    /** 主界面（左侧导航「直播值守」）里的页面容器 */
    function BiliDutyPage() {
      return h('div', { 'data-bd-main': '' }, h(Boundary, null, h(Panel)))
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err) { try { console.error('[dsh-bili-duty] 面板渲染出错', err) } catch { /* 忽略 */ } }
      render() {
        const e = this.state.err
        if (!e) return this.props.children
        const text = String((e && (e.stack || e.message)) || e)
        return h('div', { 'data-bd-page': '' },
          h('div', { 'data-bd-msg': '', 'data-tone': 'warn' }, '「直播值守」面板渲染时出错了 —— 把下面这段发给我就能定位：'),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.5, opacity: 0.85 } }, text))
      }
    }

    return {
      // 必须声明 slots 依赖：inject 为空数组时 fiber 等不到 slots 服务，
      // 必须声明 slots 依赖；apply 里注册主界面页面和侧边栏图标。
      inject: ['slots'],
      apply(ctx) {
        try {
          if (!document.querySelector('style[data-plugin-css="dsh-bili-duty"]')) {
            const style = document.createElement('style')
            style.setAttribute('data-plugin-css', 'dsh-bili-duty')
            style.textContent = CSS
            document.head.appendChild(style)
          }
        } catch (e) {
          try { console.warn('[dsh-bili-duty] 样式注入失败', (e && e.message) || e) } catch { /* 忽略 */ }
        }

        // 不用 ctx.effect（第三方 ctx 上不一定有，抛错会中断整个 apply）
        let slots = null
        try {
          slots = (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || (ctx && ctx.slots)
        } catch { /* 拿不到就按不可用处理 */ }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        // 主界面页面：keyed 槽，key = 左侧导航项 id
        try {
          slots.inject('main', () => slots.register(
            { name: 'main', key: 'bili-duty' },
            BiliDutyPage,
          ))
        } catch (e) {
          try { console.warn('[dsh-bili-duty] 主界面注册失败', (e && e.message) || e) } catch { /* 忽略 */ }
        }
        // 左侧导航栏图标 + 标题（点图标切到主界面页面）
        try {
          slots.inject('sidebar.panellist', () => slots.register(
            { name: 'sidebar.panellist', id: 'bili-duty', order: 20, label: '直播值守' },
            BiliTvIcon,
          ))
        } catch (e) {
          try { console.warn('[dsh-bili-duty] 侧边栏图标注册失败', (e && e.message) || e) } catch { /* 忽略 */ }
        }
      },
    }
  },
})
