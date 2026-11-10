/**
 * scripts/test-clean.mjs —— 运行时清理逻辑测试（日志轮转 + 计划裁剪）
 * 用法：node scripts/test-clean.mjs
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prunePlans, rotateLogIfNeeded } from '../lib/duty-clean.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.probe', 'clean-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (cond, msg) => { if (!cond) { console.error('FAIL', msg); failed += 1 } else console.log('PASS', msg) }

/* 1) 日志轮转：超限只留最后 keepLines 行 */
const logFile = join(root, 'live.log')
const lines = []
for (let i = 0; i < 6000; i += 1) lines.push(`[00:00:00] 第 ${i} 行日志 填充内容填充内容填充内容`)
writeFileSync(logFile, lines.join('\n') + '\n', 'utf8')
const before = statSync(logFile).size
const r = rotateLogIfNeeded(logFile, { maxBytes: 64 * 1024, keepLines: 400 })
const afterText = readFileSync(logFile, 'utf8')
const afterLines = afterText.split('\n').filter(Boolean)
ok(r.rotated === true, '超限日志应触发轮转')
ok(afterLines.length === 400, `轮转后应保留 400 行（实际 ${afterLines.length}）`)
ok(afterLines[afterLines.length - 1].includes('第 5999 行'), '最后一行应是原日志最后一行')
ok(statSync(logFile).size < before, '轮转后体积应变小')
ok(!statSync(logFile).size || statSync(logFile).size <= 64 * 1024, '轮转后体积不超过阈值')

/* 2) 小文件不轮转；不存在也不报错 */
const small = join(root, 'small.log')
writeFileSync(small, 'a\nb\n', 'utf8')
ok(rotateLogIfNeeded(small).rotated === false, '小文件不应轮转')
ok(rotateLogIfNeeded(join(root, 'missing.log')).reason === 'missing', '文件不存在应返回 missing')

/* 3) 计划裁剪：pending 全留；fired/missed 只留最近 7 天 */
const now = Date.parse('2026-11-10T00:00:00Z')
const day = 86400 * 1000
const plans = [
  { id: 'p-old', status: 'pending', at: new Date(now - 10 * day).toISOString() }, // pending 再旧也留
  { id: 'f-recent', status: 'fired', at: new Date(now - 1 * day).toISOString() },
  { id: 'f-old', status: 'fired', at: new Date(now - 30 * day).toISOString() },
  { id: 'm-old', status: 'missed', at: new Date(now - 8 * day).toISOString() },
]
const pruned = prunePlans(plans, now)
ok(pruned.removed === 2, `应删除 2 条（实际 ${pruned.removed}）`)
ok(pruned.plans.some((p) => p.id === 'p-old'), 'pending 必须保留')
ok(pruned.plans.some((p) => p.id === 'f-recent'), '最近 7 天的 fired 应保留')
ok(!pruned.plans.some((p) => p.id === 'f-old'), '30 天前的 fired 应删除')

/* 4) 总条数上限：超过 cap 时先丢最旧的非 pending，pending 不丢 */
const many = []
for (let i = 0; i < 40; i += 1) many.push({ id: `pend-${i}`, status: 'pending', at: new Date(now + i * 1000).toISOString() })
for (let i = 0; i < 40; i += 1) many.push({ id: `fired-${i}`, status: 'fired', at: new Date(now - i * 1000).toISOString() })
const capped = prunePlans(many, now, { cap: 60 })
ok(capped.plans.length === 60, `裁剪后应为 60 条（实际 ${capped.plans.length}）`)
ok(capped.plans.filter((p) => p.status === 'pending').length === 40, 'pending 应全部保留')

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
