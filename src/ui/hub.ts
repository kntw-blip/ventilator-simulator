import { createContext, useContext, useEffect, useRef } from 'react'
import type { Simulator } from '../engine/simulator'

/** シミュレータ本体と描画ループを共有するハブ */
export interface SimHub {
  sim: Simulator
  /** 毎フレーム呼ばれる描画関数を登録 */
  onFrame(fn: () => void): () => void
  /** 患者のリセット世代（キャンバスの再描画に使用） */
  generation: number
}

export const HubContext = createContext<SimHub | null>(null)

export function useHub(): SimHub {
  const h = useContext(HubContext)
  if (!h) throw new Error('HubContext missing')
  return h
}

export function useFrame(fn: () => void) {
  const hub = useHub()
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => hub.onFrame(() => ref.current()), [hub])
}

export function fmt(v: number | null | undefined, d = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '---'
  return v.toFixed(d)
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const sss = String(ss).padStart(2, '0')
  return d > 0 ? `${d}日 ${hh}:${mm}:${sss}` : `${hh}:${mm}:${sss}`
}
