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

const cases = [
  {
    label: '最高频胜出',
    samples: ['好好好', '好好好', '好好好', '好好好', '好好好', '飞飞飞', '飞飞飞', '飞飞飞', '?', '?', '主播好棒', '666', '666'],
    expect: '好好好',
  },
  {
    label: '同频次取最近出现的那句',
    samples: ['飞飞飞', '飞飞飞', '飞飞飞', '好好好', '好好好', '好好好'],
    expect: '好好好',
  },
  {
    label: '过滤广告/加群后按剩余统计',
    samples: ['加群 123 抽奖', '好好好', '好好好', '好好好', '飞飞飞'],
    expect: '好好好',
  },
  {
    label: '没有刷屏时不发',
    samples: ['主播今天状态不错', '这首歌好听', '来了', '晚上好', '哈哈哈哈'],
    expect: '',
  },
  {
    label: '窗口内弹幕太少时不发',
    samples: ['好好好', '好好好'],
    expect: '',
  },
  {
    label: '低于最少重复次数时不发',
    samples: ['好好好', '好好好', '飞飞飞', '飞飞飞', '来了', '晚上好'],
    expect: '',
  },
]

async function runOnce(samples, label) {
  const { apply } = await import('../index.js?test=' + Math.random())
  handler = null
  cleanup = null
  llmCalls = 0
  apply(makeCtx())
  await new Promise((r) => setTimeout(r, 30))
  if (!handler) throw new Error('没注册到 /api/bili-duty 路由')
  const out = await callRoute({ samples })
  console.log(`\n[${label}]`)
  console.log('  local.top =', JSON.stringify(out.local?.top))
  console.log('  → 选择:', JSON.stringify(out.text), '| why:', out.why, '| source:', out.source, '| llmCalls:', llmCalls)
  if (typeof cleanup === 'function') cleanup()
  if (llmCalls !== 0) throw new Error(`跟风复读不应调用模型，实际调用 ${llmCalls} 次`)
  return out
}

for (const c of cases) {
  const out = await runOnce(c.samples, c.label)
  if (out.text !== c.expect) throw new Error(`[${c.label}] 期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(out.text)}`)
  if (out.source !== 'local') throw new Error(`[${c.label}] source 应为 local，实际 ${out.source}`)
}
console.log('\n=== 全部通过（6 个用例，0 次模型调用） ===')
process.exit(0)
