/**
 * 冒烟测试：不启动 DSH，直接验证插件两个半边的行为。
 * 用法：node test/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, ok, extra) {
  if (ok) console.log('PASS ' + name)
  else { failures++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// ---------- 客户端半边 ----------
const React = {
  createElement: (...args) => ({ __element: true, args }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}
const loads = []
globalThis.window = { __ModuleLoader__: { load: (spec) => loads.push(spec) } }
new Function('window', readFileSync(join(ROOT, 'lib/client.js'), 'utf8'))(globalThis.window)
check('client 注册了 module loader', loads.length === 1)
check('client id 与包名一致', loads[0] && loads[0].id === 'dsh-turn-cost', loads[0] && loads[0].id)

const clientModule = loads[0].factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
check('client 导出 inject=[slots]', Array.isArray(clientModule.inject) && clientModule.inject[0] === 'slots')
check('client 导出 apply', typeof clientModule.apply === 'function')

const registered = []
clientModule.apply({
  slots: {
    inject: (name, fn) => registered.push({ name, made: fn() }),
    register: (options, component) => ({ options, component }),
  },
})
check('client 注入 turnTail 槽位', registered.length === 1 && registered[0].name === 'conversation.chat.turnTail')
check('client 注册项 id=turn-cost', registered[0] && registered[0].made.options.id === 'turn-cost')
check('client 组件是函数', typeof registered[0].made.component === 'function')

// ---------- 宿主半边 ----------
const hostModule = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
check('host 导出 name', hostModule.name === 'dsh-turn-cost')
check('host 导出 apply', typeof hostModule.apply === 'function')

let sessionHandler = null
let route = null
hostModule.apply({
  on: (event, fn) => { if (event === 'session/event') sessionHandler = fn },
  inject: (services, fn) => fn({
    webServer: { register: (registered) => { route = registered; return () => {} } },
    effect: (fn2) => fn2(),
  }),
  logger: { warn: () => {} },
})
check('host 订阅 session/event', typeof sessionHandler === 'function')
check('host 注册路由', route !== null && route.path === '/dsh-turn-cost/turn.json')

const session = { id: 'sess-1' }
const emit = (event) => sessionHandler(session, event)
// 一轮两步：第一步几乎没有缓存，第二步大量缓存命中
emit({ type: 'turn/start', seq: 10, data: { turn: 7 } })
emit({ type: 'assistant/message', seq: 11, data: { turn: 7, usage: { inputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 2000, outputTokens: 500 }, message: { source: { model: 'deepseek-flash' } } } })
emit({ type: 'assistant/message', seq: 12, data: { turn: 7, usage: { inputTokens: 300, cacheReadTokens: 180000, cacheWriteTokens: 0, outputTokens: 1200 }, message: { source: { model: 'deepseek-flash' } } } })
emit({ type: 'turn/end', seq: 13, data: { turn: 7 } })

function callRoute(query) {
  let body = null
  route.handler(
    { url: '/dsh-turn-cost/turn.json' + query },
    { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } },
  )
  return body
}

check('seq 命中该轮', callRoute('?turn=7&seq=13').ok === true)
check('turn 回退命中该轮', callRoute('?turn=7').ok === true)
check('其他轮次不返回数据', callRoute('?turn=999').ok === false)
check('缺参数不返回数据', callRoute('').ok === false)

const body = callRoute('?turn=7&seq=13')
const expectInput = 4300
const expectCache = 180000
const expectWrite = 2000
const expectOutput = 1700
check('token 分项聚合正确',
  body.input === expectInput && body.cache === expectCache && body.cacheWrite === expectWrite && body.output === expectOutput,
  JSON.stringify({ input: body.input, cache: body.cache, cacheWrite: body.cacheWrite, output: body.output }))
check('总 token 正确', body.tokens === expectInput + expectCache + expectWrite + expectOutput, String(body.tokens))
check('缓存命中率正确', body.cachedPct === Math.round(180000 / (expectInput + expectCache + expectWrite) * 100), String(body.cachedPct))

const bj = new Date(Date.now() + 8 * 3600 * 1000)
const dow = bj.getUTCDay()
const hour = bj.getUTCHours()
const peakNow = dow !== 0 && dow !== 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
check('峰谷判定与本地时钟一致', body.peak === peakNow, JSON.stringify({ peak: body.peak, peakNow }))

const rate = peakNow ? { hit: 0.04, miss: 2, out: 8 } : { hit: 0.02, miss: 1, out: 4 }
const expectedCost = (expectCache / 1e6) * rate.hit + ((expectInput + expectWrite) / 1e6) * rate.miss + (expectOutput / 1e6) * rate.out
check('计价与手算一致（误差<1e-6）', Math.abs(body.cost - expectedCost) < 1e-6, JSON.stringify({ got: body.cost, want: expectedCost }))

// 另一个会话有同样的轮次号，不能串账
sessionHandler({ id: 'sess-2' }, { type: 'assistant/message', seq: 500, data: { turn: 7, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, message: { source: { model: 'deepseek-v4-pro' } } } })
const pro = callRoute('?turn=7&seq=500')
check('另一会话按自己的 seq 命中', pro.ok === true && pro.model === 'deepseek-v4-pro', JSON.stringify(pro))
check('pro 档价按 3 倍', pro.cost > 0)

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
