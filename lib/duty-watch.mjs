/**
 * lib/duty-watch.mjs —— 「观看直播」任务的拉流层（只读取、丢弃、不落盘、不解码）
 * ============================================================================
 * 目标：让平台把「观看直播」任务的分钟数计入。
 *
 * 做法（P0 实测过的最小可行链路）：
 *   ① 本模块内置 getPlayUrl(真实房间号) 拿 flv 直链（普通 GET，不需要 WBI）
 *   ② fetch 直链，**for await 一包一包读、读完即丢**：
 *      - 不落盘（旧插件的 AudioTap 会切 flv 切片，这里完全不要）
 *      - 不解码（旧插件的 FlvSplitter/PyAV 全部不用）
 *      - 只统计 bytes / seconds，用于记录观看时长
 *   ③ 每 30s 回调一次进度；被上层 abort / 到达 maxMs 时干净收尾。
 *
 * P0 实测：测试房间只提供 qn=250（请求 qn=150 会回落），约 **300KB/s ≈ 18MB/分钟**；
 * 因此「拉 10 分钟 ≈ 180MB」——流量是真实消耗，任务房不拉流（只主看房拉），见设计 §5.3。
 *
 * 语义约定（与 lib/duty-actions.mjs 一致：永不抛异常）：
 *   - 到达 maxMs 视为**正常结束** → { ok:true, seconds, bytes, qn, codec }
 *   - 外部 signal abort（例如切台/停止当前场）→ { ok:false, aborted:true, seconds, bytes }
 *   - 取流失败 / HTTP 错误 / 直播流断开 → { ok:false, message, seconds, bytes }
 * ============================================================================
 */
import { headersOf } from './live.mjs'

const LIVE_REF = 'https://live.bilibili.com/'
const DEFAULT_MAX_MS = 3600000 // 1 小时（兜底，正常由调用方按任务时长传更小的值）
const PROGRESS_MS = 30000 // 每 30s 回报一次进度

/** 安全调用外部回调：回调抛异常绝不能把拉流循环带崩 */
function callSafe(fn, arg, onLog) {
  if (typeof fn !== 'function') return
  try {
    fn(arg)
  } catch (e) {
    log(onLog, `回调异常：${e?.message || e}`)
  }
}

function log(onLog, msg) {
  if (typeof onLog !== 'function') return
  try {
    onLog(String(msg))
  } catch {
    /* 日志回调异常直接忽略 */
  }
}


/**
 * 房间号 → flv 直链（普通 GET，不需要 WBI 签名）
 * 从旧插件 lib/audio.mjs 迁入并保留原有行为（P0 实测可用）。
 * 注意：房间可能把请求的 qn 回落到它自己的档位（测试房间 qn=150 → 实际 250）。
 */
export async function getPlayUrl(realRoomId, cred, { qn = '80' } = {}) {
  const q = new URLSearchParams({
    room_id: String(realRoomId),
    protocol: '0',
    format: '0',
    codec: '0',
    qn: String(qn),
    platform: 'web',
    ptype: '8',
    dolby: '5',
  })
  let j
  try {
    const r = await fetch('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?' + q.toString(), {
      headers: headersOf(cred, `https://live.bilibili.com/${realRoomId}`),
    })
    j = await r.json()
  } catch (e) {
    throw new Error(`取直播流地址失败：${e?.message || e}`)
  }
  if (j?.code !== 0) throw new Error(`取直播流地址失败：code=${j?.code} ${j?.message || ''}`.trim())
  const info = j?.data?.playurl_info?.playurl
  const streams = info?.stream || []
  for (const s of streams) {
    if (s.protocol_name !== 'http_stream') continue
    for (const f of s.format || []) {
      for (const c of f.codec || []) {
        const ui = (c.url_info || [])[0]
        if (!ui) continue
        return {
          url: ui.host + c.base_url + (ui.extra || ''),
          codec: c.codec_name,
          qn: Number(c.current_qn) || Number(qn),
          acceptQn: c.accept_qn || '',
        }
      }
    }
  }
  throw new Error('这个房间没有可用的 flv 流（可能未开播，或只提供 HLS）')
}

