#!/usr/bin/env node
/**
 * scripts/probe.mjs —— P0 技术探针（独立运行，不注册 DSH 插件）
 * ============================================================================
 * 目的：用你自己的账号，对 B站 直播的「点赞 / 礼物配置 / 电池余额 / 送礼 / 观看上报」
 *       做最小化真实验证，拿到真实返回码后再决定 dsh-bili-duty 的功能取舍。
 *
 * 用法：
 *   node scripts/probe.mjs login-qr                 生成登录二维码（SVG/PNG/ASCII），有效期约 3 分钟
 *   node scripts/probe.mjs login-poll --wait=180    轮询扫码结果，成功后把凭证写到 .probe/credential.json
 *   node scripts/probe.mjs rooms --uids=UID1,UID2   解析主播房间号与开播状态（免登录）
 *   node scripts/probe.mjs room --room=12345        查房间详情（免登录）
 *   node scripts/probe.mjs user                     我是谁（需要登录）
 *   node scripts/probe.mjs medal --up=UID           查自己对该主播的粉丝牌/亲密度（需要登录）
 *   node scripts/probe.mjs like --room=12345        在一个在播房间点 1 次赞（候选接口逐个试，写操作！）
 *   node scripts/probe.mjs gift-info --room=12345   只读：礼物配置 + 电池余额（候选接口逐个试）
 *   node scripts/probe.mjs gift-test --room=12345 --gift-id=ID --price=1 --coin-type=gold --yes-spend
 *                                                   真实送礼（扣费！必须显式 --yes-spend）
 *   node scripts/probe.mjs watch --room=12345 --seconds=300 [--qn=150]
 *                                                   拉低清流 N 秒，验证「观看直播」是否计入
 *   node scripts/probe.mjs help                     显示本说明
 *
 * 约定：
 *   - 所有结果写入 .probe/out/*.json（已 gitignore）；凭证写入 .probe/credential.json（0600）
 *   - 绝不打印 cookie / SESSDATA；写操作失败不自动重试
 *   - 接口地址是「候选」，B站 非公开接口可能变更：探针会逐个试并打印 code，便于迭代
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { generateQr, pollQr, whoAmI, qrSvg, loadQrLib, fetchBuvid3 } from '../lib/auth.mjs'
import { getRoomByUid, getRoomInfo, headersOf } from '../lib/live.mjs'
import { getPlayUrl } from '../lib/duty-watch.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = join(REPO, '.probe')
const OUT = join(ROOT, 'out')
const CRED_FILE = join(ROOT, 'credential.json')
const QR_FILE = join(ROOT, 'qr.json')
const QR_LIB = join(REPO, 'vendor', 'qrcode.js')

mkdirSync(OUT, { recursive: true, mode: 0o700 })

const argv = process.argv.slice(2)
const cmd = String(argv[0] || 'help').replace(/^--/, '')
const opt = (name, dflt = '') => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes(`--${name}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[probe]', ...a)

function saveJson(file, obj, mode) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
  if (mode) {
    try { chmodSync(file, mode) } catch { /* 忽略 */ }
  }
}
function loadCred() {
  try { return JSON.parse(readFileSync(CRED_FILE, 'utf8')) } catch { return null }
}
function credOrExit() {
  const c = loadCred()
  if (!c?.sessdata) {
    console.error('[probe] 没有凭证：先跑 `node scripts/probe.mjs login-qr`，扫码后跑 `login-poll`')
    process.exit(2)
  }
  return c
}
function saveOut(kind, rows) {
  const f = join(OUT, `${kind}-${Date.now()}.json`)
  saveJson(f, { at: new Date().toISOString(), kind, rows })
  log('原始结果已存:', f)
  return f
}

