/**
 * scripts/test-like-cap.mjs —— 「每日点赞总上限」测试
 * 用法：node scripts/test-like-cap.mjs
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, normalizeConfig } from '../lib/duty-config.mjs'
import { likeBudget } from '../lib/duty-like.mjs'
import { createStore } from '../lib/duty-state.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, '.probe', 'like-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let failed = 0
const ok = (cond, msg) => { if (!cond) { console.error('FAIL', msg); failed += 1 } else console.log('PASS', msg) }

/* 1) 配置默认值与归一化 */
ok(DEFAULTS.likeDailyMax === 600, `默认每日上限应为 600（实际 ${DEFAULTS.likeDailyMax}）`)
ok(normalizeConfig({}).likeDailyMax === 600, '缺省时 normalize 应补 600')
ok(normalizeConfig({ likeDailyMax: 500 }).likeDailyMax === 500, '自定义 500 应保留')
ok(normalizeConfig({ likeDailyMax: 0 }).likeDailyMax === 1, '0 应被夹到下限 1')
ok(normalizeConfig({ likeDailyMax: 99999 }).likeDailyMax === 10000, '超大值应被夹到上限 10000')

/* 2) 预算计算 */
const b1 = likeBudget({ spent: 0, dailyMax: 600, roundClicks: 300 })
ok(b1.clicks === 300 && b1.remain === 600 && !b1.exhausted, '全新一天应可点满一整轮')
const b2 = likeBudget({ spent: 550, dailyMax: 600, roundClicks: 300 })
ok(b2.clicks === 50 && b2.remain === 50 && !b2.exhausted, '接近上限时应只点剩余 50 次')
const b3 = likeBudget({ spent: 600, dailyMax: 600, roundClicks: 300 })
ok(b3.clicks === 0 && b3.exhausted, '达到上限后应停止')
const b4 = likeBudget({ spent: 730, dailyMax: 600, roundClicks: 100 })
ok(b4.clicks === 0 && b4.remain === 0 && b4.exhausted, '已超上限时不得再点')
const b5 = likeBudget({ spent: 0, dailyMax: 600, roundClicks: 0 })
ok(b5.clicks === 0 && !b5.exhausted, '本轮配额为 0 时不应误判为已达上限')

/* 3) state 累计口径（likeSpentToday 依赖 roomsToday 求和） */
const store = createStore(tmp)
store.ensureRoom(22625027, { mid: '672342685', name: '乃琳Queen' })
store.ensureRoom(22632424, { mid: '672353429', name: '贝拉kira' })
store.markLike(22625027, 100)
store.markLike(22632424, 30)
store.markLike(22632424, 20)
store.save()
const spent = store.roomsToday().reduce((sum, r) => sum + (Number(r.likeClicks) || 0), 0)
ok(spent === 150, `跨房间累计应为 150（实际 ${spent}）`)

/* 4) 源码接线检查 */
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const configSrc = readFileSync(join(root, 'lib', 'duty-config.mjs'), 'utf8')
ok(indexSrc.includes('import { likeBudget }'), 'index.js 应引入 likeBudget')
ok(indexSrc.includes('likeSpentToday()') && indexSrc.includes('likeDailyMax'), 'index.js 应使用全局累计与上限')
ok(indexSrc.includes('今日点赞总数已达上限'), 'index.js 应有达到上限的日志')
ok(indexSrc.includes('（今日 ${likeSpentToday()}/${budget.max}）'), 'index.js 完成日志应带今日累计')
ok(indexSrc.includes('like: { today: likeSpentToday(), max: cfg.likeDailyMax }'), '/status 应返回今日点赞统计')
ok(/likeSpentToday\(\) < cfg\.likeDailyMax/.test(indexSrc), '周期点赞前应检查是否已达上限')
ok(configSrc.includes('likeDailyMax: 600'), '配置默认值应含 likeDailyMax: 600')
ok(clientSrc.includes('每日总上限（全局）'), '设置页应有「每日总上限（全局）」字段')
ok(clientSrc.includes('likeDailyMax: clampInt(f.likeDailyMax, 1, 10000, 600)'), '前端提交应带 likeDailyMax')

rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
