// ============================================================
// 型定義
// 単位: 圧 cmH2O, 流量 L/s（内部）, 容量 L（内部）, 時間 s
// 表示時に mL, L/min に変換する
// ============================================================

export type VentMode =
  | 'VC-AC'
  | 'PC-AC'
  | 'PRVC'
  | 'SIMV-VC'
  | 'SIMV-PC'
  | 'PSV'
  | 'APRV'
  | 'TPIECE'
  | 'NPPV-ST'
  | 'NPPV-CPAP'
  | 'HFNC'
  | 'O2'

export type O2Device = 'none' | 'cannula' | 'mask' | 'reservoir'

export interface VentSettings {
  mode: VentMode
  fio2: number // 0.21-1.0
  peep: number // cmH2O
  vt: number // mL (VC, PRVC)
  rr: number // 回/分（強制換気回数）
  peakFlow: number // L/min（VC）
  flowPattern: 'square' | 'decel'
  pause: number // s（VC 吸気ポーズ）
  pinsp: number // cmH2O（PEEP上の吸気圧, PC）
  ti: number // s（PC/PRVC 吸気時間）
  rise: number // s（立ち上がり時間）
  ps: number // cmH2O（PEEP上のPS）
  ets: number // %（呼気トリガー感度）
  trigType: 'flow' | 'pressure'
  trigFlow: number // L/min
  trigPressure: number // cmH2O
  pmaxPrvc: number // cmH2O PRVC 上限圧（総圧）
  // APRV
  pHigh: number
  pLow: number
  tHigh: number
  tLow: number
  // NPPV
  ipap: number
  epap: number
  nppvRR: number
  nppvTi: number
  nppvTiMax: number
  maskFit: 0 | 1 | 2 // 0:良好 1:中等度リーク 2:大量リーク
  // HFNC
  hfncFlow: number // L/min
  // 酸素療法
  o2Device: O2Device
  o2Flow: number // L/min
}

export interface AlarmSettings {
  pHigh: number
  pLow: number
  mvHigh: number // L/min
  mvLow: number
  vtLow: number // mL
  vtHigh: number
  rrHigh: number
  apnea: number // s
  spo2Low: number
  hrHigh: number
  hrLow: number
  sbpLow: number
  sbpHigh: number
  etco2High: number
  etco2Low: number
}

export type DiseaseId =
  | 'normal'
  | 'ards'
  | 'copd'
  | 'asthma'
  | 'pneumonia'
  | 'obesity'
  | 'neuromuscular'
  | 'postop'

export type Severity = 'mild' | 'moderate' | 'severe'
export type Sex = 'male' | 'female'
export type VolumeStatus = 'low' | 'normal' | 'high'

/** 病態で変化する患者パラメータ（数値のみ。補間対象） */
export interface PatientParams {
  cOpen: number // mL/cmH2O 完全リクルート時の呼吸器系コンプライアンス
  cClosed: number // mL/cmH2O 虚脱時
  frcOpen: number // L 含気EELV（ZEEP）完全リクルート時
  frcClosed: number
  rInsp: number // cmH2O/L/s 気管チューブ込み
  rExp: number
  rEtt: number // 気管チューブ分
  pcrit: number // 呼気流量制限の臨界圧（COPD）
  pover: number // 過膨張開始の肺胞圧
  kover: number
  cwFrac: number // 胸壁エラスタンス比 Ecw/Ers
  ppl0: number // 基準胸腔内圧
  shuntFixed: number
  shuntRec: number // リクルート可能なシャント
  popen: number // 50%開放圧
  pclose: number // 50%閉塞圧
  rw: number // 開放/閉塞のばらつき幅
  lowVQ: number // 低V/Q領域への血流比
  vq: number // 低V/Q領域の相対V/Q比
  vdAnatPerKg: number // mL/kg IBW
  vdAlv: number // 肺胞死腔率
  vco2: number // mL/min（70kg換算）
  vo2: number
  hb: number
  hco3: number
  paco2Set: number // 化学調節の設定点
  temp: number
  driveBase: number // D=1 のときの Pmus 振幅
  fBase: number // 自発呼吸数
  tiRatio: number
  pmax: number // 最大吸気筋力（MIP）
  secretion: number // 分泌物産生 0-1
  cough: number // 咳嗽力 0-1
  cuffLeak: number // mL
  edemaRisk: number // 喉頭浮腫リスク 0-1
  hr0: number
  map0: number
  co0: number
  pmsf0: number // mmHg
  lactateBase: number
  pain: number // 0-1
}

export interface DiseasePreset {
  id: DiseaseId
  name: string
  description: string
  defaultWeight?: number
  recoveryTau: number // h（病態改善の時定数）
  acute: Partial<PatientParams>
  recovered: Partial<PatientParams>
}

export interface PatientConfig {
  disease: DiseaseId
  severity: Severity
  sex: Sex
  height: number // cm
  weight: number // kg
  volumeStatus: VolumeStatus
}

export type EventId =
  | 'pneumothorax'
  | 'mucusPlug'
  | 'ettObstruction'
  | 'bronchospasm'
  | 'mainstem'
  | 'cuffLeak'
  | 'disconnect'
  | 'selfExtubation'
  | 'agitation'
  | 'hypovolemia'

export type InterventionId =
  | 'suction'
  | 'chestDrain'
  | 'reconnect'
  | 'cuffAdjust'
  | 'tubeReposition'
  | 'bronchodilator'
  | 'fluid'
  | 'sedate'
  | 'tubeExchange'
  | 'recruit'
  | 'prone'
  | 'supine'

export type AsyncType =
  | 'ineffective'
  | 'double'
  | 'autoTrigger'
  | 'delayedCycle'
  | 'prematureCycle'
  | 'flowStarvation'

export interface AsyncRecord {
  t: number
  type: AsyncType
}

export interface AlarmState {
  id: string
  label: string
  priority: 'high' | 'medium'
  since: number
}

export interface AbgResult {
  t: number
  ph: number
  paco2: number
  pao2: number
  hco3: number
  be: number
  sao2: number
  lactate: number
  hb: number
  fio2: number
  pf: number
  aado2: number
}

export interface TrendPoint {
  t: number
  spo2: number
  hr: number
  map: number
  sbp: number
  etco2: number
  paco2: number
  pao2: number
  rr: number
  vt: number
  mv: number
  ppeak: number
  fio2: number
  peep: number
}

export type SbtMethod = 'psv' | 'cpap' | 'tpiece'

export interface SbtState {
  active: boolean
  method: SbtMethod
  start: number
  duration: number // s
  baseline: { hr: number; sbp: number; spo2: number; rr: number; paco2: number }
  rsbi: number | null
  rsbiMeasuredAt: number | null
  failReasons: string[]
  result: 'running' | 'pass' | 'fail' | 'aborted' | null
  savedSettings: VentSettings | null
  endedAt: number | null
}

export interface LogEntry {
  t: number
  kind: 'event' | 'action' | 'alarm' | 'info'
  text: string
}