/** 发一次 HTTP 请求并把 B站 响应归一成 {status, code, message, data, text, ms} */
async function httpJson(url, { method = 'GET', form, cred, referer = 'https://live.bilibili.com/', timeoutMs = 15000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const headers = { ...headersOf(cred, referer) }
    let body
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers.Origin = 'https://live.bilibili.com'
      body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString()
    }
    const r = await fetch(url, { method, headers, body, signal: ctl.signal })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON：保留 text 片段 */ }
    return {
      status: r.status,
      ms: Date.now() - t0,
      code: json?.code ?? null,
      message: String(json?.message || ''),
      data: json?.data ?? null,
      text: text.slice(0, 2000),
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '请求超时' : String(e?.message || e)
    return { status: 0, ms: Date.now() - t0, code: null, message: msg, data: null, text: '' }
  } finally {
    clearTimeout(timer)
  }
}

function show(label, r) {
  console.log(`  ${label} → HTTP ${r.status} · code=${r.code} · ${r.message || '(无 message)'} · ${r.ms}ms`)
  if (r.data && ['gift-info', 'user', 'medal'].includes(cmd)) {
    const s = JSON.stringify(r.data)
    console.log('    data:', s.length > 700 ? s.slice(0, 700) + '…' : s)
  }
}

/* ────────────────────────── 二维码展示 ────────────────────────── */

function qrMatrix(text) {
  const make = loadQrLib(QR_LIB)
  const qr = make(0, 'M')
  qr.addData(String(text))
  qr.make()
  const n = qr.getModuleCount()
  const m = []
  for (let r = 0; r < n; r += 1) {
    const row = []
    for (let c = 0; c < n; c += 1) row.push(qr.isDark(r, c) ? 1 : 0)
    m.push(row)
  }
  return m
}

