/**
 * dsh-turn-cost —— Host 半边。
 *
 * 职责：把每个 (会话, 轮次) 的真实 usage 聚合成一条记录，并按官方峰谷价换算成人民币，
 * 通过一个只读 JSON 路由交给浏览器半边渲染。客户端不碰定价逻辑，也不自己算 token。
 *
 * 数据来源：`session/event` 事件流里的 `assistant/message`，其 data 形如
 *   { turn, usage: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }, message: { source: { model } } }
 * 与 dsh 内置口径一致：reasoningTokens ⊆ outputTokens，不单独累加（单独加会重复计费）。
 *
 * 价目（人民币 / 百万 token，[谷时, 峰时]）：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   Flash: 缓存命中 0.02/0.04，未命中输入 1/2，输出 4/8
 *   Pro  : Flash 的 3 倍
 * 峰时 = 北京时间周一至周五 09:00–12:00、14:00–18:00；周末与法定节假日全天谷价。
 */
export const name = 'dsh-turn-cost'

const PEAK_WINDOWS = [[9, 12], [14, 18]]
const FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }
const MAX_TURNS = 3000
const MAX_SEQ = 20000

function beijing(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000)
}

function isPeak(ms) {
  const bj = beijing(Number(ms) || Date.now())
  const dow = bj.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_WINDOWS) if (hour >= start && hour < end) return true
  return false
}

function priceFor(model) {
  return String(model || '').toLowerCase().includes('pro') ? PRO : FLASH
}

const turns = new Map()
const seqIndex = new Map()
let lastKey = null

function trimKeys(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value)
}

function record(sessionId, event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return
  const turn = Number(data.turn)
  const seq = Number(event.seq)
  if (Number.isFinite(turn) && Number.isFinite(seq)) {
    seqIndex.set(seq, { sid: sessionId, turn })
    trimKeys(seqIndex, MAX_SEQ)
  }
  if (event.type !== 'assistant/message') return
  const usage = data.usage
  if (!usage || typeof usage !== 'object' || !Number.isFinite(turn)) return
  const key = sessionId + '#' + turn
  let rec = turns.get(key)
  if (rec === undefined) {
    rec = { sid: sessionId, turn, input: 0, cache: 0, write: 0, output: 0, samples: 0, model: '', at: 0 }
    turns.set(key, rec)
    trimKeys(turns, MAX_TURNS)
  }
  rec.input += Number(usage.inputTokens) || 0
  rec.cache += Number(usage.cacheReadTokens) || 0
  rec.write += Number(usage.cacheWriteTokens) || 0
  rec.output += Number(usage.outputTokens) || 0
  rec.samples += 1
  rec.at = Date.now()
  const source = data.message && data.message.source
  const model = source && source.model
  if (typeof model === 'string' && model.length > 0) rec.model = model
  lastKey = key
}

function summarize(rec) {
  const tier = priceFor(rec.model)
  const off = isPeak(rec.at || Date.now()) ? 1 : 0
  // 缓存写入按未命中输入价计（dsh 里没有单独的缓存写入档）
  const cost = (rec.cache / 1e6) * tier.hit[off]
    + ((rec.input + rec.write) / 1e6) * tier.miss[off]
    + (rec.output / 1e6) * tier.out[off]
  const promptTokens = rec.input + rec.cache + rec.write
  return {
    ok: true,
    turn: rec.turn,
    model: rec.model,
    cost: Math.round(cost * 1e6) / 1e6,
    tokens: promptTokens + rec.output,
    input: rec.input,
    cache: rec.cache,
    cacheWrite: rec.write,
    output: rec.output,
    cachedPct: promptTokens > 0 ? Math.round((rec.cache / promptTokens) * 100) : 0,
    peak: off === 1,
    samples: rec.samples,
  }
}

function lookup(params) {
  const seq = Number(params.get('seq'))
  const turn = Number(params.get('turn'))
  // 首选 seq：seq 在会话内唯一，且能挡住「另一个会话恰好有同一个轮次号」的串账
  if (Number.isFinite(seq)) {
    const hit = seqIndex.get(seq)
    if (hit !== undefined && (!Number.isFinite(turn) || hit.turn === turn)) {
      const rec = turns.get(hit.sid + '#' + hit.turn)
      if (rec !== undefined && rec.samples > 0) return rec
    }
  }
  if (Number.isFinite(turn)) {
    if (lastKey !== null) {
      const recent = turns.get(lastKey)
      if (recent !== undefined && recent.turn === turn) return recent
    }
    let best = null
    for (const rec of turns.values()) {
      if (rec.turn !== turn) continue
      if (best === null || rec.at > best.at) best = rec
    }
    if (best !== null) return best
  }
  return null
}

function respond(res, body) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const sid = session && session.id !== undefined && session.id !== null ? String(session.id) : 'default'
        record(sid, event)
      } catch (error) {
        // 单条事件解析失败不能影响会话本身
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('[dsh-turn-cost] 无法订阅 session/event：' + String((error && error.message) || error))
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-turn-cost/turn.json',
      handler: (req, res) => {
        let body = { ok: false }
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const rec = lookup(url.searchParams)
          if (rec !== null) body = summarize(rec)
        } catch (error) {
          body = { ok: false, error: String((error && error.message) || error) }
        }
        respond(res, body)
      },
    }), 'dsh-turn-cost: 每轮用量路由')
  })
}
