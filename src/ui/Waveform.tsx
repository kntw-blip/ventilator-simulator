import { useEffect, useRef } from 'react'
import { BUF_LEN, FS } from '../engine/simulator'
import { useFrame, useHub } from './hub'

export type Range = { min: number; max: number }

interface Props {
  ch: number
  color: string
  label: string
  unit?: string
  height: number
  windowSec?: number
  /** 固定範囲（指定しなければ自動） */
  range?: Range
  /** 自動スケール候補（最大値）。symmetric なら ±max */
  scales?: number[]
  symmetric?: boolean
  minFloor?: number
  bg?: string
  grid?: string
  lineWidth?: number
  zeroLine?: boolean
  labelColor?: string
  showScale?: boolean
}

/**
 * 掃引式（スイープ）波形表示。実機と同様、描画位置が左から右へ進み、
 * 先行する部分を消去しながら新しい波形を書き込む。
 */
export function Waveform(p: Props) {
  const hub = useHub()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scaleTopRef = useRef<HTMLDivElement>(null)
  const scaleBotRef = useRef<HTMLDivElement>(null)
  const st = useRef({
    last: 0,
    w: 0,
    h: 0,
    dpr: 1,
    range: p.range ?? { min: p.symmetric ? -(p.scales?.[0] ?? 1) : (p.minFloor ?? 0), max: p.scales?.[0] ?? 1 },
    lastRescale: 0,
    gen: -1,
    needFull: true,
  })
  const win = p.windowSec ?? 8

  useEffect(() => {
    const c = canvasRef.current!
    const ro = new ResizeObserver(() => {
      st.current.needFull = true
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  const updateScaleLabels = () => {
    const r = st.current.range
    if (scaleTopRef.current) scaleTopRef.current.textContent = niceLabel(r.max)
    if (scaleBotRef.current) scaleBotRef.current.textContent = niceLabel(r.min)
  }

  useFrame(() => {
    const c = canvasRef.current
    if (!c) return
    const sim = hub.sim
    const s = st.current
    const dpr = window.devicePixelRatio || 1
    const cw = c.clientWidth
    if (cw === 0) return
    if (s.w !== Math.round(cw * dpr) || s.h !== Math.round(p.height * dpr) || s.gen !== hub.generation) {
      s.w = Math.round(cw * dpr)
      s.h = Math.round(p.height * dpr)
      s.dpr = dpr
      c.width = s.w
      c.height = s.h
      s.gen = hub.generation
      s.needFull = true
    }
    const ctx = c.getContext('2d')!
    const count = sim.bufCount
    const data = sim.buf[p.ch]
    // 自動スケール（2秒ごと）
    if (!p.range && p.scales && performance.now() - s.lastRescale > 2000) {
      s.lastRescale = performance.now()
      const n = Math.min(count, win * FS)
      let mx = -Infinity
      let mn = Infinity
      for (let k = count - n; k < count; k++) {
        const v = data[((k % BUF_LEN) + BUF_LEN) % BUF_LEN]
        if (v > mx) mx = v
        if (v < mn) mn = v
      }
      const need = p.symmetric ? Math.max(Math.abs(mx), Math.abs(mn)) : mx
      let pick = p.scales[p.scales.length - 1]
      for (const sc of p.scales) {
        if (need <= sc * 0.92) {
          pick = sc
          break
        }
      }
      const newMin = p.symmetric ? -pick : Math.min(p.minFloor ?? 0, mn < (p.minFloor ?? 0) ? Math.floor(mn / 5) * 5 : (p.minFloor ?? 0))
      if (pick !== s.range.max || newMin !== s.range.min) {
        s.range = { min: newMin, max: pick }
        s.needFull = true
      }
    } else if (p.range && (p.range.min !== s.range.min || p.range.max !== s.range.max)) {
      s.range = { ...p.range }
      s.needFull = true
    }

    const W = s.w
    const H = s.h
    const r = s.range
    const pad = 4 * dpr
    const yOf = (v: number) => {
      const y = H - pad - ((v - r.min) / (r.max - r.min)) * (H - 2 * pad)
      return y < 0 ? 0 : y > H ? H : y
    }
    const xOf = (k: number) => (((k / FS) % win) / win) * W
    const bg = p.bg ?? '#0f1c25'
    const drawGrid = (x0: number, x1: number) => {
      if (p.zeroLine !== false && r.min < 0 && r.max > 0) {
        ctx.strokeStyle = p.grid ?? '#2a4152'
        ctx.lineWidth = 1 * dpr
        ctx.beginPath()
        const y0 = Math.round(yOf(0)) + 0.5
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y0)
        ctx.stroke()
      }
    }
    if (s.needFull) {
      s.needFull = false
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)
      drawGrid(0, W)
      s.last = Math.max(0, count - Math.floor(win * FS) + 1)
      updateScaleLabels()
    }
    if (count - s.last > BUF_LEN - 10) s.last = count - Math.floor(win * FS)
    if (count <= s.last) return

    // 先行消去
    const gap = 14 * dpr
    const xEnd = xOf(count - 1)
    const xStart = xOf(s.last)
    ctx.fillStyle = bg
    if (xEnd >= xStart) {
      ctx.fillRect(xStart, 0, xEnd - xStart + gap, H)
      drawGrid(xStart, xEnd + gap)
    } else {
      ctx.fillRect(xStart, 0, W - xStart, H)
      ctx.fillRect(0, 0, xEnd + gap, H)
      drawGrid(xStart, W)
      drawGrid(0, xEnd + gap)
    }
    ctx.strokeStyle = p.color
    ctx.lineWidth = (p.lineWidth ?? 1.6) * dpr
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const from = Math.max(s.last - 1, 0)
    const step = Math.max(1, Math.floor((win * FS) / W / 1.5))
    let prevX = -1
    for (let k = from; k < count; k += step) {
      const v = data[k % BUF_LEN]
      const x = xOf(k)
      const y = yOf(v)
      if (prevX < 0 || x < prevX) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      prevX = x
    }
    // 最後のサンプルまで確実に描く
    const kLast = count - 1
    const xl = xOf(kLast)
    if (xl >= prevX) ctx.lineTo(xl, yOf(data[kLast % BUF_LEN]))
    ctx.stroke()
    s.last = count
  })

  return (
    <div className="wave" style={{ height: p.height }}>
      <canvas ref={canvasRef} style={{ height: p.height }} aria-label={`${p.label}の波形`} />
      <div className="wave-label" style={{ color: p.labelColor ?? p.color }}>
        {p.label}
        {p.unit ? <span style={{ opacity: 0.7 }}> {p.unit}</span> : null}
      </div>
      {p.showScale !== false && (
        <>
          <div className="wave-scale" style={{ top: 2 }} ref={scaleTopRef} />
          <div className="wave-scale" style={{ bottom: 2 }} ref={scaleBotRef} />
        </>
      )}
    </div>
  )
}

function niceLabel(v: number): string {
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')
}
