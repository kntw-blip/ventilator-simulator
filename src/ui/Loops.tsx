import { useRef, useState } from 'react'
import { BUF_LEN, CH, FS } from '../engine/simulator'
import { useFrame, useHub } from './hub'

type Pt = [number, number]

interface LoopProps {
  kind: 'pv' | 'fv'
  height: number
}

/** P-V ループ / F-V ループ（直前の1呼吸を表示、参照ループを保存可能） */
export function Loop({ kind, height }: LoopProps) {
  const hub = useHub()
  const ref = useRef<HTMLCanvasElement>(null)
  const [refLoop, setRefLoop] = useState<Pt[] | null>(null)
  const refLoopRef = useRef<Pt[] | null>(null)
  refLoopRef.current = refLoop
  const lastDraw = useRef(0)
  const lastPts = useRef<Pt[]>([])

  const collect = (): Pt[] => {
    const sim = hub.sim
    const lb = sim.lastBreath
    if (!lb) return []
    const n = Math.round((sim.t - lb.start) * FS)
    const m = Math.round(lb.dur * FS)
    if (n > BUF_LEN - 10 || n <= 0) return []
    const start = sim.bufCount - n
    const pts: Pt[] = []
    const step = Math.max(1, Math.floor(m / 300))
    for (let k = start; k < start + m && k < sim.bufCount; k += step) {
      const i = ((k % BUF_LEN) + BUF_LEN) % BUF_LEN
      const vol = sim.buf[CH.vol][i]
      if (kind === 'pv') pts.push([sim.buf[CH.paw][i], vol])
      else pts.push([vol, sim.buf[CH.flow][i]])
    }
    return pts
  }

  useFrame(() => {
    const c = ref.current
    if (!c) return
    const now = performance.now()
    if (now - lastDraw.current < 120) return
    lastDraw.current = now
    const dpr = window.devicePixelRatio || 1
    const W = Math.round(c.clientWidth * dpr)
    const H = Math.round(height * dpr)
    if (W === 0) return
    if (c.width !== W || c.height !== H) {
      c.width = W
      c.height = H
    }
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#0f1c25'
    ctx.fillRect(0, 0, W, H)
    const pts = collect()
    lastPts.current = pts
    const all = [...pts, ...(refLoopRef.current ?? [])]
    let xMax = 1
    let yMax = 1
    let yMin = 0
    let xMin = 0
    for (const [x, y] of all) {
      xMax = Math.max(xMax, x)
      xMin = Math.min(xMin, x)
      yMax = Math.max(yMax, y)
      yMin = Math.min(yMin, y)
    }
    const niceUp = (v: number, list: number[]) => list.find((s) => v <= s * 0.95) ?? list[list.length - 1]
    let xr: [number, number]
    let yr: [number, number]
    if (kind === 'pv') {
      xr = [Math.min(0, Math.floor(xMin / 5) * 5), niceUp(xMax, [20, 30, 40, 50, 60, 80])]
      yr = [Math.min(0, Math.floor(yMin / 100) * 100), niceUp(yMax, [300, 600, 900, 1200, 1500, 2000])]
    } else {
      xr = [Math.min(0, Math.floor(xMin / 100) * 100), niceUp(xMax, [300, 600, 900, 1200, 1500, 2000])]
      const fm = niceUp(Math.max(Math.abs(yMax), Math.abs(yMin)), [30, 60, 90, 120, 180])
      yr = [-fm, fm]
    }
    const pad = 22 * dpr
    const X = (v: number) => pad + ((v - xr[0]) / (xr[1] - xr[0])) * (W - pad - 6 * dpr)
    const Y = (v: number) => H - pad - ((v - yr[0]) / (yr[1] - yr[0])) * (H - pad - 18 * dpr)
    // 軸
    ctx.strokeStyle = '#2a4152'
    ctx.lineWidth = dpr
    ctx.beginPath()
    ctx.moveTo(X(xr[0]), Y(0))
    ctx.lineTo(X(xr[1]), Y(0))
    ctx.moveTo(X(0), Y(yr[0]))
    ctx.lineTo(X(0), Y(yr[1]))
    ctx.stroke()
    ctx.fillStyle = '#7b8f9c'
    ctx.font = `${10 * dpr}px 'Barlow Semi Condensed', sans-serif`
    ctx.textAlign = 'right'
    ctx.fillText(String(xr[1]), X(xr[1]), H - 6 * dpr)
    ctx.textAlign = 'left'
    ctx.fillText(String(yr[1]), 3 * dpr, Y(yr[1]) + 10 * dpr)
    if (yr[0] < 0) ctx.fillText(String(yr[0]), 3 * dpr, Y(yr[0]))

    const draw = (p: Pt[], color: string, dash: number[] = []) => {
      if (p.length < 2) return
      ctx.setLineDash(dash.map((d) => d * dpr))
      ctx.strokeStyle = color
      ctx.lineWidth = 1.8 * dpr
      ctx.beginPath()
      ctx.moveTo(X(p[0][0]), Y(p[0][1]))
      for (const [x, y] of p) ctx.lineTo(X(x), Y(y))
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (refLoopRef.current) draw(refLoopRef.current, '#8798a3', [4, 3])
    draw(pts, kind === 'pv' ? '#f2c14e' : '#4fd1a5')
  })

  return (
    <div className="loop" style={{ height }}>
      <canvas ref={ref} style={{ height }} aria-label={kind === 'pv' ? '圧-換気量ループ' : '流量-換気量ループ'} />
      <div className="loop-label">{kind === 'pv' ? '圧–換気量 (cmH2O / mL)' : '換気量–流量 (mL / L/分)'}</div>
      <div className="loop-tools">
        <button className="lcd-btn" onClick={() => setRefLoop(lastPts.current.slice())}>
          参照を保存
        </button>
        {refLoop && (
          <button className="lcd-btn" onClick={() => setRefLoop(null)}>
            消去
          </button>
        )}
      </div>
    </div>
  )
}