/** 把 promise 和 abort signal 赛跑：abort 先到就立刻 reject AbortError（用于 getPlayUrl 阶段） */
function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    const e = new Error('已取消')
    e.name = 'AbortError'
    return Promise.reject(e)
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const e = new Error('已取消')
      e.name = 'AbortError'
      reject(e)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/**
 * 拉一路直播流并只读丢弃，统计观看时长/流量。
 *
 * @param {{sessdata:string,bili_jct?:string,buvid3?:string,dedeuserid?:string}} cred
 * @param {number|string} realRoomId 真实房间号（不是短号）
 * @param {object} [opts]
 * @param {number} [opts.qn=150] 期望清晰度（P0 实测会被房间回落，例如 150→250）
 * @param {number} [opts.maxMs=3600000] 本次拉流上限（到点正常结束）
 * @param {AbortSignal} [opts.signal] 外部取消信号（切台/停止/插件卸载时用）
 * @param {(p:{seconds:number,bytes:number})=>void} [opts.onProgress] 每 30s 一次
 * @param {(msg:string)=>void} [opts.onLog] 过程日志（中文短句）
 * @returns {Promise<{ok:boolean, seconds:number, bytes:number, qn?:number, codec?:string,
 *   aborted?:boolean, message?:string}>}
 */
