/**
 * scripts/test-client-register.mjs —— 浏览器半端注册冒烟测试
 * 用假的 window/document/React/slots 执行 client.js，验证：
 *   1) 插件声明 inject:['slots']；
 *   2) 注册了 main（key=bili-duty）和 sidebar.panellist（id=bili-duty, 小电视图标）；
 *   3) 不再注册 settings.section；
 *   4) 图标组件能渲染出 svg。
 * 用法：node scripts/test-client-register.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let definition = null
const styleEl = { attrs: {}, textContent: '' }
const documentStub = {
  querySelector: () => null,
  createElement: () => styleEl,
  head: { appendChild: () => {} },
}
const windowStub = { __ModuleLoader__: { load: (def) => { definition = def } } }

const mkEl = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length ? children : undefined } })
const ReactStub = {
  createElement: mkEl,
  Component: class { constructor(props) { this.props = props; this.state = {} } },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

const context = vm.createContext({ window: windowStub, document: documentStub, console })
vm.runInContext(source, context, { filename: 'client.js' })

if (!definition || definition.id !== 'dsh-bili-duty') throw new Error('ModuleLoader 注册失败')
const plugin = definition.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
})
if (!plugin || !plugin.apply || !plugin.inject.includes('slots')) throw new Error('插件没有注入 slots')

const injected = []
const registered = []
const slots = {
  inject(name, cb) { injected.push(name); cb() },
  register(opts, comp) { registered.push({ opts, comp }); return () => {} },
}
plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

const byName = (n) => registered.find((r) => r.opts && r.opts.name === n)
const fails = []
const ok = (cond, msg) => { if (!cond) fails.push(msg) }

ok(byName('main'), '缺少 main 注册')
ok(byName('main')?.opts?.key === 'bili-duty', 'main.key 应为 bili-duty')
ok(byName('sidebar.panellist'), '缺少 sidebar.panellist 注册')
ok(byName('sidebar.panellist')?.opts?.id === 'bili-duty', 'sidebar.panellist.id 应为 bili-duty')
ok(byName('sidebar.panellist')?.opts?.label === '直播值守', 'sidebar.panellist label 应为 直播值守')
ok(byName('sidebar.panellist')?.opts?.order === 20, 'sidebar.panellist order 应为 20')
ok(!byName('settings.section'), '不应再注册 settings.section')
ok(typeof byName('sidebar.panellist')?.comp === 'function', '图标组件缺失')

const icon = byName('sidebar.panellist')?.comp({ size: 18, active: true })
ok(icon && icon.type === 'svg', '图标应渲染 svg')
ok(icon?.props?.width === 18 && icon?.props?.height === 18, '图标尺寸应跟随 size')

const page = byName('main')?.comp
ok(typeof page === 'function', '主界面组件缺失')
const pageEl = page({})
ok(pageEl?.props?.['data-bd-main'] !== undefined, '主界面容器应带 data-bd-main')

if (fails.length) {
  console.error('FAIL:\n- ' + fails.join('\n- '))
  process.exit(1)
}
console.log('PASS: client 注册冒烟测试通过')
console.log('  注入槽:', injected.join(', '))
console.log('  注册项:', registered.map((r) => r.opts.name + (r.opts.key ? '(key=' + r.opts.key + ')' : r.opts.id ? '(id=' + r.opts.id + ')' : '')).join(', '))