/** 终端 ASCII 二维码（半块字符，上下两个模块合成一行；带 2 格静区） */
function printAsciiQr(matrix) {
  const pad = 2
  const n = matrix.length
  const at = (r, c) => (r >= pad && r < n + pad && c >= pad && c < n + pad ? matrix[r - pad][c - pad] : 0)
  for (let r = -pad; r < n + pad; r += 2) {
    let line = ''
    for (let c = -pad; c < n + pad; c += 1) {
      const top = at(r, c)
      const bottom = at(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    console.log(line)
  }
}

/** 用本机 python3 + Pillow 把矩阵画成 PNG（读图更方便扫码） */
function writePng(matrix) {
  const png = join(ROOT, 'login.png')
  const py = [
    'import json,sys',
    'from PIL import Image',
    'm=json.loads(sys.stdin.read())["matrix"]',
    'n=len(m); scale=max(4, 400//n); pad=4',
    'size=(n+pad*2)*scale',
    'img=Image.new("L",(size,size),255)',
    'px=img.load()',
    'for r,row in enumerate(m):',
    '    for c,v in enumerate(row):',
    '        if not v: continue',
    '        y0=(r+pad)*scale; x0=(c+pad)*scale',
    '        for y in range(y0,y0+scale):',
    '            for x in range(x0,x0+scale): px[x,y]=0',
    'img.save(sys.argv[1])',
  ].join('\n')
  const r = spawnSync('python3', ['-c', py, png], { input: JSON.stringify({ matrix }), encoding: 'utf8' })
  if (r.status !== 0 || !existsSync(png)) {
    console.error('[probe] PNG 生成失败（不影响扫码）:', String(r.stderr || '').slice(0, 200))
    return ''
  }
  return png
}

/* ────────────────────────── 命令 ────────────────────────── */

async function cmdLoginQr() {
  const { key, url } = await generateQr()
  saveJson(QR_FILE, { key, url, at: new Date().toISOString() })
  writeFileSync(join(ROOT, 'login.svg'), qrSvg(QR_LIB, url, 6), 'utf8')
  const matrix = qrMatrix(url)
  saveJson(join(ROOT, 'qr-matrix.json'), { matrix })
  const png = writePng(matrix)
  console.log('')
  console.log('用 B站 手机 App 扫描下面的二维码（约 3 分钟内有效）：')
  console.log('')
  printAsciiQr(matrix)
  console.log('')
  log('SVG:', join(ROOT, 'login.svg'))
  if (png) log('PNG:', png)
  log('扫完并确认后，运行：node scripts/probe.mjs login-poll --wait=180')
}

async function cmdLoginPoll() {
  if (!existsSync(QR_FILE)) { console.error('[probe] 还没有二维码，先跑 login-qr'); process.exit(1) }
  const q = JSON.parse(readFileSync(QR_FILE, 'utf8'))
  const waitSec = Number(opt('wait', '180')) || 180
  const deadline = Date.now() + waitSec * 1000
  let last = ''
  while (Date.now() < deadline) {
    const r = await pollQr(q.key)
    if (r.status === 'ok') {
      const cred = {
        sessdata: r.cred.sessdata,
        bili_jct: r.cred.bili_jct,
        buvid3: r.cred.buvid3 || await fetchBuvid3(),
        dedeuserid: r.cred.dedeuserid,
        uname: '',
        saved_at: new Date().toISOString(),
      }
      const me = await whoAmI(cred)
      cred.uname = me?.uname || ''
      saveJson(CRED_FILE, cred, 0o600)
      log('登录成功:', cred.uname || '(未取到昵称)', 'UID=' + (cred.dedeuserid || '?'))
      log('凭证已写入:', CRED_FILE)
      return
    }
    if (r.status !== last) {
      last = r.status
      log('扫码状态:', r.status, r.message || '')
    }
    if (r.status === 'expired') break
    await sleep(2000)
  }
  console.error('[probe] 登录未完成（超时或二维码过期），重新跑 login-qr')
  process.exit(1)
}

async function cmdRooms() {
  const uids = String(opt('uids', '')).split(',').map((s) => s.trim()).filter(Boolean)
  if (!uids.length) { console.error('[probe] 用法: rooms --uids=UID1,UID2'); process.exit(2) }
  const rows = []
  for (const uid of uids) {
    try {
      const r = await getRoomByUid(uid, null)
      rows.push({ uid, ok: true, ...r })
      console.log(`  ${uid} → 房间 ${r.roomId} · ${r.liveStatus === 1 ? 'LIVE' : 'offline'} · ${r.uname || '?'} · ${r.title || ''}`)
    } catch (e) {
      rows.push({ uid, ok: false, error: String(e?.message || e) })
      console.log(`  ${uid} → 失败: ${String(e?.message || e)}`)
    }
  }
  saveOut('rooms', rows)
}

async function cmdRoom() {
  const room = String(opt('room', '')).replace(/\D/g, '')
  if (!room) { console.error('[probe] 用法: room --room=12345'); process.exit(2) }
  const info = await getRoomInfo(room, null)
  console.log('  房间信息:', JSON.stringify(info, null, 2))
  try {
    const play = await getPlayUrl(info.realRoomId || room, null, { qn: '150' })
    console.log('  低清流可用: qn=' + play.qn, 'codec=' + play.codec)
  } catch (e) {
    console.log('  拉流失败:', String(e?.message || e))
  }
  saveOut('room', [{ room, info }])
}

async function cmdUser() {
  const cred = credOrExit()
  const me = await whoAmI(cred)
  console.log('  我是谁:', JSON.stringify(me))
  const nav = await httpJson('https://api.bilibili.com/x/web-interface/nav', { cred })
  show('nav', nav)
  saveOut('user', [{ me, nav: { code: nav.code, message: nav.message, data: nav.data } }])
}

async function cmdMedal() {
  const cred = credOrExit()
  const up = String(opt('up', '')).replace(/\D/g, '')
  if (!up) { console.error('[probe] 用法: medal --up=主播UID'); process.exit(2) }
  const rows = []
  const candidates = [
    { id: 'M1', url: `https://api.live.bilibili.com/fans_medal/v1/fans_medal/get_fans_medal_info?target_id=${up}&source=0` },
    { id: 'M2', url: `https://api.live.bilibili.com/fans_medal/v1/medal/get_medal_info?target_id=${up}` },
  ]
  for (const c of candidates) {
    const r = await httpJson(c.url, { cred })
    show(c.id, r)
    rows.push({ candidate: c.id, url: c.url, status: r.status, code: r.code, message: r.message, data: r.data })
  }
  saveOut('medal', rows)
}

async function cmdLike() {
  const cred = credOrExit()
  const room = String(opt('room', '')).replace(/\D/g, '')
  const count = Math.max(1, Math.min(1000, Number(opt('count', '1')) || 1))
  if (!room) { console.error('[probe] 用法: like --room=12345 [--count=1]（必须是正在直播的房间）'); process.exit(2) }
  const info = await getRoomInfo(room, cred)
  if (Number(info.liveStatus) !== 1) {
    console.error('[probe] 该房间现在没在播，点赞没有意义（换一个在播房间）')
    process.exit(1)
  }
  const realRoom = String(info.realRoomId || room)
  const anchor = String(info.uid || '')
  const uid = String(cred.dedeuserid || '')
  const referer = `https://live.bilibili.com/${realRoom}`
  const rows = []

  // ① 进房（网页端会先调这个；失败不阻断点赞）
  const entry = await httpJson('https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction', {
    method: 'POST',
    cred,
    referer,
    form: { room_id: realRoom, platform: 'pc', csrf: cred.bili_jct, csrf_token: cred.bili_jct, visit_id: '' },
  })
  show('进房 roomEntryAction', entry)
  rows.push({ step: 'entry', status: entry.status, code: entry.code, message: entry.message, data: entry.data })

  // ② 房间下发的点赞策略（click_block / 每批数量 / 最小间隔）
  const policy = await httpJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${realRoom}`, { cred, referer })
  const likeInfo = policy.data?.like_info_v3 || null
  console.log(
    '  点赞策略 like_info_v3:',
    likeInfo
      ? `click_block=${likeInfo.click_block} count_block=${likeInfo.count_block} report_click_limit=${likeInfo.report_click_limit} report_time_min=${likeInfo.report_time_min}s total_likes=${likeInfo.total_likes}`
      : `(拿不到，code=${policy.code})`,
  )
  rows.push({ step: 'policy', status: policy.status, code: policy.code, message: policy.message, like_info_v3: likeInfo })

  // ③ 点赞（click_time = 这一批点几次）
  const like = await httpJson('https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3', {
    method: 'POST',
    cred,
    referer,
    form: {
      room_id: realRoom,
      anchor_id: anchor,
      uid,
      click_time: String(count),
      csrf: cred.bili_jct,
      csrf_token: cred.bili_jct,
      visit_id: '',
    },
  })
  show(`点赞 likeReportV3（click_time=${count}）`, like)
  rows.push({ step: 'like', status: like.status, code: like.code, message: like.message, data: like.data, click_time: count })
  saveOut('like', rows)
}

async function cmdGiftInfo() {
  const cred = credOrExit()
  const room = String(opt('room', '')).replace(/\D/g, '')
  if (!room) { console.error('[probe] 用法: gift-info --room=12345'); process.exit(2) }
  const info = await getRoomInfo(room, cred).catch(() => null)
  const realRoom = String(info?.realRoomId || room)
  const anchor = String(info?.uid || '')
  const uid = String(cred.dedeuserid || '')
  const referer = `https://live.bilibili.com/${realRoom}`
  const rows = []
  const common = { area_id: '0', area_parent_id: '0', platform: 'pc', source: 'live' }

  // 礼物配置 / 礼物页 / 钱包 / 粉丝牌（只读；逐个候选试）
  const calls = [
    {
      group: 'gift-config',
      id: 'G1 giftConfig',
      url: 'https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig',
      query: { room_id: realRoom, ...common },
    },
    {
      group: 'gift-config',
      id: 'G2 giftData',
      url: 'https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftData',
      query: { room_id: realRoom, ...common },
    },
    {
      group: 'gift-config',
      id: 'G3 tabRoomGiftList',
      url: 'https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/tabRoomGiftList',
      query: { ruid: anchor, tab_id: '0', room_id: realRoom, ...common, build: '1', receive_users: '' },
    },
    { group: 'balance', id: 'B1 myWallet', url: 'https://api.live.bilibili.com/xlive/revenue/v1/wallet/myWallet' },
    { group: 'balance', id: 'B2 myGoldWallet', url: 'https://api.live.bilibili.com/xlive/revenue/v1/wallet/myGoldWallet' },
    { group: 'balance', id: 'B3 mySliverWallet', url: 'https://api.live.bilibili.com/xlive/revenue/v1/wallet/mySliverWallet' },
    {
      group: 'medal',
      id: 'M1 user_medal_info',
      url: 'https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/user_medal_info',
      query: { uid, up_uid: anchor },
    },
  ]
  for (const c of calls) {
    const qs = c.query ? '?' + new URLSearchParams(c.query).toString() : ''
    const r = await httpJson(c.url + qs, { cred, referer })
    show(c.id, r)
    rows.push({ group: c.group, candidate: c.id, url: c.url, query: c.query, status: r.status, code: r.code, message: r.message, data: r.data })
  }
  saveOut('gift-info', rows)
}

async function cmdGiftTest() {
  const cred = credOrExit()
  if (!flag('yes-spend')) {
    console.error('[probe] 送礼会扣真实电池：确认后加 --yes-spend 才会执行')
    process.exit(2)
  }
  const room = String(opt('room', '')).replace(/\D/g, '')
  const giftId = String(opt('gift-id', '')).replace(/\D/g, '')
  const price = String(opt('price', '100'))
  const coinType = String(opt('coin-type', 'gold'))
  const num = String(opt('num', '1'))
  if (!room || !giftId) {
    console.error('[probe] 用法: gift-test --room=12345 --gift-id=ID --price=100 --coin-type=gold --yes-spend')
    process.exit(2)
  }
  const info = await getRoomInfo(room, cred)
  if (Number(info.liveStatus) !== 1) { console.error('[probe] 房间没在播，不能送礼'); process.exit(1) }
  const upUid = String(info.uid || '')
  const referer = `https://live.bilibili.com/${info.realRoomId}`
  const uid = String(cred.dedeuserid || '')
  const form = {
    uid,
    gift_id: giftId,
    ruid: upUid,
    send_ruid: '0',
    gift_num: num,
    coin_type: coinType,
    bag_id: '0',
    platform: 'pc',
    biz_code: 'Live',
    biz_id: String(info.realRoomId),
    storm_beat_id: '0',
    metadata: '',
    price,
    receive_users: JSON.stringify([{ uid: Number(upUid) }]),
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
  }
  const url = 'https://api.live.bilibili.com/xlive/revenue/v2/gift/sendGoldMultiUser'
  console.log(`  即将送出：gift_id=${giftId} num=${num} price=${price} coin=${coinType} → 房间 ${info.realRoomId}（主播 ${info.uname || upUid}）`)
  console.log(`  送礼账号 UID=${uid}`)
  const r = await httpJson(url, { method: 'POST', form, cred, referer })
  show('gift sendGoldMultiUser', r)
  saveOut('gift-test', [{
    url,
    form: { ...form, csrf: '***', csrf_token: '***' },
    status: r.status,
    code: r.code,
    message: r.message,
    data: r.data,
  }])
}

async function cmdWatch() {
  const cred = credOrExit()
  const room = String(opt('room', '')).replace(/\D/g, '')
  const seconds = Math.max(10, Math.min(3600, Number(opt('seconds', '300')) || 300))
  const qn = String(opt('qn', '150'))
  const presence = flag('presence')
  if (!room) { console.error('[probe] 用法: watch --room=12345 --seconds=960 --qn=250 [--presence]'); process.exit(2) }
  const info = await getRoomInfo(room, cred)
  const realRoom = info.realRoomId || Number(room)
  if (Number(info.liveStatus) !== 1) { console.error('[probe] 房间没在播，拉流没有意义'); process.exit(1) }
  let dm = null
  if (presence) {
    // 完整「在场」：进房接口 + 弹幕长连接（每 30 秒心跳），这才是 B站 统计观看时长的正常客户端行为
    const entry = await httpJson('https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction', {
      method: 'POST', cred, referer: `https://live.bilibili.com/${realRoom}`,
      form: { room_id: realRoom, platform: 'pc', csrf: cred.bili_jct, csrf_token: cred.bili_jct, visit_id: '' },
    })
    show('进房 roomEntryAction', entry)
    const { DanmakuClient } = await import('../lib/live.mjs')
    dm = new DanmakuClient({ roomId: realRoom, cred, onDanmaku: () => {}, onEvent: () => {}, onStatus: (s) => console.log('[probe] 弹幕连接状态:', s), onLog: (m) => console.log('[probe] dm:', m) })
    await dm.start()
    console.log('[probe] 已连接弹幕长连接（30s 心跳），开始累计观看时长')
  }
  const play = await getPlayUrl(realRoom, cred, { qn })
  log(`开始拉流 ${seconds}s（qn=${play.qn} codec=${play.codec}），只读取丢弃，不落盘`)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), seconds * 1000)
  const t0 = Date.now()
  let bytes = 0
  let chunks = 0
  try {
    const r = await fetch(play.url, {
      headers: { ...headersOf(cred, `https://live.bilibili.com/${realRoom}`) },
      signal: ctl.signal,
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    for await (const chunk of r.body) {
      bytes += chunk.length
      chunks += 1
      if (chunks % 200 === 0) log(`  已拉 ${Math.round((Date.now() - t0) / 1000)}s · ${Math.round(bytes / 1024)} KB`)
    }
  } catch (e) {
    if (e?.name !== 'AbortError') console.log('  拉流中断:', String(e?.message || e))
  } finally {
    clearTimeout(timer)
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  log(`拉流结束：${secs}s · ${Math.round(bytes / 1024)} KB · 平均 ${Math.round(bytes / 1024 / Math.max(1, secs))} KB/s`)
  if (dm) { try { dm.stop() } catch { /* 收摊 */ } }
  console.log('')
  console.log('接下来请手动验证「观看直播」任务：打开 B站 App/网页 → 该主播直播间 → 粉丝团/亲密度面板，')
  console.log('看「观看直播」分钟数有没有随刚才的挂机增长（通常要挂满 5 分钟以上才计入）。')
  saveOut('watch', [{ room: realRoom, uname: info.uname, seconds: secs, bytes, qn: play.qn, codec: play.codec }])
}

function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const m = text.match(/\/\*\*([\s\S]*?)\*\//)
  console.log(m ? m[1].replace(/^ \* ?/gm, '').trim() : '')
}

async function main() {
  switch (cmd) {
    case 'login-qr': return cmdLoginQr()
    case 'login-poll': return cmdLoginPoll()
    case 'rooms': return cmdRooms()
    case 'room': return cmdRoom()
    case 'user': return cmdUser()
    case 'medal': return cmdMedal()
    case 'like': return cmdLike()
    case 'gift-info': return cmdGiftInfo()
    case 'gift-test': return cmdGiftTest()
    case 'watch': return cmdWatch()
    case 'help':
    case '--help':
    case '-h':
    default:
      usage()
      if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
        console.error(`\n[probe] 未知命令: ${cmd}`)
        process.exit(2)
      }
  }
}

main().catch((e) => {
  console.error('[probe] 失败:', e?.stack || e)
  process.exit(1)
})