export async function pullStream(cred, realRoomId, { qn = 150, maxMs = DEFAULT_MAX_MS, signal, onProgress, onLog } = {}) {
  const t0 = Date.now()
  const stats = { seconds: 0, bytes: 0 }
  const wantQn = Number(qn) || 150
  const limitMs = Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Math.trunc(Number(maxMs)) : DEFAULT_MAX_MS
  const roomId = String(realRoomId ?? '').replace(/\D/g, '')
  let qnActual = wantQn
  let codec = ''

  if (!roomId) return { ok: false, seconds: 0, bytes: 0, message: '缺少房间号（realRoomId）' }
  if (!cred?.sessdata) {
    // 拉流匿名也能拿直链，但要计入收藏/观看通常需要登录 Cookie；这里按调用约定要求登录
    return { ok: false, seconds: 0, bytes: 0, message: '没有登录凭证，请先在设置页扫码登录' }
  }
  if (signal?.aborted) return { ok: false, aborted: true, seconds: 0, bytes: 0 }

  const ctl = new AbortController()
  let abortReason = '' // 'maxMs' | 'external'
  let streaming = false // 是否已经拿到流（区分「拉流中到点」与「取流阶段被取消」）

  const onExternalAbort = () => {
    abortReason = 'external'
    ctl.abort()
  }
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true })

  const timer = setTimeout(() => {
    abortReason = 'maxMs'
    ctl.abort()
  }, limitMs)

  let progressTimer = null // 拿到流之后才开始 30s 进度回报（取流阶段不计入观看）

  const startProgress = () => {
    progressTimer = setInterval(() => {
      stats.seconds = Math.round((Date.now() - t0) / 1000)
      callSafe(onProgress, { seconds: stats.seconds, bytes: stats.bytes }, onLog)
    }, PROGRESS_MS)
  }

  try {
    /* ① 取 flv 直链（这一步也要受 maxMs/abort 约束，避免卡在半路） */
    let play
    try {
      const p = getPlayUrl(roomId, cred, { qn: wantQn })
      // audio.getPlayUrl 内部不带 signal → 用 abortable 让外层可以不等它
      p.catch(() => {}) // 双保险：被 abortable 丢弃后它自己的失败不要变成 unhandledRejection
      play = await abortable(p, ctl.signal)
    } catch (e) {
      if (e?.name === 'AbortError' || ctl.signal.aborted) {
        if (abortReason === 'maxMs') {
          return { ok: false, seconds: 0, bytes: 0, message: '拉流超时：未能在时限内拿到直播流' }
        }
        return { ok: false, aborted: true, seconds: 0, bytes: 0 }
      }
      return { ok: false, seconds: 0, bytes: 0, message: `取直播流失败：${e?.message || e}` }
    }
    qnActual = Number(play?.qn) || wantQn
    codec = String(play?.codec || '')
    log(onLog, `开始拉流 房间${roomId} qn=${qnActual}${qnActual !== wantQn ? `（请求 qn=${wantQn} 被回落）` : ''} codec=${codec || '?'}`)

    /* ② 读流并丢弃 */
    let r
    try {
      r = await fetch(play.url, {
        headers: { ...headersOf(cred, `${LIVE_REF}${roomId}`) },
        signal: ctl.signal,
      })
    } catch (e) {
      if (e?.name === 'AbortError' || ctl.signal.aborted) {
        if (abortReason === 'maxMs') {
          return { ok: false, seconds: 0, bytes: 0, qn: qnActual, codec, message: '拉流超时：未能在时限内连上直播流' }
        }
        return { ok: false, aborted: true, seconds: 0, bytes: 0, qn: qnActual, codec }
      }
      return { ok: false, seconds: 0, bytes: 0, qn: qnActual, codec, message: `连接直播流失败：${e?.message || e}` }
    }
    if (!r.ok) {
      let detail = ''
      try {
        detail = String(await r.text()).replace(/\s+/g, ' ').trim().slice(0, 100)
      } catch {
        /* 忽略读 body 失败 */
      }
      return {
        ok: false,
        seconds: 0,
        bytes: 0,
        qn: qnActual,
        codec,
        message: `直播流 HTTP ${r.status}${detail ? `：${detail}` : ''}`,
      }
    }
    streaming = true
    startProgress()

    /* ③ 逐块读取、统计、丢弃（不解码、不落盘） */
    for await (const chunk of r.body) {
      stats.bytes += chunk?.length || 0
      stats.seconds = Math.round((Date.now() - t0) / 1000)
    }
    // for-await 正常结束 = 服务端关流（主播下播 / 网络断）
    log(onLog, `拉流结束（断流）：${Math.round(stats.seconds)}s · ${Math.round(stats.bytes / 1024)} KB`)
    return {
      ok: false,
      seconds: Math.round((Date.now() - t0) / 1000),
      bytes: stats.bytes,
      qn: qnActual,
      codec,
      message: '直播流已结束（断流，可能是主播下播或网络中断）',
    }
  } catch (e) {
    if (e?.name === 'AbortError' || ctl.signal.aborted) {
      if (abortReason === 'maxMs' && streaming) {
        // 到达 maxMs：本次「观看」时长目标已达成 → 正常结束
        const seconds = Math.round((Date.now() - t0) / 1000)
        log(onLog, `拉流结束（到点）：${seconds}s · ${Math.round(stats.bytes / 1024)} KB`)
        return {
          ok: true,
          seconds,
          bytes: stats.bytes,
          qn: qnActual,
          codec,
        }
      }
      if (abortReason === 'maxMs') {
        return { ok: false, seconds: 0, bytes: 0, qn: qnActual, codec, message: '拉流超时：未能在时限内拿到直播流' }
      }
      log(onLog, `拉流已取消：${Math.round(stats.seconds)}s · ${Math.round(stats.bytes / 1024)} KB`)
      return {
        ok: false,
        aborted: true,
        seconds: Math.round((Date.now() - t0) / 1000),
        bytes: stats.bytes,
        qn: qnActual,
        codec,
      }
    }
    return {
      ok: false,
      seconds: Math.round((Date.now() - t0) / 1000),
      bytes: stats.bytes,
      qn: qnActual,
      codec,
      message: `拉流中断：${e?.message || e}`,
    }
  } finally {
    clearTimeout(timer)
    if (progressTimer) clearInterval(progressTimer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 看 `ms` 毫秒直播的便捷包装：最多跑 ms 毫秒，到点由 pullStream 的 maxMs 正常收尾。
 *
 * 用于「观看直播」任务：调用方给一个时长（例如 10 分钟），拿到回包后把 seconds 记进当日状态。
 * 上层取消（切台/停止/插件卸载）通过 opts.signal 传入。
 *
 * @param {object} cred
 * @param {number|string} realRoomId
 * @param {number} ms 本次想看的毫秒数（到点即结束，不会超时太久）
 * @param {object} [opts] 同 pullStream（qn/onProgress/onLog/signal）
 * @returns {Promise<{ok:boolean, seconds:number, bytes:number, aborted?:boolean, message?:string}>}
 */
export async function watchFor(cred, realRoomId, ms, opts = {}) {
  const durMs = Math.max(1, Math.trunc(Number(ms)) || 0)
  const res = await pullStream(cred, realRoomId, {
    ...opts,
    maxMs: durMs, // 到点正常结束 → ok:true
  })
  if (res.ok) return { ok: true, seconds: res.seconds, bytes: res.bytes }
  if (res.aborted) return { ok: false, aborted: true, seconds: res.seconds ?? 0, bytes: res.bytes ?? 0 }
  return { ok: false, seconds: res.seconds ?? 0, bytes: res.bytes ?? 0, message: res.message || '拉流失败' }
}
