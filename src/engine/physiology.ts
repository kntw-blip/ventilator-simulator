// ガス交換に関する生理学関数

export const PATM = 760
export const PH2O = 47

/** Severinghaus の式（pH・体温・BE補正付き）PO2 [mmHg] → SO2 [0-1] */
export function satFromPo2(po2: number, ph = 7.4, temp = 37, be = 0): number {
  if (po2 <= 0) return 0
  const pv = po2 * Math.pow(10, 0.48 * (ph - 7.4) - 0.024 * (temp - 37) + 0.0013 * be)
  return 1 / (23400 / (pv * pv * pv + 150 * pv) + 1)
}

/** 酸素含量 mL/dL */
export function o2Content(po2: number, hb: number, ph: number, temp: number, be: number): number {
  return 1.34 * hb * satFromPo2(po2, ph, temp, be) + 0.0031 * po2
}

/** 含量から PO2 を逆算（二分法） */
export function po2FromContent(c: number, hb: number, ph: number, temp: number, be: number): number {
  let lo = 0
  let hi = 800
  if (c <= 0) return 0
  if (o2Content(hi, hb, ph, temp, be) < c) {
    // 溶存酸素で補う
    return hi + (c - o2Content(hi, hb, ph, temp, be)) / 0.0031
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (o2Content(mid, hb, ph, temp, be) < c) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Henderson–Hasselbalch */
export function phFrom(hco3: number, paco2: number): number {
  return 6.1 + Math.log10(Math.max(1, hco3) / (0.0307 * Math.max(5, paco2)))
}

/** Base Excess（Van Slyke 簡易式） */
export function baseExcess(hco3: number, ph: number): number {
  return 0.93 * (hco3 - 24.4 + 14.8 * (ph - 7.4))
}

/** 吸入酸素分圧 */
export function pio2(fio2: number): number {
  return fio2 * (PATM - PH2O)
}

export interface OxygenationInput {
  pao2Alv: number // 正常V/Q領域の肺胞気酸素分圧
  fio2: number
  shunt: number
  lowVQ: number
  vq: number
  hb: number
  ph: number
  temp: number
  be: number
  vo2: number // mL/min
  co: number // L/min
}

export interface OxygenationResult {
  pao2: number
  sao2: number
  cao2: number
  cvo2: number
  pvo2: number
  svo2: number
}

/**
 * 3コンパートメント（正常・低V/Q・シャント）モデルで動脈血酸素化を計算
 * 混合静脈血は Fick の式（CvO2 = CaO2 − VO2/CO）で決まる
 */
export function oxygenation(inp: OxygenationInput): OxygenationResult {
  const { pao2Alv, fio2, shunt, lowVQ, vq, hb, ph, temp, be, vo2 } = inp
  const co = Math.max(0.3, inp.co)
  const pi = pio2(fio2)
  const ccNorm = o2Content(pao2Alv, hb, ph, temp, be)
  const extraction = vo2 / (co * 10) // mL/dL
  let ca = ccNorm - extraction * 0.3
  let cv = ca - extraction
  let pvo2 = 40
  const normFrac = Math.max(0, 1 - shunt - lowVQ)
  for (let i = 0; i < 30; i++) {
    cv = Math.max(0.5, ca - extraction)
    pvo2 = po2FromContent(cv, hb, ph, temp, be)
    // 低V/Q領域: FiO2を上げると改善する
    const pLow = Math.max(pvo2, pi - (pi - pao2Alv) / Math.max(0.05, vq))
    const ccLow = o2Content(pLow, hb, ph, temp, be)
    const caNew = normFrac * ccNorm + lowVQ * ccLow + shunt * cv
    if (Math.abs(caNew - ca) < 1e-4) {
      ca = caNew
      break
    }
    ca = ca + 0.7 * (caNew - ca)
  }
  cv = Math.max(0.5, ca - extraction)
  pvo2 = po2FromContent(cv, hb, ph, temp, be)
  const pao2 = po2FromContent(ca, hb, ph, temp, be)
  return {
    pao2,
    sao2: satFromPo2(pao2, ph, temp, be),
    cao2: ca,
    cvo2: cv,
    pvo2,
    svo2: satFromPo2(pvo2, ph, temp, be),
  }
}
