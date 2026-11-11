/**
 * scripts/test-ai-follow.mjs —— 本地验证「跟风复读」逻辑（不依赖 DSH 运行时）
 * 用法：node scripts/test-ai-follow.mjs
 * 用假 ctx + 假 LLM 调 apply()，再通过注册的 /api/bili-duty/ai-test 路由跑样例。
 * v1.11.2 起跟风复读改为纯本地统计：本测试同时断言「不调用模型」。
 */
import { mkdirSync, rmSync } from 'node:fs'

const HOME = '/tmp/bili-duty-ai-test'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

let handler = null
let cleanup = null
let llmCalls = 0

// 假 LLM：任何调用都算失败——跟风复读不应走到这里
function mockLlm() {
  return {
    listProviders: () => [{ id: 'mock-provider', name: 'Mock' }],
    prepareCall: async () => {
      llmCalls += 1
      throw new Error('跟风复读不应调用模型')
    },
  }
}

function makeCtx() {
  const ctx = {
    webServer: {
      register: (opts) => { handler = opts.handler; return () => { handler = null } },
    },
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') cleanup = d
      return d
    },
    get: (name) => {
      if (name === 'dshHomePath') return () => HOME
      if (name === 'llm') return mockLlm()
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) }
      if (name === 'attachments') return null
      return null
    },
  }
  return ctx
}

function callRoute(body) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      url: '/api/bili-duty/ai-test',
      on: (ev, cb) => {
        if (ev === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
        return req
      },
    }
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (text) => { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

async function setup() {
  const { apply } = await import('../index.js?test=' + Math.random())
  handler = null
  cleanup = null
  llmCalls = 0
  apply(makeCtx())
  await new Promise((r) => setTimeout(r, 30))
  if (!handler) throw new Error('没注册到 /api/bili-duty 路由')
}

const run = (samples) => callRoute({ samples })
let checks = 0
function assert(cond, msg) { if (!cond) throw new Error(msg); checks++ }

async function pickDeterministic(samples, expect, label) {
  await setup()
  const out = await run(samples)
  console.log(`[${label}] → ${JSON.stringify(out.text)} | why: ${out.why} | 候选: ${out.local?.candidates?.length ?? 0}`)
  assert(out.source === 'local', `${label}: source 应为 local`)
  assert(out.text === expect, `${label}: 期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(out.text)}`)
  assert(llmCalls === 0, `${label}: 不应调用模型`)
  if (typeof cleanup === 'function') cleanup()
}

async function pickRandom(samples, expectSet, label, rounds = 60) {
  await setup()
  const seen = new Map()
  for (let i = 0; i < rounds; i++) {
    const out = await run(samples)
    assert(out.source === 'local', `${label}: source 应为 local`)
    assert(out.local?.candidates?.length === expectSet.size, `${label}: 候选数应为 ${expectSet.size}，实际 ${out.local?.candidates?.length}`)
    assert(expectSet.has(out.text), `${label}: 出现候选集外的结果 ${JSON.stringify(out.text)}`)
    assert(String(out.why).includes('随机选择'), `${label}: why 应说明随机选择，实际 ${out.why}`)
    seen.set(out.text, (seen.get(out.text) || 0) + 1)
  }
  console.log(`[${label}] ${rounds} 轮分布：`, [...seen.entries()].map(([t, n]) => `${t}×${n}`).join(' / '))
  assert(seen.size === expectSet.size, `${label}: 期望所有候选都出现过，实际 ${[...seen.keys()].join(',') || '无'}`)
  assert(llmCalls === 0, `${label}: 不应调用模型`)
  if (typeof cleanup === 'function') cleanup()
}

await pickDeterministic(['好好好', '好好好', '好好好', '好好好', '飞飞飞', '?', '来了', '主播好棒'], '好好好', '只有一个达到阈值 → 必选')
await pickDeterministic(['加群 123 抽奖', '加群 123 抽奖', '加群 123 抽奖', '好好好', '好好好', '好好好'], '好好好', '广告过滤后只剩一个候选')
await pickDeterministic(['主播今天状态不错', '这首歌好听', '来了', '晚上好', '哈哈哈哈'], '', '没有刷屏时不发')
await pickDeterministic(['好好好', '好好好'], '', '窗口内弹幕太少时不发')
await pickDeterministic(['好好好', '好好好', '飞飞飞', '飞飞飞', '来了', '晚上好'], '', '低于最少重复次数时不发')

const setA = new Set(['好好好', '飞飞飞', '666'])
await pickRandom(['好好好', '好好好', '好好好', '好好好', '好好好', '飞飞飞', '飞飞飞', '飞飞飞', '666', '666', '666', '来了'], setA, '多个合格候选 → 随机挑一句')
const setB = new Set(['好好好', '飞飞飞'])
await pickRandom(['飞飞飞', '飞飞飞', '飞飞飞', '好好好', '好好好', '好好好', '来了', '晚上好', '哈哈哈'], setB, '同频次候选 → 随机挑一句')

console.log(`\n=== 全部通过（${checks} 项断言，0 次模型调用） ===`)
process.exit(0)
