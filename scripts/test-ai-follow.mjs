/**
 * scripts/test-ai-follow.mjs —— 本地验证「跟风复读」逻辑（不依赖 DSH 运行时）
 * 用法：node scripts/test-ai-follow.mjs
 * 用假 ctx + 假 LLM 调 apply()，再通过注册的 /api/bili-duty/ai-test 路由跑样例。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const HOME = '/tmp/bili-duty-ai-test'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

let handler = null
let cleanup = null

// 假 LLM：prepareCall 后流式吐一句话（模拟思考模型返回）
function mockLlm(streamText) {
  return {
    listProviders: () => [{ id: 'mock-provider', name: 'Mock' }],
    prepareCall: async () => ({
      config: { provider: 'mock-provider', model: 'mock-model' },
      stream: async function* stream() { yield { type: 'text-delta', text: streamText } },
    }),
  }
}

function makeCtx(streamText) {
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
      if (name === 'llm') return mockLlm(streamText)
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

const samples1 = ['好好好', '好好好', '好好好', '好好好', '好好好', '飞飞飞', '飞飞飞', '飞飞飞', '?', '?', '主播好棒', '666', '666']
const samples2 = ['好好好', '好好好', '好好好', '好好好', '好好好', '飞飞飞', '飞飞飞', '飞飞飞', '?', '?']
const samples3 = ['主播今天状态不错', '这首歌好听', '来了', '晚上好', '哈哈哈哈'] // 没有明显刷屏

async function runOnce(streamText, samples, label) {
  const { apply } = await import('../index.js?test=' + Math.random())
  handler = null
  cleanup = null
  apply(makeCtx(streamText))
  await new Promise((r) => setTimeout(r, 30))
  if (!handler) throw new Error('没注册到 /api/bili-duty 路由')
  const out = await callRoute({ samples })
  console.log(`\n[${label}] LLM 返回「${streamText}」，本地候选：`)
  console.log('  local.top =', JSON.stringify(out.local?.top))
  console.log('  → 选择:', JSON.stringify(out.text), '| why:', out.why, '| mode:', out.mode)
  if (typeof cleanup === 'function') cleanup()
  return out
}

const a = await runOnce('好好好', samples1, 'LLM 选对')
if (a.text !== '好好好') throw new Error('LLM 正确选择时应当返回 好好好')
const b = await runOnce('主播今天状态不错', samples2, 'LLM 乱填（应回落本地）')
if (b.text !== '好好好') throw new Error('LLM 返回不在候选里时应回落本地 top=好好好')
const c = await runOnce('NONE', samples3, '没有刷屏（应返回空）')
if (c.text !== '') throw new Error('没有明显刷屏时不应发送')
console.log('\n=== 全部通过 ===')
process.exit(0)
