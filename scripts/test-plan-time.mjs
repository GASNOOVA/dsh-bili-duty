/**
 * scripts/test-plan-time.mjs —— 计划时间按北京时间处理/展示的回归测试
 * 用法：node scripts/test-plan-time.mjs
 *
 * 覆盖：
 *  1) POST /plans add 保存的是绝对时刻（ISO），配置里读回一致；
 *  2) POST /plans import 去重（mid+at）并持久化；
 *  3) 计划增删日志带「北京时间」与北京时间字符串；
 *  4) client.js 不再用浏览器本地时区格式化计划时间（回归到 13日20:00 的 bug）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const ROOT = '/tmp/bili-duty-plan-time-test'
rmSync(ROOT, { recursive: true, force: true })
const HOME = join(ROOT, 'dsh')
mkdirSync(join(HOME, 'bili-duty'), { recursive: true })

const streamers = [
  { mid: '672353429', roomId: '22632424', name: '贝拉kira', enabled: true, order: 0 },
  { mid: '672342685', roomId: '22625027', name: '乃琳Queen', enabled: true, order: 1 },
]
const config = {
  enabled: true,
  streamers,
  autoEnabled: false,
  autoCheckMs: 1800000,
  workHours: '08:00-24:00',
  workHoursTz: 'beijing',
  plans: [],
  taskWatch: false,
  taskLike: false,
  taskGift: false,
  taskDanmaku: false,
  aiDanmaku: false,
  greetingTemplates: [],
}
const cred = { sessdata: 'mock', bili_jct: 'mock', buvid3: 'mock', dedeuserid: '23209281', uname: 'tester', saved_at: Date.now() }
writeFileSync(join(HOME, 'bili-duty', 'config.json'), JSON.stringify(config, null, 2))
writeFileSync(join(HOME, 'bili-duty', 'credential.json'), JSON.stringify(cred, null, 2))

// 贝拉预约：B站 卡片文案「明天 03:00 直播」解析出的绝对时刻（北京 2026-11-14 03:00 = UTC 11-13 19:00）
const BJ_AT = '2026-11-13T19:00:00.000Z'
const NAI_AT = '2026-11-14T19:00:00.000Z'

const WBI_IMG = 'a'.repeat(64)
const WBI_SUB = 'b'.repeat(64)
const json = (v) => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(v) })
global.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/x/web-interface/nav')) return json({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${WBI_IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${WBI_SUB}.png` } } })
  return json({ code: 0, data: {} })
}

let handler = null
let cleanup = null
const ctx = {
  webServer: { register: (opts) => { handler = opts.handler; return () => { handler = null } } },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanup = d; return d },
  get: (name) => (name === 'dshHomePath' ? (sub) => join(HOME, sub) : null),
}

const { apply } = await import('../index.js?test=' + Math.random())
apply(ctx)
await new Promise((r) => setTimeout(r, 50))
if (!handler) throw new Error('没注册到 /api/bili-duty 路由')

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    const res = { statusCode: 200, setHeader: () => {}, end: (t) => { try { resolve(JSON.parse(t)) } catch (e) { reject(e) } } }
    Promise.resolve(handler(req, res)).catch(reject)
    if (method === 'POST') {
      setImmediate(() => {
        req.emit('data', JSON.stringify(body || {}))
        req.emit('end')
      })
    }
  })
}

const readCfg = () => JSON.parse(readFileSync(join(HOME, 'bili-duty', 'config.json'), 'utf8'))

// 1) 手动添加一条计划（北京 11-14 03:00）
let r = await call('POST', '/api/bili-duty/plans', { action: 'add', plan: { mid: '672353429', name: '贝拉kira', at: BJ_AT } })
if (!r.ok) throw new Error('add 失败: ' + JSON.stringify(r))
const planAfterAdd = (readCfg().plans || []).slice()
const savedBella = planAfterAdd.find((p) => p.at === BJ_AT)

// 2) 导入同一场（应跳过）+ 另一场（应新增）
const WBI_AT_NOW = Date.now()
r = await call('POST', '/api/bili-duty/plans', {
  action: 'import',
  items: [
    { mid: '672353429', name: '贝拉kira', at: BJ_AT },
    { mid: '672342685', name: '乃琳Queen', at: NAI_AT },
  ],
})
if (!r.ok) throw new Error('import 失败: ' + JSON.stringify(r))
const importResult = { added: r.added, skipped: r.skipped }
const savedAfterImport = readCfg().plans || []
const log = readFileSync(join(HOME, 'bili-duty', 'live.log'), 'utf8').replaceAll(WBI_AT_NOW, '')

const addLogLine = log.split('\n').find((x) => x.includes('手动计划已添加')) || ''
const importLogLine = log.split('\n').find((x) => x.includes('从预约导入计划')) || ''
const bellaAfterImport = savedAfterImport.find((p) => p.at === BJ_AT)
const naiSaved = savedAfterImport.find((p) => p.mid === '672342685' && p.at === NAI_AT)

// 3) 删除计划
r = await call('POST', '/api/bili-duty/plans', { action: 'remove', id: savedBella?.id || 'none' })
if (!r.ok) throw new Error('remove 失败: ' + JSON.stringify(r))
const savedAfterRemove = readCfg().plans || []
const logAfterRemove = readFileSync(join(HOME, 'bili-duty', 'live.log'), 'utf8')
const delLogLine = logAfterRemove.split('\n').find((x) => x.includes('删除手动计划')) || ''

// 4) client.js 必须按北京时间（+8）格式化，不能再直接用浏览器本地时区
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const fmtFn = clientSrc.slice(clientSrc.indexOf('const fmtPlanTime'), clientSrc.indexOf('const toLocalInput'))
const asserts = [
  ['add 返回 ok', r.ok === true],
  ['手动添加的计划持久化到 config', Boolean(savedBella)],
  ['持久化的是绝对时刻（19:00Z = 北京 11-14 03:00）', savedBella?.at === BJ_AT],
  ['导入去重：贝拉同一场未重复新增（added=1, skipped=1）', importResult.added === 1 && importResult.skipped === 1],
  ['导入后贝拉计划只存在一条', savedAfterImport.filter((p) => p.at === BJ_AT).length === 1 && Boolean(bellaAfterImport)],
  ['导入新增了乃琳那场', Boolean(naiSaved)],
  ['导入日志带北京时间且含新增的乃琳 11-15 03:00', importLogLine.includes('北京时间') && importLogLine.includes('11-15 03:00')],
  ['添加日志带北京时间', addLogLine.includes('北京时间') && addLogLine.includes('11-14 03:00')],
  ['删除日志带北京时间', delLogLine.includes('北京时间') && delLogLine.includes('11-14 03:00')],
  ['删除后配置里不再有该计划', !savedAfterRemove.some((p) => p.at === BJ_AT)],
  ['client fmtPlanTime 用 +8 小时偏移', fmtFn.includes('+ 8 * 3600 * 1000') || fmtFn.includes('+8 * 3600 * 1000')],
  ['client 计划时间带「（北京时间）」后缀', fmtFn.includes('（北京时间）')],
  ['client 有本机时间提示 helper', clientSrc.includes('fmtLocalTime')],
]
let failed = 0
for (const [name, ok] of asserts) {
  console.log(ok ? `  PASS  ${name}` : `  FAIL  ${name}`)
  if (!ok) failed += 1
}
if (typeof cleanup === 'function') cleanup()
console.log(`\n${failed ? '失败 ' + failed + ' 项' : '全部通过'}`)
process.exit(failed ? 1 : 0)
