/**
 * dsh-turn-cost —— Client 半边。
 *
 * 在每条回复下方的 `conversation.chat.turnTail` 槽位渲染一行：
 *   ¥0.032 · 82.4k tok · 峰
 * 悬停看明细（输入 / 缓存命中率 / 输出 / 峰谷 / 模型）。
 *
 * 数据全部来自宿主路由 /dsh-turn-cost/turn.json，不在浏览器里重复算价。
 * 槽位 props 只有 { turn, seq, openFile }，所以按 turn + seq 回查。
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LINE = {
      margin: '2px 0 0',
      padding: 0,
      fontSize: '11px',
      lineHeight: '16px',
      letterSpacing: '0.2px',
      opacity: 0.45,
      userSelect: 'none',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      cursor: 'default',
    }

    function money(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '¥0'
      if (n >= 1) return '¥' + n.toFixed(2)
      if (n >= 0.01) return '¥' + n.toFixed(3)
      return '¥' + n.toFixed(4)
    }

    function compact(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k'
      return (n / 1e6).toFixed(2) + 'M'
    }

    function TurnCostLine(props) {
      const turn = props ? props.turn : undefined
      const seq = props ? props.seq : undefined
      const [state, setState] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const query = '/dsh-turn-cost/turn.json?turn=' + encodeURIComponent(String(turn))
          + (Number.isFinite(Number(seq)) ? '&seq=' + encodeURIComponent(String(seq)) : '')
        const load = () => {
          fetch(query, { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then((json) => { if (alive && json !== null) setState(json) })
            .catch(() => {})
        }
        load()
        // 一轮的 usage 会在最后一步之后才齐全，补一次即可
        const timer = setTimeout(load, 1500)
        return () => { alive = false; clearTimeout(timer) }
      }, [turn, seq])

      if (state === null || state.ok !== true) return null

      const detail = [
        '本轮 ' + compact(state.tokens) + ' tok',
        '输入 ' + compact(state.input),
        '缓存命中 ' + compact(state.cache) + '（' + String(state.cachedPct) + '%）',
        '输出 ' + compact(state.output),
        state.peak ? '峰时价' : '谷时价',
        state.model ? String(state.model) : '',
      ].filter((part) => part !== '').join(' · ')

      return h(
        'div',
        { style: LINE, title: detail, 'data-dsh-turn-cost': String(turn) },
        money(state.cost),
        ' · ',
        compact(state.tokens) + ' tok',
        ' · ',
        state.peak ? '峰' : '谷',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'turn-cost',
          order: 40,
        }, TurnCostLine))
      },
    }
  },
})
