// ============================================================
// 人工呼吸器シミュレータ 生理学エンジン
//  - 単一コンパートメント呼吸器系（非線形コンプライアンス・リクルートメント・呼気流量制限）
//  - 神経性吸気努力（Pmus）と化学調節・鎮静・疲労
//  - 換気モードの状態機械（トリガー・サイクル・非同調の検出）
//  - 3コンパートメントのガス交換とCO2貯蔵
//  - 静脈還流モデルによる循環（PEEP・胸腔内圧・循環血液量）
// ============================================================

import { computeParams, clamp, idealBodyWeight, DISEASES } from './patients'
import { oxygenation, phFrom, baseExcess, pio2, o2Content, po2FromContent, satFromPo2 } from './physiology'
import { DEFAULT_ALARMS, initialAlarmsFor } from './defaults'
import type {
  AbgResult,
  AlarmSettings,
  AlarmState,
  AsyncRecord,
  AsyncType,
  EventId,
  InterventionId,
  LogEntry,
  PatientConfig,
  PatientParams,
  SbtMethod,
  SbtState,
  TrendPoint,
  VentMode,
  VentSettings,
} from './types'

export const DT = 0.005
export const FS = 200
export const BUF_SECONDS = 40
export const BUF_LEN = FS * BUF_SECONDS

export const CH = {
  paw: 0,
  flow: 1,
  vol: 2,
  pes: 3,
  capno: 4,
  ecg: 5,
  pleth: 6,
  abp: 7,
  pmus: 8,
  palv: 9,
} as const
const NCH = 10

const sig = (x: number) => 1 / (1 + Math.exp(-x))
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

type BreathKind = 'VC' | 'PC' | 'PS' | 'APRV'

export interface VentBreath {
  start: number
  kind: BreathKind
  trig: 'patient' | 'time'
  mandatory: boolean
  ti: number
  dur: number
  vti: number // mL
  vte: number // mL
  ppeak: number
  pawInt: number
  peepEnd: number
  pelMax: number
  leakAvg: number // L/min
  backup: boolean
}

export const EVENT_INFO: Record<EventId, { name: string; description: string; fix: string }> = {
  pneumothorax: {
    name: '緊張性気胸',
    description: '胸腔内に空気が貯留し、患側肺の虚脱と静脈還流の障害が起こります。',
    fix: '胸腔ドレナージ',
  },
  mucusPlug: {
    name: '痰による気道閉塞',
    description: '分泌物が気管支を閉塞し、気道抵抗の上昇とシャントの増加が起こります。',
    fix: '気管吸引',
  },
  ettObstruction: {
    name: '気管チューブ閉塞（屈曲・痰）',
    description: '気管チューブ内腔の高度な狭窄で、気道抵抗が著しく上昇します。',
    fix: '吸引／チューブ入れ替え',
  },
  bronchospasm: {
    name: '気管支攣縮',
    description: '気道平滑筋の収縮により吸気・呼気の抵抗が上昇し、auto-PEEPが生じます。',
    fix: '気管支拡張薬',
  },
  mainstem: {
    name: '片肺挿管（右主気管支）',
    description: 'チューブが深く入り、左肺が換気されなくなります。',
    fix: 'チューブ位置の調整',
  },
  cuffLeak: {
    name: 'カフリーク',
    description: 'カフ圧の低下により吸気ガスが口側に漏れます。呼気換気量が吸気換気量より少なくなり、オートトリガーの原因にもなります。',
    fix: 'カフ圧調整',
  },
  disconnect: {
    name: '回路外れ',
    description: '呼吸器回路が気管チューブから外れています。患者には換気も酸素も届きません。',
    fix: '回路の再接続',
  },
  selfExtubation: {
    name: '計画外抜管',
    description: '気管チューブが抜けてしまいました。患者は室内気で自発呼吸のみの状態です。',
    fix: '再挿管（または非侵襲的サポート）',
  },
  agitation: {
    name: '不穏（鎮静不足）',
    description: '鎮静が浅くなり、呼吸ドライブ・酸素消費・心拍数が増加します。',
    fix: '鎮静薬の追加',
  },
  hypovolemia: {
    name: '循環血液量減少（出血）',
    description: '出血などで平均体循環充満圧が低下し、陽圧換気による血圧低下が顕著になります。',
    fix: '輸液',
  },
}

export const INTERVENTION_INFO: Record<InterventionId, string> = {
  suction: '気管吸引',
  chestDrain: '胸腔ドレナージ',
  reconnect: '回路の再接続',
  cuffAdjust: 'カフ圧調整',
  tubeReposition: 'チューブ位置の調整',
  bronchodilator: '気管支拡張薬（β2刺激薬吸入）',
  fluid: '輸液ボーラス 500mL',
  sedate: '鎮静薬ボーラス',
  tubeExchange: '気管チューブ入れ替え',
  recruit: 'リクルートメント手技（40cmH2O×30秒）',
  prone: '腹臥位',
  supine: '仰臥位に戻す',
}

const SED_TABLE = [0, 0.3, 0.55, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.7] // RASS -5..+4

function sedFactor(rass: number): number {
  const x = clamp(rass + 5, 0, 9)
  const i = Math.floor(x)
  const f = x - i
  if (i >= 9) return SED_TABLE[9]
  return SED_TABLE[i] * (1 - f) + SED_TABLE[i + 1] * f
}

export function isVentMode(m: VentMode): boolean {
  return m !== 'TPIECE' && m !== 'HFNC' && m !== 'O2'
}
export function isNppv(m: VentMode): boolean {
  return m === 'NPPV-ST' || m === 'NPPV-CPAP'
}
export function isInvasiveMode(m: VentMode): boolean {
  return !isNppv(m) && m !== 'HFNC' && m !== 'O2'
}

export interface Snapshot {
  t: number
  elapsed: number
  mode: VentMode
  airway: 'intubated' | 'extubated'
  connected: boolean
  vent: {
    ppeak: number
    pmean: number
    peepSet: number
    peepMeasured: number
    vti: number
    vte: number
    mve: number
    rrTot: number
    rrSpont: number
    ti: number
    ie: string
    leak: number
    vtPerKg: number
    pplat: number | null
    pplatAge: number | null
    crs: number | null
    raw: number | null
    drivingP: number | null
    peepTot: number | null
    peepTotAge: number | null
    autoPeep: number | null
    tau: number | null
    backup: boolean
    phase: string
    prvcP: number | null
    endExpFlow: number
  }
  vitals: {
    hr: number
    sbp: number
    dbp: number
    map: number
    spo2: number
    etco2: number
    rr: number
    temp: number
    cvp: number
    ppv: number
    arrest: boolean
  }
  gas: {
    pao2: number
    paco2: number
    ph: number
    hco3: number
    be: number
    sao2: number
    lactate: number
    pf: number
    aado2: number
    vdvt: number
    shunt: number
    fio2Eff: number
    va: number
    svo2: number
    co: number
    do2: number
  }
  patient: {
    rass: number
    rassTarget: number
    drive: number
    pmusPeak: number
    p01: number
    fatigue: number
    pmaxEff: number
    progress: number
    recruit: number
    secretion: number
    diaphragm: number
    ptp: number
    rsbi: number | null
    vtSpont: number
    rrPatient: number
    ptiPct: number
    edema: number
    prone: boolean
    na: number
    fluid: number
  }
  async: { index: number; counts: Record<AsyncType, number>; recent: AsyncRecord[] }
  alarms: AlarmState[]
  muted: boolean
  events: EventId[]
  sbt: SbtState | null
  ibw: number
  recruiting: boolean
}

export class Simulator {
  cfg: PatientConfig
  settings: VentSettings
  alarmSettings: AlarmSettings = { ...DEFAULT_ALARMS }
  ibw = 66
  progress = 1
  baseP: PatientParams
  ep: PatientParams
  diseaseTau = 24

  t = 0
  t0 = 0
  settling = false

  buf: Float32Array[] = []
  bufCount = 0

  airway: 'intubated' | 'extubated' = 'intubated'
  lastInvasive: VentSettings | null = null
  events = new Map<EventId, number>()
  fluidBoost = 0
  na = 0
  prone = false
  bdUntil = -1
  recruitUntil = -1
  rass = -3
  rassTarget = -3
  sLoad = 0.15
  edemaOnset: number | null = null
  edemaLevel = 0
  extubatedAt: number | null = null
  cuffLeakTested: number | null = null
  coughAssessed: { cough: string; secretion: string } | null = null
  randomEvents = false

  // ---- メカニクス
  V = 0
  r = 0.5
  pmus = 0
  pel = 0
  palv = 0
  paw = 0
  flow = 0
  measFlow = 0
  measPaw = 0
  leak = 0
  kLeakEst = 0
  ppl = 0
  volDisp = 0
  vEndExp = 0

  // ---- 神経性吸気努力
  n = {
    phase: 'idle' as 'insp' | 'exp' | 'idle',
    t: 0,
    ti: 1,
    ttot: 4,
    p: 0,
    pExp: 0,
    id: 0,
    triggers: 0,
    ventInspTime: 0,
    inspEnd: -10,
    pmusMaxVent: 0,
    startedInExp: true,
  }
  drive = 1
  fatigue = 0
  dStr = 1
  ptiEma = 0.05
  pmusPeakLast = 0
  effortTimes: number[] = []

  // ---- 人工呼吸器
  vphase: 'exp' | 'insp' | 'pause' | 'holdI' | 'holdE' | 'recruit' = 'exp'
  kind: BreathKind = 'VC'
  mandatory = true
  trig: 'patient' | 'time' = 'time'
  tPhase = 0
  breathStart = 0
  inspDur = 1
  vcTi = 1
  vcPeak = 0.8
  vcQEnd = 0
  psPeak = 0
  psDelta = 10
  psTiMax = 2.5
  pcDelta = 15
  pcBase = 5
  pendingTrig = -1
  pendingMand = false
  holdIReq = false
  holdEReq = false
  holdTrig: 'patient' | 'time' = 'time'
  pauseDur = 0
  simvCycleStart = 0
  simvSatisfied = false
  backup = false
  backupSpont = 0
  prvcP = 15
  aprvHigh = true
  aprvT = 0
  acc = { vti: 0, vte: 0, ppeak: 0, pawInt: 0, pelMax: 0, leakInt: 0, patVol: 0 }
  breaths: VentBreath[] = []
  lastBreath: VentBreath | null = null
  pplatMeasured: { v: number; t: number; crs: number | null; raw: number | null; dp: number; effort: boolean } | null = null
  peepTotMeasured: { v: number; t: number; effort: boolean } | null = null
  holdEffort = 0
  highPFlagT = -100
  endExpFlow = 0

  // ---- 患者側の呼吸検出
  pState: 'in' | 'out' = 'out'
  pVin = 0
  pVout = 0
  pStart = 0
  pInspT = 0
  patBreaths: { t: number; vt: number; ti: number }[] = []
  hfncO2 = 0
  hfncTot = 0

  // ---- カプノ
  capno = 0
  exVol = 0
  petco2 = 38
  etco2Disp = 38
  lastVtPatient = 0.45

  // ---- ガス交換
  paco2 = 40
  pAO2 = 100
  pao2 = 95
  pao2Target = 95
  sao2 = 0.97
  spo2 = 97
  ph = 7.4
  hco3 = 24
  be = 0
  lactate = 1
  pvo2 = 40
  svo2 = 0.75
  cao2 = 19
  fio2Eff = 0.5
  va = 4.5
  shunt = 0.05
  vdvt = 0.3
  vdAlvEff = 0.1

  // ---- 循環
  hr = 80
  map = 85
  sbp = 120
  dbp = 65
  co = 5
  sv = 64
  sv0 = 64
  svr0 = 1300
  rap = 6
  pplMean = 6
  palvMean = 8
  pmsf = 12
  cardPhase = 0
  beatT = 0
  beatRR = 0.75
  beatSbp = 120
  beatDbp = 65
  ppList: { t: number; pp: number }[] = []
  hypoxTime = 0
  arrest = false

  // ---- アラーム・記録
  alarmCond = new Map<string, number>()
  activeAlarms: AlarmState[] = []
  muteUntil = -1
  asyncs: AsyncRecord[] = []
  sbt: SbtState | null = null
  sbtTimers = new Map<string, number>()
  log: LogEntry[] = []
  trends: TrendPoint[] = []
  abgs: AbgResult[] = []
  windowStart = 0
  /** 定常化のためにガス交換の時定数を短縮する倍率 */
  gasAccel = 1
  slowAcc = 0
  alarmAcc = 0
  trendAcc = 0
  pelMaxEma = 20
  dpEma = 10

  constructor(cfg: PatientConfig, settings: VentSettings) {
    this.cfg = cfg
    this.settings = { ...settings }
    this.baseP = computeParams(cfg, 1)
    this.ep = { ...this.baseP }
    this.reset(cfg, settings)
  }

  // ============================================================
  // 初期化
  // ============================================================
  reset(
    cfg: PatientConfig,
    settings: VentSettings,
    opts: { airway?: 'intubated' | 'extubated'; rass?: number; progress?: number } = {},
  ) {
    this.cfg = { ...cfg }
    this.settings = { ...settings }
    this.ibw = idealBodyWeight(cfg.sex, cfg.height)
    this.diseaseTau = DISEASES[cfg.disease].recoveryTau
    this.progress = opts.progress ?? 1
    this.baseP = computeParams(this.cfg, this.progress)
    this.airway = opts.airway ?? (isInvasiveMode(settings.mode) ? 'intubated' : 'extubated')
    this.lastInvasive = isInvasiveMode(settings.mode) ? { ...settings } : null
    this.alarmSettings = initialAlarmsFor(cfg.disease)
    this.events.clear()
    this.fluidBoost = 0
    this.na = 0
    this.prone = false
    this.bdUntil = -1
    this.recruitUntil = -1
    this.rass = opts.rass ?? (this.airway === 'intubated' ? (cfg.disease === 'ards' || cfg.disease === 'asthma' ? -4 : -3) : 0)
    this.rassTarget = this.rass
    this.sLoad = 0.15
    this.edemaOnset = null
    this.edemaLevel = 0
    this.extubatedAt = null
    this.cuffLeakTested = null
    this.coughAssessed = null
    this.fatigue = 0
    this.dStr = 1
    this.arrest = false
    this.hypoxTime = 0
    this.sbt = null
    this.breaths = []
    this.patBreaths = []
    this.asyncs = []
    this.log = []
    this.trends = []
    this.abgs = []
    this.activeAlarms = []
    this.alarmCond.clear()
    this.pplatMeasured = null
    this.peepTotMeasured = null
    this.lastBreath = null
    this.buf = []
    for (let i = 0; i < NCH; i++) this.buf.push(new Float32Array(BUF_LEN))
    this.bufCount = 0
    this.t = 0
    this.updateEffective()
    const p = this.ep
    this.r = 0.4
    const C = this.compliance()
    this.V = (this.basePressure() * C) / 1000
    this.prvcP = clamp(settings.vt / C, 8, 30)
    this.paco2 = p.paco2Set
    this.hco3 = p.hco3
    this.lactate = p.lactateBase
    this.hr = p.hr0
    this.map = p.map0
    this.co = p.co0
    this.sv0 = (p.co0 * 1000) / p.hr0
    this.sv = this.sv0
    this.svr0 = ((p.map0 - 6) * 80) / p.co0
    this.fio2Eff = this.settings.fio2
    this.pmsf = p.pmsf0
    this.vphase = 'exp'
    this.breathStart = 0
    this.n.phase = 'idle'
    this.n.t = 0
    this.updateDrive()
    // 定常状態まで高速に進める
    this.settling = true
    this.advance(30)
    this.settleGas(120)
    this.settling = false
    this.t0 = this.t
    this.windowStart = 0
    this.asyncs = []
    this.trends = []
    this.recordTrend()
    this.addLog('info', `シミュレーション開始：${DISEASES[cfg.disease].name}`)
  }

  // ============================================================
  // 補助関数
  // ============================================================
  addLog(kind: LogEntry['kind'], text: string) {
    if (this.settling) return
    this.log.push({ t: this.t, kind, text })
    if (this.log.length > 300) this.log.shift()
  }

  compliance(): number {
    const p = this.ep
    return p.cClosed + (p.cOpen - p.cClosed) * this.r
  }

  frc(): number {
    const p = this.ep
    return p.frcClosed + (p.frcOpen - p.frcClosed) * this.r
  }

  /** 呼吸器系の弾性圧（Pel）: 過膨張域で急峻になる */
  elastic(V: number): number {
    const p = this.ep
    const x = (V * 1000) / this.compliance()
    if (x > p.pover) {
      const d = x - p.pover
      return p.pover + d * (1 + p.kover * d)
    }
    return x
  }

  connected(): boolean {
    return !this.events.has('disconnect') && !this.events.has('selfExtubation')
  }

  intubated(): boolean {
    return this.airway === 'intubated' && !this.events.has('selfExtubation')
  }

  /** 患者に実際に供給される呼気終末圧 */
  basePressure(): number {
    const s = this.settings
    if (!this.connected() && this.airway === 'intubated') return 0
    switch (s.mode) {
      case 'NPPV-ST':
      case 'NPPV-CPAP':
        return s.epap
      case 'APRV':
        return s.pLow
      case 'HFNC':
        return this.hfncPeep()
      case 'O2':
      case 'TPIECE':
        return 0
      default:
        return s.peep
    }
  }

  hfncPeep(): number {
    return 0.05 * this.settings.hfncFlow
  }

  vdAnat(): number {
    // mL
    let vd = this.ep.vdAnatPerKg * this.ibw
    const m = this.settings.mode
    if (this.intubated()) vd = vd * 0.8 + 50 // チューブで上気道をバイパス＋Yピース/HME
    else if (m === 'NPPV-ST' || m === 'NPPV-CPAP') vd += 40
    else if (m === 'HFNC') vd -= Math.min(45, this.settings.hfncFlow * 0.8)
    return Math.max(60, vd)
  }

  /** 患者の気道開口部の圧から流量を求める（呼気流量制限を含む） */
  flowFromPaw(paw: number): number {
    const p = this.ep
    if (paw >= this.palv) return (paw - this.palv) / p.rInsp
    const pdown = Math.max(paw, p.pcrit)
    if (this.palv > pdown) return -(this.palv - pdown) / p.rExp
    return 0
  }

  // ============================================================
  // 病態・イベントを反映した実効パラメータ
  // ============================================================
  updateEffective() {
    const p = { ...this.baseP }
    if (!this.intubated()) {
      p.rInsp = Math.max(2, p.rInsp - p.rEtt + 1.5)
      p.rExp = Math.max(2, p.rExp - p.rEtt + 1.5)
      p.rInsp += 16 * this.edemaLevel
      p.rExp += 10 * this.edemaLevel
    }
    p.rInsp += 8 * this.sLoad
    p.rExp += 9 * this.sLoad
    p.shuntFixed += 0.16 * Math.max(0, this.sLoad - 0.35)
    if (this.t < this.bdUntil) {
      p.rInsp *= 0.85
      p.rExp *= 0.82
      p.pcrit *= 0.8
    }
    const ev = this.events
    if (ev.has('pneumothorax')) {
      const k = this.ptxK()
      p.cOpen *= 1 - 0.45 * k
      p.cClosed *= 1 - 0.45 * k
      p.frcOpen *= 1 - 0.4 * k
      p.frcClosed *= 1 - 0.4 * k
      p.shuntFixed += 0.25 * k
      p.ppl0 += 7 * k
    }
    if (ev.has('mucusPlug')) {
      p.rInsp += 18
      p.rExp += 22
      p.shuntFixed += 0.1
    }
    if (ev.has('ettObstruction') && this.intubated()) {
      p.rInsp += 40
      p.rExp += 46
    }
    if (ev.has('bronchospasm')) {
      const k = this.bronchoK()
      p.rInsp *= 1 + 1.3 * k
      p.rExp *= 1 + 1.6 * k
      p.pcrit += 3 * k
      p.lowVQ += 0.1 * k
    }
    if (ev.has('mainstem') && this.intubated()) {
      p.cOpen *= 0.55
      p.cClosed *= 0.55
      p.frcOpen *= 0.6
      p.frcClosed *= 0.6
      p.shuntFixed += 0.22
    }
    if (this.prone) {
      p.shuntRec *= 0.6
      p.popen -= 3
      p.pclose -= 2
      p.lowVQ *= 0.8
      p.cwFrac = Math.min(0.7, p.cwFrac + 0.05)
    }
    p.shuntFixed = clamp(p.shuntFixed, 0, 0.75)
    p.shuntRec = clamp(p.shuntRec, 0, 0.8 - p.shuntFixed)
    p.lowVQ = clamp(p.lowVQ, 0, 0.5)
    p.pmax = p.pmax * this.dStr * (1 - 0.5 * this.fatigue)
    this.ep = p
  }

  /** 緊張性気胸の進行度（3分で完成） */
  ptxK(): number {
    const st = this.events.get('pneumothorax')
    if (st === undefined) return 0
    return clamp(0.35 + (this.t - st) / 180, 0, 1)
  }

  /** 気管支攣縮の強さ（気管支拡張薬で減衰） */
  bronchoK(): number {
    const st = this.events.get('bronchospasm')
    if (st === undefined) return 0
    if (this.t < this.bdUntil && this.bdStart > st) {
      return Math.max(0, 1 - (this.t - this.bdStart) / 180)
    }
    return 1
  }
  bdStart = -1

  // ============================================================
  // 呼吸ドライブ
  // ============================================================
  effectiveRass(): number {
    let r = this.rass
    if (this.events.has('agitation')) r += 3
    return clamp(r, -5, 4)
  }

  updateDrive() {
    const p = this.ep
    // 鎮静薬（オピオイド等）はCO2応答の傾きも低下させる
    const sf = sedFactor(this.effectiveRass())
    const chem = 1 + 0.12 * Math.max(0.35, Math.min(1, sf)) * (this.paco2 - p.paco2Set)
    const hyp = this.pao2 < 65 ? Math.min(1.5, 0.035 * (65 - this.pao2)) : 0
    const acid = this.be < -4 ? 0.04 * (-4 - this.be) : 0
    let d = Math.max(0, chem + hyp + acid) * sf
    if (this.arrest) d = 0
    this.drive = clamp(d, 0, 4)
  }

  startEffort() {
    const p = this.ep
    const n = this.n
    const D = this.drive
    if (D < 0.25) {
      n.phase = 'idle'
      n.t = 0
      n.ttot = 1
      return
    }
    const rassE = this.effectiveRass()
    const painOn = rassE >= -1 ? p.pain : 0
    // ドライブが上がると主に換気量で、次いで呼吸数で換気を増やす（疲労すると浅く速くなる）
    let f = p.fBase * (0.7 + 0.25 * Math.min(D, 3.2)) * (1 + 0.9 * this.fatigue) * (1 + 0.35 * painOn)
    f = clamp(f, 4, 44)
    const ttot = (60 / f) * rnd(0.93, 1.07)
    const ti = clamp(p.tiRatio * ttot, 0.45, 1.3)
    const pmaxEff = p.pmax
    // 負荷補償: 硬い肺ではより大きな吸気努力で換気量を保とうとする（部分的）
    const loadComp = clamp(Math.sqrt((55 * (this.ibw / 66)) / this.compliance()), 0.8, 1.7)
    let amp = p.driveBase * D * loadComp * (1 - 0.25 * this.fatigue) * (1 - 0.25 * painOn) * rnd(0.92, 1.08)
    amp = Math.min(amp, 0.75 * pmaxEff)
    n.phase = 'insp'
    n.t = 0
    n.ti = ti
    n.ttot = ttot
    n.p = amp
    n.pExp = D > 1.8 ? Math.min(8, (D - 1.8) * 3) : 0
    n.id++
    n.triggers = 0
    n.startedInExp = this.vphase === 'exp' || this.vphase === 'holdE'
    n.ventInspTime = 0
    n.pmusMaxVent = 0
    this.effortTimes.push(this.t)
    if (this.effortTimes.length > 80) this.effortTimes.shift()
    // 呼吸筋の負荷（圧時間指数）
    const pti = ((amp * 0.64) / pmaxEff) * (ti / ttot)
    this.ptiEma += (pti - this.ptiEma) * 0.15
    this.pmusPeakLast = amp
  }

  updateNeural(dt: number) {
    const n = this.n
    n.t += dt
    let pm = 0
    if (n.phase === 'idle') {
      if (n.t >= n.ttot) this.startEffort()
    }
    if (n.phase === 'insp') {
      if (n.t < n.ti) {
        pm = n.p * Math.sin(((Math.PI / 2) * n.t) / n.ti)
        if (this.vphase === 'insp' || this.vphase === 'pause') n.ventInspTime += dt
      } else {
        n.phase = 'exp'
        n.inspEnd = this.t
        this.onEffortEnd()
      }
    }
    if (n.phase === 'exp') {
      const te = n.t - n.ti
      pm = n.p * Math.exp(-te / 0.12)
      const texp = n.ttot - n.ti
      if (n.pExp > 0 && te < 0.6 * texp) pm -= n.pExp * Math.sin((Math.PI * te) / (0.6 * texp))
      if (n.t >= n.ttot) this.startEffort()
    }
    this.pmus = pm
  }

  onEffortEnd() {
    const n = this.n
    if (this.settling) return
    if (!this.ventActive()) return
    if (this.settings.mode === 'APRV') return
    if (n.triggers === 0 && n.p > 2.5 && n.startedInExp && n.ventInspTime < 0.35 * n.ti) {
      this.addAsync('ineffective')
    }
  }

  addAsync(type: AsyncType) {
    if (this.settling) return
    this.asyncs.push({ t: this.t, type })
    if (this.asyncs.length > 400) this.asyncs.shift()
  }

  ventActive(): boolean {
    return isVentMode(this.settings.mode) && this.connected()
  }

  // ============================================================
  // メインステップ
  // ============================================================
  advance(seconds: number) {
    const steps = Math.round(seconds / DT)
    for (let i = 0; i < steps; i++) this.step()
  }

  step() {
    const dt = DT
    this.t += dt
    this.updateNeural(dt)
    this.pel = this.elastic(this.V)
    this.palv = this.pel - this.pmus
    if (this.arrest) {
      // 心停止中も呼吸器は動き続ける
    }
    this.ventStep(dt)
    this.V += this.flow * dt
    if (this.V < -0.6) this.V = -0.6
    this.updateRecruitment(dt)
    this.patientBreathDetect(dt)
    this.ppl = this.ep.ppl0 + this.ep.cwFrac * this.pel - this.pmus
    this.cardiacStep(dt)
    this.capnoStep(dt)
    this.writeBuffers()
    this.slowAcc += dt
    if (this.slowAcc >= 0.1 - 1e-9) {
      this.slowUpdate(this.slowAcc)
      this.slowAcc = 0
    }
  }

  writeBuffers() {
    const i = this.bufCount % BUF_LEN
    const b = this.buf
    b[CH.paw][i] = this.measPaw
    b[CH.flow][i] = this.measFlow * 60
    b[CH.vol][i] = Math.max(0, this.volDisp * 1000)
    b[CH.pes][i] = this.ppl
    b[CH.capno][i] = this.capno
    b[CH.ecg][i] = this.ecgValue()
    b[CH.pleth][i] = this.plethValue()
    b[CH.abp][i] = this.abpValue()
    b[CH.pmus][i] = this.pmus
    b[CH.palv][i] = this.palv
    this.bufCount++
  }

  /** k 秒前のバッファ値 */
  lookback(ch: number, sec: number): number {
    const k = Math.round(sec * FS)
    if (this.bufCount <= k) return this.buf[ch][0]
    const i = (this.bufCount - 1 - k) % BUF_LEN
    return this.buf[ch][i]
  }

  // ============================================================
  // リクルートメント（開放圧・閉塞圧のヒステリシス）
  // ============================================================
  updateRecruitment(dt: number) {
    const p = this.ep
    const m = this.pel + 0.7 * this.pmus
    const fo = sig((m - p.popen) / p.rw)
    const fc = sig((m - p.pclose) / p.rw)
    if (fo > this.r) this.r += ((fo - this.r) * dt) / 3
    if (fc < this.r) this.r -= ((this.r - fc) * dt) / 8
    this.r = clamp(this.r, 0, 1)
  }

  // ============================================================
  // 患者側の呼吸検出（換気量・呼吸数・肺胞換気量）
  // ============================================================
  patientBreathDetect(dt: number) {
    const f = this.flow
    if (f > 0) {
      this.pVin += f * dt
      // HFNC/酸素療法: 吸入ガスの混合
      this.hfncTot += f * dt
      this.hfncO2 += this.inspiredO2(f) * dt
    } else this.pVout -= f * dt
    if (this.pState === 'out' && f > 0.04) {
      this.pState = 'in'
      this.pStart = this.t
      this.vEndExp = this.V
      this.pVin = 0
      this.hfncO2 = 0
      this.hfncTot = 0
      this.exVol = 0
    } else if (this.pState === 'in' && f < -0.04) {
      this.pState = 'out'
      const vt = this.pVin
      const ti = this.t - this.pStart
      if (vt > 0.02) {
        this.patBreaths.push({ t: this.t, vt, ti })
        if (this.patBreaths.length > 120) this.patBreaths.shift()
        this.lastVtPatient = vt
        if (this.hfncTot > 0.01) {
          const fi = this.hfncO2 / this.hfncTot
          this.fio2Eff += (fi - this.fio2Eff) * 0.3
        }
      }
      this.pVout = 0
      this.exVol = 0
    }
  }

  /** 吸入ガスの酸素濃度（その瞬間の吸気流量 f[L/s] に対して） */
  inspiredO2(f: number): number {
    const s = this.settings
    if (!this.connected() && this.airway === 'intubated') return 0.21 * f
    if (this.events.has('selfExtubation')) return 0.21 * f
    if (s.mode === 'HFNC') {
      const fh = s.hfncFlow / 60
      return Math.min(f, fh) * s.fio2 + Math.max(0, f - fh) * 0.21
    }
    if (s.mode === 'O2') return this.o2DeviceFio2() * f
    return s.fio2 * f
  }

  o2DeviceFio2(): number {
    const s = this.settings
    const mv = Math.max(3, this.minuteVentPatient())
    const k = clamp(Math.sqrt(8 / mv), 0.6, 1.3)
    switch (s.o2Device) {
      case 'cannula':
        return Math.min(0.45, 0.21 + 0.035 * s.o2Flow * k)
      case 'mask':
        return s.o2Flow < 5 ? 0.21 + 0.02 * s.o2Flow : Math.min(0.6, 0.21 + 0.05 * s.o2Flow * k)
      case 'reservoir':
        return Math.min(0.9, 0.35 + 0.045 * s.o2Flow * k)
      default:
        return 0.21
    }
  }

  minuteVentPatient(): number {
    const win = 30
    let sum = 0
    for (let i = this.patBreaths.length - 1; i >= 0; i--) {
      const b = this.patBreaths[i]
      if (this.t - b.t > win) break
      sum += b.vt
    }
    return (sum / win) * 60
  }

  rrPatient(): number {
    const pb = this.patBreaths
    if (pb.length < 2) return 0
    const last = pb[pb.length - 1]
    if (this.t - last.t > 15) {
      let c = 0
      for (let i = pb.length - 1; i >= 0 && this.t - pb[i].t <= 60; i--) c++
      return c
    }
    const k = Math.min(6, pb.length - 1)
    const span = last.t - pb[pb.length - 1 - k].t
    return span > 0 ? (60 * k) / span : 0
  }

  // ============================================================
  // カプノグラム
  // ============================================================
  capnoStep(dt: number) {
    const capOK = !(this.airway === 'intubated' && !this.connected())
    if (this.flow < -0.02) {
      this.exVol += -this.flow * dt
      const vd = this.vdAnat() / 1000
      const vt = Math.max(0.05, this.lastVtPatient)
      let v = 0
      if (this.exVol < 0.5 * vd) v = 0
      else if (this.exVol < 1.3 * vd) {
        const x = (this.exVol - 0.5 * vd) / (0.8 * vd)
        v = 0.88 * this.petco2 * (x * x * (3 - 2 * x))
      } else {
        const obstr = clamp((this.ep.rExp - 12) / 25, 0, 1)
        const frac = clamp(this.exVol / vt, 0, 1)
        const s3 = 0.04 + 0.22 * obstr
        v = this.petco2 * (1 - s3 * (1 - frac)) * (0.88 + 0.12 * Math.min(1, (this.exVol - 1.3 * vd) / (0.15 + 0.3 * obstr)))
        v = Math.min(v, this.petco2)
      }
      this.capno += (v - this.capno) * Math.min(1, dt / 0.04)
    } else if (this.flow > 0.02) {
      this.capno += (0 - this.capno) * Math.min(1, dt / 0.05)
    }
    if (!capOK) this.capno = 0
    if (this.settings.mode === 'HFNC' || this.settings.mode === 'O2') this.capno *= 0.999
  }

  // ============================================================
  // 人工呼吸器
  // ============================================================
  ventStep(dt: number) {
    const s = this.settings
    const m = s.mode
    this.tPhase += dt

    // 回路外れ・計画外抜管: 患者は大気圧で自発呼吸のみ
    if (!this.connected()) {
      const f = this.flowFromPaw(0)
      this.flow = f
      this.paw = 0
      this.leak = 0
      if (isVentMode(m)) this.ventCycleInAir(dt)
      else {
        this.measPaw = 0
        this.measFlow = f
        this.volDisp += f * dt
      }
      return
    }

    // 補助なし（Tピース・HFNC・酸素）
    if (!isVentMode(m)) {
      let pext = 0
      if (m === 'HFNC') {
        const fh = s.hfncFlow / 60
        const inflow = Math.max(0, this.flow)
        pext = this.hfncPeep() * Math.max(0, 1 - Math.pow(Math.min(1, inflow / fh), 2))
      }
      const f = this.flowFromPaw(pext)
      this.flow = f
      this.paw = pext
      this.measPaw = pext
      this.measFlow = f
      this.leak = 0
      if (this.pState === 'out' && f > 0.04) this.volDisp = 0
      this.volDisp += f * dt
      this.vphase = f > 0.02 ? 'insp' : 'exp'
      return
    }

    // リクルートメント手技
    if (this.recruitUntil > this.t && isInvasiveMode(m)) {
      this.vphase = 'recruit'
      const target = 40
      const prev = this.measPaw
      const paw = prev + (target - prev) * Math.min(1, dt / 0.3)
      this.applyPressure(paw)
      return
    } else if (this.vphase === 'recruit') {
      this.vphase = 'exp'
      this.tPhase = 0
      this.breathStart = this.t
    }

    if (m === 'APRV') {
      this.aprvStep(dt)
      return
    }

    const nppv = isNppv(m)
    const base = nppv ? s.epap : s.peep

    switch (this.vphase) {
      case 'insp':
        this.inspStep(dt, base)
        break
      case 'pause':
      case 'holdI': {
        if (Math.abs(this.pmus) > this.holdEffort) this.holdEffort = Math.abs(this.pmus)
        this.flow = 0
        this.paw = this.palv
        this.leak = 0
        this.measPaw = this.palv
        this.measFlow = 0
        this.accumulate(dt, true)
        if (this.tPhase >= this.pauseDur) {
          // 表示波形は吸気努力で歪むが、数値は静的弾性圧（努力の影響はフラグで示す）
          const pplat = this.pel
          const effort = this.holdEffort > 1.5
          if (this.vphase === 'holdI') {
            const peepT = this.recentPeepTot() ?? base
            const vt = this.acc.patVol * 1000
            const crs = pplat - peepT > 0.5 ? vt / (pplat - peepT) : null
            const raw =
              this.kind === 'VC' && this.vcQEnd > 0.05 ? (this.acc.ppeak - pplat) / this.vcQEnd : null
            this.pplatMeasured = { v: pplat, t: this.t, crs, raw, dp: pplat - peepT, effort }
            this.addLog('action', `吸気ポーズ: Pplat ${pplat.toFixed(1)} cmH2O${effort ? '（自発呼吸あり・参考値）' : ''}`)
          } else if (this.kind === 'VC' && s.pause > 0) {
            const peepT = this.recentPeepTot() ?? base
            const vt = this.acc.patVol * 1000
            this.pplatMeasured = {
              v: pplat,
              t: this.t,
              crs: pplat - peepT > 0.5 ? vt / (pplat - peepT) : null,
              raw: this.vcQEnd > 0.05 ? (this.acc.ppeak - pplat) / this.vcQEnd : null,
              dp: pplat - peepT,
              effort,
            }
          }
          this.enterExp()
        }
        break
      }
      case 'holdE': {
        if (Math.abs(this.pmus) > this.holdEffort) this.holdEffort = Math.abs(this.pmus)
        this.flow = 0
        this.paw = this.palv
        this.leak = 0
        this.measPaw = this.palv
        this.measFlow = 0
        this.acc.pawInt += this.measPaw * dt
        if (this.tPhase >= 2.5) {
          const effort = this.holdEffort > 1.5
          this.peepTotMeasured = { v: this.pel, t: this.t, effort }
          this.addLog('action', `呼気ポーズ: 総PEEP ${this.pel.toFixed(1)} cmH2O（auto-PEEP ${(this.pel - base).toFixed(1)}）${effort ? '（自発呼吸あり・参考値）' : ''}`)
          this.vphase = 'exp'
          this.startBreath(this.holdTrig, true)
        }
        break
      }
      default:
        this.expStep(dt, base)
    }
  }

  /** 圧規定で患者流量を求め、リークを含む測定値を設定 */
  applyPressure(paw: number) {
    const s = this.settings
    const f = this.flowFromPaw(paw)
    this.flow = f
    this.paw = paw
    this.leak = this.leakAt(paw)
    this.measPaw = paw
    if (isNppv(s.mode)) {
      this.measFlow = f + this.leak - this.kLeakEst * Math.sqrt(Math.max(0, paw))
    } else {
      this.measFlow = f + this.leak
    }
  }

  leakK(): number {
    const s = this.settings
    if (isNppv(s.mode)) return 0.15 + [0, 0.12, 0.32][s.maskFit]
    if (this.events.has('cuffLeak')) return 0.06
    return 0
  }

  leakAt(paw: number): number {
    const k = this.leakK()
    return k > 0 ? k * Math.sqrt(Math.max(0, paw)) : 0
  }

  expStep(dt: number, base: number) {
    const s = this.settings
    const m = s.mode
    const nppv = isNppv(m)
    // 圧トリガー: デマンドバルブが閉じているため、吸気努力で圧が下がる
    if (!nppv && s.trigType === 'pressure' && this.palv < base) {
      this.flow = 0
      this.paw = this.palv
      this.leak = this.leakAt(base)
      this.measPaw = this.palv
      this.measFlow = this.leak
    } else {
      this.applyPressure(base)
    }
    if (nppv) {
      // リーク推定値の学習
      this.kLeakEst += (this.leakK() - this.kLeakEst) * (dt / 8)
    }
    this.accumulate(dt, false)
    this.volDisp += this.measFlow * dt
    this.endExpFlow = this.flow

    // ---- 患者トリガー
    if (this.pendingTrig >= 0) {
      this.pendingTrig -= dt
      if (this.pendingTrig < 0) {
        this.startBreath('patient')
        return
      }
    } else if (this.tPhase > 0.25) {
      let trig = false
      if (nppv || s.trigType === 'flow') trig = this.measFlow * 60 > s.trigFlow
      else trig = this.measPaw < base - s.trigPressure
      if (trig) this.pendingTrig = 0.05
    }

    // ---- 時間トリガー
    const since = this.t - this.breathStart
    switch (m) {
      case 'VC-AC':
      case 'PC-AC':
      case 'PRVC':
        if (since >= 60 / s.rr) this.startBreath('time')
        break
      case 'SIMV-VC':
      case 'SIMV-PC':
        if (this.pendingMand) this.startBreath('time')
        break
      case 'PSV': {
        if (since >= this.alarmSettings.apnea && !this.backup) {
          this.backup = true
          this.backupSpont = 0
          this.addLog('alarm', '無呼吸: バックアップ換気を開始')
        }
        if (this.backup && since >= 60 / Math.max(10, s.rr)) this.startBreath('time')
        break
      }
      case 'NPPV-ST':
        if (since >= 60 / s.nppvRR) this.startBreath('time')
        break
    }
  }

  /** SIMVの周期管理（全フェーズで呼ぶ） */
  simvTick() {
    const s = this.settings
    if (s.mode !== 'SIMV-VC' && s.mode !== 'SIMV-PC') return
    const T = 60 / s.rr
    if (this.t - this.simvCycleStart >= T) {
      this.simvCycleStart = this.t
      if (!this.simvSatisfied) this.pendingMand = true
      this.simvSatisfied = false
    }
  }

  startBreath(trig: 'patient' | 'time', afterHold = false) {
    const s = this.settings
    const m = s.mode
    this.pendingTrig = -1
    if (this.holdEReq && !afterHold) {
      this.holdEReq = false
      this.finalizeBreath()
      this.vphase = 'holdE'
      this.holdEffort = 0
      this.tPhase = 0
      this.holdTrig = trig
      this.acc.pawInt = 0
      return
    }
    if (!afterHold) this.finalizeBreath()
    const n = this.n
    const neuralInsp = n.phase === 'insp'
    // 非同調の検出
    if (trig === 'patient' && !this.settling) {
      if (!neuralInsp && this.t - n.inspEnd > 0.25) this.addAsync('autoTrigger')
      else if (neuralInsp && n.triggers >= 1) this.addAsync('double')
    }
    if (trig === 'patient' && neuralInsp) n.triggers++

    let kind: BreathKind = 'VC'
    let mandatory = true
    let isBackup = false
    switch (m) {
      case 'VC-AC':
        kind = 'VC'
        break
      case 'PC-AC':
      case 'PRVC':
        kind = 'PC'
        break
      case 'SIMV-VC':
      case 'SIMV-PC': {
        if (trig === 'time' || !this.simvSatisfied) {
          // 各周期で最初のトリガー（または周期開始時の時間トリガー）を強制換気にする
          kind = m === 'SIMV-VC' ? 'VC' : 'PC'
          this.simvSatisfied = true
          this.pendingMand = false
        } else {
          kind = 'PS'
          mandatory = false
        }
        break
      }
      case 'PSV':
        if (trig === 'time' && this.backup) {
          kind = 'PC'
          isBackup = true
        } else {
          kind = 'PS'
          mandatory = false
          if (this.backup) {
            this.backupSpont++
            if (this.backupSpont >= 2) {
              this.backup = false
              this.addLog('info', '自発呼吸を検知: バックアップ換気を終了')
            }
          }
        }
        break
      case 'NPPV-ST':
        if (trig === 'time') kind = 'PC'
        else {
          kind = 'PS'
          mandatory = false
        }
        break
      case 'NPPV-CPAP':
        kind = 'PS'
        mandatory = false
        break
    }
    this.kind = kind
    this.mandatory = mandatory
    this.trig = trig
    this.backupBreath = isBackup
    this.vphase = 'insp'
    this.tPhase = 0
    this.breathStart = this.t
    this.volDisp = 0
    this.acc = { vti: 0, vte: 0, ppeak: -99, pawInt: 0, pelMax: 0, leakInt: 0, patVol: 0 }
    this.psPeak = 0
    this.pmusMaxBreath = 0

    const nppv = isNppv(m)
    this.pcBase = nppv ? s.epap : s.peep
    if (kind === 'VC') {
      this.vcPeak = s.peakFlow / 60
      const meanF = s.flowPattern === 'square' ? this.vcPeak : 0.6 * this.vcPeak
      this.vcTi = s.vt / 1000 / meanF
    } else if (kind === 'PC') {
      if (nppv) {
        this.pcDelta = s.ipap - s.epap
        this.inspDur = s.nppvTi
      } else if (m === 'PRVC') {
        this.pcDelta = this.prvcP
        this.inspDur = s.ti
      } else {
        this.pcDelta = s.pinsp
        this.inspDur = s.ti
      }
    } else if (kind === 'PS') {
      this.psDelta = nppv ? (m === 'NPPV-CPAP' ? 0 : s.ipap - s.epap) : s.ps
      this.psTiMax = nppv ? s.nppvTiMax : 2.5
    }
  }
  backupBreath = false
  pmusMaxBreath = 0

  inspStep(dt: number, base: number) {
    const s = this.settings
    const al = this.alarmSettings
    if (this.pmus > this.pmusMaxBreath) this.pmusMaxBreath = this.pmus
    if (this.kind === 'VC') {
      const tt = this.tPhase
      const q = s.flowPattern === 'square' ? this.vcPeak : this.vcPeak * (1 - (0.8 * tt) / this.vcTi)
      const leak = this.leakAt(this.paw)
      let f = q - leak
      // 患者の吸気努力が強いと流量は送気量を超えない（従量式の流量は固定）
      let paw = this.palv + this.ep.rInsp * Math.max(0, f)
      if (f < 0) {
        f = 0
        paw = this.palv
      }
      this.flow = f
      this.paw = paw
      this.leak = leak
      this.measPaw = paw
      this.measFlow = q
      this.vcQEnd = q
      this.accumulate(dt, true)
      this.volDisp += this.measFlow * dt
      if (paw > al.pHigh) {
        this.highPFlagT = this.t
        this.endInsp()
        return
      }
      if (tt >= this.vcTi) {
        if (this.holdIReq) {
          this.holdIReq = false
          this.vphase = 'holdI'
          this.holdEffort = 0
          this.pauseDur = 2.0
          this.tPhase = 0
          this.inspDur = tt
        } else if (s.pause > 0) {
          this.vphase = 'pause'
          this.pauseDur = s.pause
          this.tPhase = 0
          this.inspDur = tt
        } else this.endInsp()
      }
      return
    }
    // 圧規定（PC / PS）
    const delta = this.kind === 'PS' ? this.psDelta : this.pcDelta
    const rise = Math.max(0.03, s.rise)
    const target = base + delta * Math.min(1, this.tPhase / rise)
    this.applyPressure(target)
    this.accumulate(dt, true)
    this.volDisp += this.measFlow * dt
    if (target > al.pHigh) {
      this.highPFlagT = this.t
      this.endInsp()
      return
    }
    if (this.kind === 'PC') {
      if (this.tPhase >= this.inspDur) {
        if (this.holdIReq && this.mandatory) {
          this.holdIReq = false
          this.vphase = 'holdI'
          this.holdEffort = 0
          this.pauseDur = 2.0
          this.inspDur = this.tPhase
          this.tPhase = 0
        } else this.endInsp()
      }
    } else {
      // PS: 流量サイクル
      if (this.measFlow > this.psPeak) this.psPeak = this.measFlow
      const etsF = (s.ets / 100) * this.psPeak
      if ((this.tPhase > 0.12 && this.measFlow < etsF && this.psPeak > 0.05) || this.tPhase >= this.psTiMax) {
        this.endInsp()
      }
    }
  }

  endInsp() {
    if (this.vphase === 'insp') this.inspDur = this.tPhase
    const n = this.n
    if (!this.settling) {
      // サイクルの非同調
      if (this.trig === 'patient' || !this.mandatory) {
        if (n.phase === 'insp' && n.ti - n.t > 0.4 && this.tPhase < 0.6 * n.ti) this.addAsync('prematureCycle')
        else if (n.phase === 'exp' && this.t - n.inspEnd > 0.4 && this.kind === 'PS') this.addAsync('delayedCycle')
      }
      if (this.kind === 'VC' && this.pmusMaxBreath > 7) this.addAsync('flowStarvation')
    }
    this.enterExp()
  }

  enterExp() {
    // Hering–Breuer 反射: 受動的な肺の膨張は神経呼吸リズムをリセットする（同調・エントレインメント）
    const n = this.n
    if (this.trig === 'time' && this.vphase !== 'exp' && n.phase === 'exp' && this.drive < 1.3 && !this.settling) {
      const te = n.t - n.ti
      n.t = n.ti + te * 0.3
    }
    this.vphase = 'exp'
    this.tPhase = 0
  }

  accumulate(dt: number, insp: boolean) {
    const a = this.acc
    if (insp) {
      a.vti += Math.max(0, this.measFlow) * dt
      a.patVol += this.flow * dt
      if (this.pel > a.pelMax) a.pelMax = this.pel
    } else {
      a.vte += Math.max(0, -this.flow) * dt
    }
    if (this.measPaw > a.ppeak) a.ppeak = this.measPaw
    a.pawInt += this.measPaw * dt
    a.leakInt += this.leak * dt
  }

  finalizeBreath() {
    if (this.breathStart <= 0 && this.breaths.length === 0 && this.acc.vti === 0) {
      this.breathStart = this.t
      return
    }
    const dur = this.t - this.breathStart
    if (dur < 0.05) return
    const a = this.acc
    const b: VentBreath = {
      start: this.breathStart,
      kind: this.kind,
      trig: this.trig,
      mandatory: this.mandatory,
      ti: this.inspDur,
      dur,
      vti: a.vti * 1000,
      vte: a.vte * 1000,
      ppeak: a.ppeak,
      pawInt: a.pawInt,
      peepEnd: this.measPaw,
      pelMax: a.pelMax,
      leakAvg: (a.leakInt / dur) * 60,
      backup: this.backupBreath,
    }
    this.breaths.push(b)
    if (this.breaths.length > 80) this.breaths.shift()
    this.lastBreath = b
    // PRVC: 次の吸気圧を調整
    if (this.settings.mode === 'PRVC' && b.kind === 'PC' && b.vte > 50) {
      const s = this.settings
      const cEst = b.vte / Math.max(3, this.prvcP)
      const want = s.vt / Math.max(5, cEst)
      const step = clamp(want - this.prvcP, -3, 3)
      this.prvcP = clamp(this.prvcP + step, 5, s.pmaxPrvc - 5 - s.peep)
    }
    // 肺傷害の指標
    if (b.pelMax > 0) {
      this.pelMaxEma += (b.pelMax - this.pelMaxEma) * 0.1
      this.dpEma += (b.pelMax - this.basePressure() - this.dpEma) * 0.1
    }
    this.acc = { vti: 0, vte: 0, ppeak: -99, pawInt: 0, pelMax: 0, leakInt: 0, patVol: 0 }
  }

  recentPeepTot(): number | null {
    if (this.peepTotMeasured && this.t - this.peepTotMeasured.t < 180) return this.peepTotMeasured.v
    return null
  }

  aprvStep(dt: number) {
    const s = this.settings
    this.aprvT += dt
    const level = this.aprvHigh ? s.pHigh : s.pLow
    const prev = this.aprvHigh ? s.pLow : s.pHigh
    const dur = this.aprvHigh ? s.tHigh : s.tLow
    const paw = prev + (level - prev) * Math.min(1, this.aprvT / 0.08)
    this.applyPressure(paw)
    this.accumulate(dt, this.aprvHigh)
    this.volDisp += this.measFlow * dt
    if (this.aprvT >= dur) {
      this.aprvT = 0
      if (this.aprvHigh) {
        this.aprvHigh = false
        this.inspDur = this.t - this.breathStart
        this.vphase = 'exp'
        this.tPhase = 0
      } else {
        this.endExpFlow = this.flow
        this.finalizeBreath()
        this.aprvHigh = true
        this.kind = 'APRV'
        this.mandatory = true
        this.trig = 'time'
        this.vphase = 'insp'
        this.tPhase = 0
        this.breathStart = this.t
        this.volDisp = 0
      }
    }
  }

  /** 回路外れ時: 呼吸器は大気に向かって送気を続ける */
  ventCycleInAir(dt: number) {
    const s = this.settings
    this.leak = 0
    if (this.vphase === 'insp') {
      const isVC = this.kind === 'VC'
      this.measFlow = isVC ? s.peakFlow / 60 : 1.6
      this.measPaw = 0.6
      this.volDisp += this.measFlow * dt
      this.accumulateAir(dt, true)
      const tiLim = isVC ? this.vcTi : this.kind === 'PC' ? this.inspDur : this.psTiMax
      if (this.tPhase >= tiLim) this.enterExp()
    } else {
      if (this.vphase !== 'exp') this.vphase = 'exp'
      this.measFlow = 0
      this.measPaw = 0
      this.accumulateAir(dt, false)
      const since = this.t - this.breathStart
      const m = s.mode
      let due = false
      if (m === 'VC-AC' || m === 'PC-AC' || m === 'PRVC') due = since >= 60 / s.rr
      else if (m === 'SIMV-VC' || m === 'SIMV-PC') due = this.pendingMand
      else if (m === 'PSV') {
        if (since >= this.alarmSettings.apnea) this.backup = true
        due = this.backup && since >= 60 / Math.max(10, s.rr)
      } else if (m === 'NPPV-ST') due = since >= 60 / s.nppvRR
      if (due) this.startBreath('time')
    }
  }

  accumulateAir(dt: number, insp: boolean) {
    const a = this.acc
    if (insp) a.vti += this.measFlow * dt
    if (this.measPaw > a.ppeak) a.ppeak = this.measPaw
    a.pawInt += this.measPaw * dt
  }

  // ============================================================
  // 心拍・動脈圧・プレチスモ
  // ============================================================
  cardiacStep(dt: number) {
    if (this.arrest || this.hr < 5) {
      this.beatT += dt
      return
    }
    this.beatT += dt
    if (this.beatT >= this.beatRR) {
      this.beatT -= this.beatRR
      this.beatRR = (60 / this.hr) * rnd(0.985, 1.015)
      // 呼吸性変動（胸腔内圧の変化が遅れて1回拍出量を減らす）
      const pplDelayed = this.lookback(CH.pes, 1.3)
      const gap = this.pmsf - this.rap
      const volF = clamp(5.5 / Math.max(0.8, gap), 0.4, 3.2)
      const kppv = 0.014 * volF
      const svBeat = this.sv * clamp(1 - kppv * (pplDelayed - this.pplMean), 0.3, 1.5)
      const pp = 0.68 * svBeat * clamp(this.map / 80, 0.5, 1.4)
      this.beatSbp = this.map + (2 / 3) * pp
      this.beatDbp = this.map - (1 / 3) * pp
      this.ppList.push({ t: this.t, pp })
      if (this.ppList.length > 60) this.ppList.shift()
    }
  }

  ecgValue(): number {
    if (this.arrest) return Math.sin(this.t * 7) * 0.01
    const t = this.beatT
    const sc = Math.min(1, this.beatRR / 0.8)
    const g = (c: number, w: number, a: number) => a * Math.exp(-((t - c * sc) ** 2) / (2 * (w * sc) ** 2))
    return (
      g(0.08, 0.022, 0.12) +
      g(0.165, 0.008, -0.1) +
      g(0.19, 0.01, 1.0) +
      g(0.215, 0.01, -0.22) +
      g(0.42, 0.045, 0.28)
    )
  }

  abpValue(): number {
    if (this.arrest) return 6 + Math.sin(this.t) * 0.5
    const u = (this.beatT - 0.12 * Math.min(1, this.beatRR / 0.8)) / this.beatRR
    const x = u < 0 ? u + 1 : u
    const sbp = this.beatSbp
    const dbp = this.beatDbp
    const pp = sbp - dbp
    // 収縮期: 滑らかな立ち上がりと丸い頂点 → 重複切痕 → 拡張期の指数減衰
    const sys = x < 0.13 ? Math.sin(((Math.PI / 2) * x) / 0.13) ** 2 : Math.exp(-((x - 0.13) ** 2) / (2 * 0.06 ** 2))
    const tail = x > 0.13 ? 0.62 * Math.exp(-((x - 0.13) / 0.32)) : 0
    const rise = x < 0.13 ? 0 : 1
    let v = Math.max(sys, rise * tail)
    // 重複切痕と重複波
    v += 0.07 * Math.exp(-((x - 0.36) ** 2) / (2 * 0.025 ** 2)) - 0.05 * Math.exp(-((x - 0.32) ** 2) / (2 * 0.012 ** 2))
    return dbp + pp * v - pp * 0.04 * (x > 0.6 ? (x - 0.6) / 0.4 : 0)
  }

  plethValue(): number {
    if (this.arrest || this.map < 25) return 0
    const u = (this.beatT - 0.22 * Math.min(1, this.beatRR / 0.8)) / this.beatRR
    const x = u < 0 ? u + 1 : u
    const amp = clamp((this.beatSbp - this.beatDbp) / 45, 0.2, 1.6) * clamp((this.map - 30) / 40, 0.1, 1)
    let v: number
    if (x < 0.15) v = Math.sin((Math.PI / 2) * (x / 0.15))
    else if (x < 0.4) v = 1 - 0.45 * ((x - 0.15) / 0.25)
    else if (x < 0.46) v = 0.55 + 0.06 * Math.sin((Math.PI * (x - 0.4)) / 0.06)
    else v = 0.55 * Math.exp(-(x - 0.46) / 0.22)
    return v * amp
  }

  // ============================================================
  // 低速更新（0.1秒ごと）: ガス交換・循環・病態経過・アラーム
  // ============================================================
  slowUpdate(dt: number) {
    const p0 = this.ep
    // 鎮静レベルの変化
    if (this.rassTarget > this.rass) this.rass = Math.min(this.rassTarget, this.rass + dt / 240)
    else if (this.rassTarget < this.rass) this.rass = Math.max(this.rassTarget, this.rass - dt / 60)

    // 疲労・横隔膜・分泌物・病態経過
    this.longTermUpdate(dt)

    this.simvTick()
    this.updateEffective()
    this.updateDrive()

    // ---- 肺胞換気量
    const vdA = this.vdAnat() / 1000
    const overd = Math.max(0, this.pelMaxEma - p0.pover) * 0.012
    const lowCo = 0.25 * Math.max(0, 1 - this.co / p0.co0)
    const vdAlv = clamp(p0.vdAlv + overd + lowCo, 0, 0.8)
    this.vdAlvEff = vdAlv
    let vaSum = 0
    let vtSum = 0
    let nb = 0
    const win = 30
    for (let i = this.patBreaths.length - 1; i >= 0; i--) {
      const b = this.patBreaths[i]
      if (this.t - b.t > win) break
      const alvVol = Math.max(0, b.vt - vdA)
      vaSum += alvVol * (1 - vdAlv)
      vtSum += b.vt
      nb++
    }
    const windowLen = Math.min(win, this.t - (this.patBreaths[0]?.t ?? this.t) + 5)
    this.va = windowLen > 0 ? (vaSum / Math.max(10, windowLen)) * 60 : 0
    this.vdvt = vtSum > 0 ? 1 - vaSum / vtSum : 1
    // 換気量が小さい呼吸ではEtCO2がプラトーに達しない
    const vtLast = this.lastVtPatient
    const reach = clamp((vtLast / vdA - 0.8) / 0.7, 0, 1)
    this.petco2 = this.paco2 * (1 - vdAlv) * reach
    if (nb === 0 && this.t - (this.patBreaths[this.patBreaths.length - 1]?.t ?? 0) > 15) this.petco2 *= 0.98

    // ---- FiO2（実効）
    const s = this.settings
    if (!this.connected() && this.airway === 'intubated') this.fio2Eff += (0.21 - this.fio2Eff) * Math.min(1, dt / 5)
    else if (this.events.has('selfExtubation')) this.fio2Eff += (0.21 - this.fio2Eff) * Math.min(1, dt / 5)
    else if (s.mode === 'O2') this.fio2Eff += (this.o2DeviceFio2() - this.fio2Eff) * Math.min(1, dt / 5)
    else if (s.mode !== 'HFNC') this.fio2Eff += (s.fio2 - this.fio2Eff) * Math.min(1, dt / 3)

    // ---- CO2
    const vco2 = this.vco2()
    const elim = (this.va * this.paco2) / 0.863
    this.paco2 += ((vco2 - elim) / 30) * (dt / 60) * this.gasAccel
    this.paco2 = clamp(this.paco2, 12, 160)

    // ---- 肺胞酸素（FRCへの洗い込み）
    const eelv = Math.max(0.3, this.frc() + Math.max(0, this.vEndExp))
    const vo2 = this.vo2()
    const pi = pio2(this.fio2Eff)
    void vo2
    const dPA = (this.va * (pi - this.pAO2) - (this.uptake / 1000) * 1.21 * 713) / eelv
    this.pAO2 += dPA * (dt / 60) * Math.min(this.gasAccel, 3)
    this.pAO2 = clamp(this.pAO2, 15, pi)

    // ---- 酸塩基
    this.hco3 = p0.hco3 + 0.1 * (this.paco2 - p0.paco2Set) - (this.lactate - 1)
    this.ph = phFrom(this.hco3, this.paco2)
    this.be = baseExcess(this.hco3, this.ph)

    // ---- 酸素化（静脈血の酸素貯蔵を含む動的モデル）
    this.oxygenationStep(dt)
    this.pao2 += (this.pao2Target - this.pao2) * Math.min(1, dt / 4)
    this.spo2 += (this.sao2Calc() * 100 - this.spo2) * Math.min(1, dt / 7)

    // ---- EtCO2 表示
    this.etco2Disp += (this.petco2 - this.etco2Disp) * Math.min(1, dt / 2)

    // ---- 乳酸
    const do2 = this.co * this.cao2 * 10
    const crit = 7.5 * this.ibw
    if (do2 < crit || this.arrest) {
      const k = this.arrest ? 1 : (crit - do2) / crit
      this.lactate += 0.8 * k * (dt / 60)
    } else {
      this.lactate += (p0.lactateBase - this.lactate) * (dt / 60 / 40)
    }
    this.lactate = clamp(this.lactate, 0.5, 20)

    this.circulation(dt)

    // ---- アラーム（0.5秒ごと）
    this.alarmAcc += dt
    if (this.alarmAcc >= 0.5 && !this.settling) {
      this.checkAlarms(this.alarmAcc)
      this.alarmAcc = 0
    }
    // ---- トレンド（5秒ごと）
    this.trendAcc += dt
    if (this.trendAcc >= 5 && !this.settling) {
      this.trendAcc = 0
      this.recordTrend()
    }
    if (!this.settling) {
      this.sbtUpdate(dt)
      if (this.randomEvents && Math.random() < (0.25 / 3600) * dt) this.randomEvent()
      // 喉頭浮腫の発症
      if (this.edemaOnset !== null && this.t > this.edemaOnset && !this.intubated()) {
        this.edemaLevel = Math.min(1, this.edemaLevel + dt / 1500)
      }
    }
  }

  vco2(): number {
    const r = this.effectiveRass()
    const agit = r > 0 ? 1 + 0.1 * r : 1
    const wob = 1 + 0.015 * Math.max(0, this.pmusPeakLast - 6) * (this.rrPatient() / 20)
    return this.ep.vco2 * agit * wob
  }
  vo2(): number {
    return (this.vco2() / this.ep.vco2) * this.ep.vo2
  }

  sao2Calc(): number {
    return this.sao2
  }

  /**
   * 動的酸素化: 混合静脈血の酸素含量を状態変数とし（時定数 = 静脈血量/心拍出量）、
   * 肺毛細管での酸素摂取量が肺胞酸素の収支を決める
   */
  oxygenationStep(dt: number) {
    const p = this.ep
    const hb = p.hb
    const ph = this.ph
    const temp = p.temp
    const be = this.be
    this.shunt = p.shuntFixed + p.shuntRec * (1 - this.r)
    const pi = pio2(this.fio2Eff)
    const cv = this.cvO2
    const pvo2 = po2FromContent(cv, hb, ph, temp, be)
    const ccN = o2Content(this.pAO2, hb, ph, temp, be)
    const pLow = Math.max(pvo2, pi - (pi - this.pAO2) / Math.max(0.05, p.vq))
    const ccL = o2Content(pLow, hb, ph, temp, be)
    const nf = Math.max(0, 1 - this.shunt - p.lowVQ)
    const ca = nf * ccN + p.lowVQ * ccL + this.shunt * cv
    const co = this.arrest ? 0.15 : Math.max(0.3, this.co)
    this.uptake = co * 10 * (nf * (ccN - cv) + p.lowVQ * (ccL - cv))
    const tauV = (0.05 * this.cfg.weight) / co // 分（静脈血量/心拍出量）
    const vo2 = this.vo2()
    const cvT = Math.max(0.3, ca - vo2 / (co * 10))
    this.cvO2 += (cvT - this.cvO2) * Math.min(1, (dt / 60 / tauV) * this.gasAccel)
    this.cvO2 = Math.max(0.3, this.cvO2)
    this.cao2 = ca
    this.pvo2 = pvo2
    this.svo2 = satFromPo2(pvo2, ph, temp, be)
    this.pao2Target = po2FromContent(ca, hb, ph, temp, be)
    this.sao2 = satFromPo2(this.pao2, ph, temp, be)
  }
  cvO2 = 15
  uptake = 250

  solveOxygenation() {
    const p = this.ep
    this.shunt = p.shuntFixed + p.shuntRec * (1 - this.r)
    const res = oxygenation({
      pao2Alv: this.pAO2,
      fio2: this.fio2Eff,
      shunt: this.shunt,
      lowVQ: p.lowVQ,
      vq: p.vq,
      hb: p.hb,
      ph: this.ph,
      temp: p.temp,
      be: this.be,
      vo2: this.vo2(),
      co: this.arrest ? 0.3 : this.co,
    })
    this.pao2Target = res.pao2
    this.sao2 = res.sao2
    this.cao2 = res.cao2
    this.pvo2 = res.pvo2
    this.svo2 = res.svo2
    this.cvO2 = res.cvo2
    this.uptake = this.vo2()
  }

  /** ガス交換を加速して閉ループのまま定常状態へ近づける */
  settleGas(seconds: number) {
    this.gasAccel = 10
    this.advance(seconds - 15)
    this.gasAccel = 1
    this.advance(15)
    this.pao2 = this.pao2Target
    this.spo2 = this.sao2 * 100
    this.etco2Disp = this.petco2
  }

  equilibrateGas() {
    const va = Math.max(0.3, this.va)
    this.paco2 = clamp((0.863 * this.vco2()) / va, 15, 140)
    const pi = pio2(this.fio2Eff)
    this.pAO2 = clamp(pi - ((this.vo2() / 1000) * 1.21 * 713) / va, 25, pi)
    this.hco3 = this.ep.hco3 + 0.1 * (this.paco2 - this.ep.paco2Set) - (this.lactate - 1)
    this.ph = phFrom(this.hco3, this.paco2)
    this.be = baseExcess(this.hco3, this.ph)
    for (let i = 0; i < 3; i++) this.solveOxygenation()
    this.pao2 = this.pao2Target
    this.spo2 = this.sao2 * 100
    this.etco2Disp = this.petco2
  }

  circulation(dt: number) {
    const p = this.ep
    const a = Math.min(1, dt / 8)
    this.pplMean += (this.ppl - this.pplMean) * a
    this.palvMean += (this.pel - this.palvMean) * a
    const pplRef = p.ppl0 + p.cwFrac * 10
    const dPpl = (this.pplMean - pplRef) * 0.735
    let rap = 6 + dPpl
    const ptp = this.palvMean - this.pplMean
    rap += 0.12 * Math.max(0, ptp - 12)
    if (this.events.has('pneumothorax')) rap += 6 * this.ptxK()
    let pmsf = p.pmsf0 + this.fluidBoost + 4 * this.na + 0.5 * dPpl
    if (this.events.has('hypovolemia')) pmsf -= 3.5
    // 圧受容体反射による静脈収縮（容量血管の動員）
    pmsf += clamp(0.1 * (p.map0 - this.map), 0, 3)
    this.rap = rap
    this.pmsf = pmsf
    const vr = Math.max(0.02, (pmsf - rap) / Math.max(2, p.pmsf0 - 6))
    const preload = vr <= 1 ? Math.pow(vr, 0.7) : 1 + (vr - 1) * 0.35
    let contract = 1 + 0.6 * this.na
    if (this.ph < 7.2) contract *= Math.max(0.4, 1 - (7.2 - this.ph) * 1.5)
    if (this.sao2 < 0.7) contract *= Math.max(0.3, 1 - (0.7 - this.sao2) * 2)
    const sv = this.sv0 * preload * contract

    // 低酸素による徐脈・心停止
    if (!this.arrest) {
      if (this.sao2 < 0.6) this.hypoxTime += dt
      else this.hypoxTime = Math.max(0, this.hypoxTime - dt * 2)
    }
    let hrT = p.hr0
    hrT += clamp(1.1 * (p.map0 - this.map), -25, 55)
    if (this.sao2 < 0.9) hrT += Math.min(40, (0.9 - this.sao2) * 120)
    hrT += Math.max(0, this.paco2 - 55) * 0.35
    const rassE = this.effectiveRass()
    if (rassE > 0) hrT += rassE * 7
    if (this.drive > 1.6) hrT += (this.drive - 1.6) * 10
    hrT += 12 * this.na
    if (this.hypoxTime > 60) hrT *= Math.max(0.25, 1 - (this.hypoxTime - 60) / 150)
    hrT = clamp(hrT, 20, 185)
    this.hr += (hrT - this.hr) * Math.min(1, dt / 6)
    this.sv = sv
    this.co = (this.hr * sv) / 1000
    let svr = this.svr0 * (1 + 3.5 * this.na) * (1 - 0.004 * Math.max(0, this.paco2 - 50))
    svr *= 1 + clamp(0.008 * (p.map0 - this.map), -0.1, 0.25)
    const mapT = (this.co * svr) / 80 + rap
    this.map += (mapT - this.map) * Math.min(1, dt / 3)
    if ((this.hypoxTime > 200 && this.sao2 < 0.5) || this.map < 22) {
      if (!this.arrest) {
        this.arrest = true
        this.addLog('alarm', '心停止')
      }
    }
    if (this.arrest) {
      this.hr = 0
      this.co = 0
      this.map += (8 - this.map) * Math.min(1, dt / 2)
    }
    // 表示用の血圧
    this.sbp = this.beatSbp
    this.dbp = this.beatDbp
  }

  ppv(): number {
    const list = this.ppList.filter((x) => this.t - x.t < 8)
    if (list.length < 4) return 0
    let mx = -1e9
    let mn = 1e9
    let sum = 0
    for (const x of list) {
      mx = Math.max(mx, x.pp)
      mn = Math.min(mn, x.pp)
      sum += x.pp
    }
    const mean = sum / list.length
    return mean > 0 ? ((mx - mn) / mean) * 100 : 0
  }

  // ============================================================
  // 長期経過（病態改善・呼吸筋疲労・横隔膜萎縮・分泌物）
  // ============================================================
  longTermUpdate(dt: number) {
    const h = dt / 3600
    // 呼吸筋疲労
    const pti = this.n.phase === 'idle' ? 0 : this.ptiEma
    if (pti > 0.15) this.fatigue += (pti - 0.15) * 0.0015 * dt
    else if (pti < 0.12) this.fatigue -= 0.00006 * dt
    this.fatigue = clamp(this.fatigue, 0, 0.9)
    // 人工呼吸器関連横隔膜機能障害（VIDD）
    const effortsPerMin = this.skipping
      ? this.n.phase === 'idle'
        ? 0
        : 10
      : this.effortTimes.filter((x) => this.t - x < 60).length
    if (this.intubated() && effortsPerMin < 2 && this.ventActive()) this.dStr = Math.max(0.6, this.dStr - 0.006 * h)
    else this.dStr = Math.min(1, this.dStr + 0.004 * h)
    // 分泌物
    const p = this.baseP
    if (this.intubated()) this.sLoad += p.secretion * 0.08 * h
    else {
      const coughEff = this.effectiveRass() >= -2 ? p.cough : p.cough * 0.3
      this.sLoad += (p.secretion * 0.16 - coughEff * 0.2) * h
    }
    this.sLoad = clamp(this.sLoad, 0, 1)
    // 病態の改善（肺傷害を起こす換気では遅れる・悪化する）
    let k = 1
    if (this.pelMaxEma > 30) k -= 0.15 * (this.pelMaxEma - 30)
    if (this.dpEma > 15) k -= 0.1 * (this.dpEma - 15)
    if (this.cfg.disease === 'ards' && this.pmusPeakLast > 15 && this.n.phase !== 'idle') k -= 0.05 * (this.pmusPeakLast - 15)
    k = Math.max(-0.5, k)
    const old = this.progress
    this.progress = clamp(this.progress - (this.progress * k * h) / this.diseaseTau, 0, 1.25)
    this.progressAcc += Math.abs(this.progress - old)
    if (this.progressAcc > 0.002) {
      this.progressAcc = 0
      this.baseP = computeParams(this.cfg, this.progress)
    }
  }
  progressAcc = 0
  skipping = false

  // ============================================================
  // アラーム
  // ============================================================
  cond(id: string, label: string, priority: 'high' | 'medium', active: boolean, delay: number, dt: number) {
    const cur = this.alarmCond.get(id) ?? 0
    const next = active ? cur + dt : 0
    this.alarmCond.set(id, next)
    const idx = this.activeAlarms.findIndex((a) => a.id === id)
    if (active && next >= delay) {
      if (idx < 0) {
        this.activeAlarms.push({ id, label, priority, since: this.t })
        this.addLog('alarm', label)
      }
    } else if (!active && idx >= 0) {
      this.activeAlarms.splice(idx, 1)
    }
  }

  checkAlarms(dt: number) {
    const al = this.alarmSettings
    const m = this.settings.mode
    const ventUsed = isVentMode(m)
    const sn = this.snapshotVent()
    const recentBreath = this.lastBreath && this.t - this.lastBreath.start < 15
    const cond = this.cond.bind(this)
    cond('arrest', '心停止', 'high', this.arrest, 0, dt)
    const disc = ventUsed && this.airway === 'intubated' && !this.connected()
    cond('disc', '回路外れ／低気道内圧', 'high', disc || (ventUsed && !!recentBreath && sn.ppeak < al.pLow && this.lastBreath!.mandatory), 1, dt)
    cond('phigh', '気道内圧上限', 'high', ventUsed && this.t - this.highPFlagT < 6, 0, dt)
    const lastPatB = this.patBreaths[this.patBreaths.length - 1]
    const lastAny = Math.max(this.lastBreath?.start ?? 0, lastPatB?.t ?? 0)
    cond('apnea', '無呼吸', 'high', this.t - lastAny > al.apnea, 0, dt)
    if (ventUsed) {
      cond('mvlow', '分時換気量 下限', 'high', sn.mve < al.mvLow && this.t - this.t0 > 30, 3, dt)
      cond('mvhigh', '分時換気量 上限', 'medium', sn.mve > al.mvHigh, 5, dt)
      cond('vtlow', '1回換気量 下限', 'medium', !!recentBreath && sn.vte < al.vtLow && this.connected(), 4, dt)
      cond('vthigh', '1回換気量 上限', 'medium', !!recentBreath && sn.vte > al.vtHigh, 4, dt)
      cond('rrhigh', '呼吸回数 上限', 'medium', sn.rrTot > al.rrHigh, 5, dt)
      cond('leak', 'リーク過大', 'medium', isNppv(m) ? sn.leak > 60 : sn.leak > 10, 5, dt)
    } else {
      for (const id of ['mvlow', 'mvhigh', 'vtlow', 'vthigh', 'rrhigh', 'leak']) cond(id, '', 'medium', false, 0, dt)
      cond('rrhighP', '呼吸回数 上限', 'medium', this.rrPatient() > al.rrHigh, 5, dt)
    }
    cond('spo2low', 'SpO2 下限', this.spo2 < 85 ? 'high' : 'medium', !this.arrest && this.spo2 < al.spo2Low, 4, dt)
    cond('hrhigh', '心拍数 上限', 'medium', !this.arrest && this.hr > al.hrHigh, 4, dt)
    cond('hrlow', '心拍数 下限', 'high', !this.arrest && this.hr < al.hrLow, 3, dt)
    cond('sbplow', '収縮期血圧 下限', 'high', !this.arrest && this.sbp < al.sbpLow, 4, dt)
    cond('sbphigh', '収縮期血圧 上限', 'medium', this.sbp > al.sbpHigh, 4, dt)
    const capOK = this.capnoAvailable()
    cond('etco2high', 'EtCO2 上限', 'medium', capOK && this.etco2Disp > al.etco2High, 5, dt)
    cond('etco2low', 'EtCO2 下限', 'medium', capOK && this.etco2Disp < al.etco2Low && !this.arrest, 8, dt)
  }

  capnoAvailable(): boolean {
    return this.airway === 'intubated' || isNppv(this.settings.mode)
  }

  // ============================================================
  // トレンド・血液ガス
  // ============================================================
  recordTrend() {
    const v = this.snapshotVent()
    this.trends.push({
      t: this.t,
      spo2: this.arrest ? NaN : this.spo2,
      hr: this.hr,
      map: this.map,
      sbp: this.sbp,
      etco2: this.etco2Disp,
      paco2: this.paco2,
      pao2: this.pao2,
      rr: isVentMode(this.settings.mode) ? v.rrTot : this.rrPatient(),
      vt: isVentMode(this.settings.mode) ? v.vte : this.lastVtPatient * 1000,
      mv: isVentMode(this.settings.mode) ? v.mve : this.minuteVentPatient(),
      ppeak: isVentMode(this.settings.mode) ? v.ppeak : 0,
      fio2: this.fio2Eff,
      peep: this.basePressure(),
    })
    if (this.trends.length > 6000) this.trends.shift()
  }

  sampleAbg(): AbgResult {
    const noise = (x: number, sd: number) => x + (Math.random() - 0.5) * 2 * sd
    const fi = this.fio2Eff
    const pao2 = noise(this.pao2, 1.5)
    const paco2 = noise(this.paco2, 0.8)
    const pAlvEq = pio2(fi) - paco2 / 0.8
    const res: AbgResult = {
      t: this.t,
      ph: noise(this.ph, 0.005),
      paco2,
      pao2,
      hco3: noise(this.hco3, 0.3),
      be: noise(this.be, 0.3),
      sao2: Math.min(100, noise(this.sao2 * 100, 0.3)),
      lactate: Math.max(0.3, noise(this.lactate, 0.1)),
      hb: this.ep.hb,
      fio2: fi,
      pf: pao2 / fi,
      aado2: pAlvEq - pao2,
    }
    this.abgs.push(res)
    this.addLog('action', `動脈血ガス採取: pH ${res.ph.toFixed(2)} / PaCO2 ${res.paco2.toFixed(0)} / PaO2 ${res.pao2.toFixed(0)}`)
    return res
  }

  // ============================================================
  // 操作API
  // ============================================================
  applySettings(s: VentSettings) {
    const prevMode = this.settings.mode
    const changed: string[] = []
    if (s.mode !== prevMode) changed.push(`モード ${prevMode}→${s.mode}`)
    this.settings = { ...s }
    if (isInvasiveMode(s.mode) && s.mode !== 'TPIECE') this.lastInvasive = { ...s }
    if (s.mode !== prevMode) {
      this.vphase = 'exp'
      this.tPhase = 0
      this.backup = false
      this.aprvHigh = true
      this.aprvT = 0
      this.simvCycleStart = this.t
      this.simvSatisfied = false
      this.pendingMand = false
      if (s.mode === 'PRVC') this.prvcP = clamp(s.vt / this.compliance(), 8, 30)
      if (isNppv(s.mode)) this.kLeakEst = this.leakK()
      if (s.mode === 'HFNC' || s.mode === 'O2') this.fio2Eff = s.mode === 'HFNC' ? s.fio2 : this.fio2Eff
    }
    this.addLog('action', changed.length ? `設定変更: ${changed.join(', ')}` : '設定変更を確定')
  }

  setAlarmSettings(a: AlarmSettings) {
    this.alarmSettings = { ...a }
    this.addLog('action', 'アラーム設定を変更')
  }

  triggerEvent(id: EventId) {
    if (this.events.has(id)) return
    if ((id === 'mainstem' || id === 'ettObstruction' || id === 'cuffLeak' || id === 'disconnect' || id === 'selfExtubation') && this.airway !== 'intubated') {
      this.addLog('info', `${EVENT_INFO[id].name}: 挿管中でないため発生しません`)
      return
    }
    this.events.set(id, this.t)
    if (id === 'selfExtubation') {
      this.edemaOnset = null
    }
    if (id === 'mucusPlug' || id === 'mainstem' || id === 'pneumothorax') this.r = Math.max(0, this.r - 0.1)
    this.addLog('event', `急変: ${EVENT_INFO[id].name}`)
  }

  resolveEvent(id: EventId, how: string) {
    if (!this.events.has(id)) return false
    this.events.delete(id)
    this.addLog('action', `${how} → ${EVENT_INFO[id].name} が解除されました`)
    return true
  }

  randomEvent() {
    const pool: EventId[] = ['mucusPlug', 'cuffLeak', 'agitation', 'bronchospasm']
    if (this.airway === 'intubated') pool.push('disconnect', 'ettObstruction')
    const id = pool[Math.floor(Math.random() * pool.length)]
    this.triggerEvent(id)
  }

  intervene(id: InterventionId): string {
    const name = INTERVENTION_INFO[id]
    switch (id) {
      case 'suction': {
        if (this.intubated()) {
          this.sLoad *= 0.25
          this.r = Math.max(0, this.r - 0.08)
          let msg = '気管吸引を実施'
          if (this.events.has('mucusPlug')) {
            this.resolveEvent('mucusPlug', '吸引')
            msg += '（粘稠な痰が多量に引けた）'
          } else if (this.events.has('ettObstruction')) {
            if (Math.random() < 0.5) {
              this.resolveEvent('ettObstruction', '吸引')
              msg += '（チューブ内の痰塊が除去された）'
            } else msg += '（吸引カテーテルの通過が悪い）'
          } else this.addLog('action', msg + `（分泌物: ${this.secretionLabel()}）`)
          return msg
        } else {
          this.sLoad *= 0.6
          this.addLog('action', '口腔・鼻腔吸引／排痰介助を実施')
          return '口腔・鼻腔吸引／排痰介助を実施'
        }
      }
      case 'chestDrain':
        if (!this.resolveEvent('pneumothorax', '胸腔ドレナージ')) this.addLog('action', '胸腔ドレナージ: 適応なし')
        return name
      case 'reconnect':
        if (!this.resolveEvent('disconnect', '回路再接続')) this.addLog('action', '回路は接続されています')
        return name
      case 'cuffAdjust':
        if (!this.resolveEvent('cuffLeak', 'カフ圧調整')) this.addLog('action', 'カフ圧は適正です（25cmH2O）')
        return name
      case 'tubeReposition':
        if (!this.resolveEvent('mainstem', 'チューブ位置調整')) this.addLog('action', 'チューブ位置は適正です')
        return name
      case 'tubeExchange':
        if (this.airway !== 'intubated') return name
        this.events.delete('ettObstruction')
        this.events.delete('cuffLeak')
        this.events.delete('mainstem')
        this.r = Math.max(0, this.r - 0.15)
        this.addLog('action', '気管チューブを入れ替え')
        return name
      case 'bronchodilator':
        this.bdUntil = this.t + 4 * 3600
        this.bdStart = this.t
        this.addLog('action', '気管支拡張薬を吸入')
        return name
      case 'fluid':
        this.fluidBoost = Math.min(7, this.fluidBoost + 1.4)
        this.addLog('action', '輸液ボーラス 500mL')
        if (this.events.has('hypovolemia') && this.fluidBoost >= 4) this.resolveEvent('hypovolemia', '輸液')
        return name
      case 'sedate':
        if (this.events.has('agitation')) this.resolveEvent('agitation', '鎮静薬投与')
        this.rass = Math.max(-5, this.rass - 1.5)
        this.rassTarget = Math.min(this.rassTarget, Math.round(this.rass))
        this.addLog('action', '鎮静薬ボーラス')
        return name
      case 'recruit':
        if (!this.intubated() || !this.connected() || !isVentMode(this.settings.mode)) return 'リクルートメント手技は挿管・人工呼吸中のみ実施できます'
        this.recruitUntil = this.t + 30
        this.addLog('action', 'リクルートメント手技（CPAP 40cmH2O 30秒）')
        return name
      case 'prone':
        this.prone = true
        this.addLog('action', '腹臥位へ体位変換')
        return name
      case 'supine':
        this.prone = false
        this.addLog('action', '仰臥位へ体位変換')
        return name
    }
    return name
  }

  secretionLabel(): string {
    const v = this.sLoad
    return v < 0.25 ? '少量' : v < 0.55 ? '中等量' : '多量'
  }

  setRassTarget(v: number) {
    this.rassTarget = clamp(Math.round(v), -5, 4)
    this.addLog('action', `鎮静目標 RASS ${this.rassTarget > 0 ? '+' : ''}${this.rassTarget}`)
  }

  setNa(dose: number) {
    this.na = clamp(dose, 0, 0.5)
    this.addLog('action', `ノルアドレナリン ${this.na.toFixed(2)} μg/kg/分`)
  }

  inspHold() {
    if (!this.ventActive()) return
    this.holdIReq = true
  }
  expHold() {
    if (!this.ventActive() || this.settings.mode === 'APRV' || isNppv(this.settings.mode)) return
    this.holdEReq = true
  }

  intubate(settings?: VentSettings) {
    const s = settings ?? this.lastInvasive ?? { ...this.settings, mode: 'VC-AC' as VentMode }
    this.airway = 'intubated'
    this.events.delete('selfExtubation')
    this.events.delete('disconnect')
    this.edemaOnset = null
    this.edemaLevel = 0
    this.extubatedAt = null
    this.r = Math.max(0, this.r - 0.1)
    this.settings = { ...s }
    this.lastInvasive = { ...s }
    this.vphase = 'exp'
    this.tPhase = 0
    this.breathStart = this.t
    if (this.rassTarget > -2) this.rassTarget = -2
    this.rass = Math.min(this.rass, -2)
    this.cuffLeakTested = null
    this.addLog('action', '気管挿管し人工呼吸を再開')
  }

  extubate(post: VentSettings) {
    if (this.airway !== 'intubated') return
    if (this.sbt?.active) this.stopSbt(true)
    this.airway = 'extubated'
    this.events.delete('ettObstruction')
    this.events.delete('cuffLeak')
    this.events.delete('mainstem')
    this.events.delete('disconnect')
    this.settings = { ...post }
    this.extubatedAt = this.t
    this.vphase = 'exp'
    this.tPhase = 0
    this.breathStart = this.t
    if (isNppv(post.mode)) this.kLeakEst = this.leakK()
    if (post.mode === 'HFNC') this.fio2Eff = post.fio2
    // 喉頭浮腫のリスク
    const leak = this.cuffLeakTested ?? this.ep.cuffLeak
    const risk = this.ep.edemaRisk + (leak < 110 ? 0.4 : 0)
    if (Math.random() < risk) this.edemaOnset = this.t + rnd(600, 1800)
    this.addLog('action', `抜管（抜管後: ${post.mode}）`)
  }

  cuffLeakTest(): number | null {
    if (!this.intubated()) return null
    const v = Math.max(0, this.ep.cuffLeak * rnd(0.85, 1.15))
    this.cuffLeakTested = v
    this.addLog('action', `カフリークテスト: ${v.toFixed(0)} mL`)
    return v
  }

  coughAssessment() {
    const c = this.ep.cough * (this.effectiveRass() >= -1 ? 1 : 0.4)
    const cough = c > 0.65 ? '強い' : c > 0.35 ? '中等度' : '弱い'
    const secretion = this.secretionLabel()
    this.coughAssessed = { cough, secretion }
    this.addLog('action', `咳嗽・分泌物評価: 咳嗽 ${cough}／分泌物 ${secretion}`)
    return this.coughAssessed
  }

  // ---- SBT
  startSbt(method: SbtMethod, minutes: number): string | null {
    if (!this.intubated()) return '挿管中のみ実施できます'
    if (this.sbt?.active) return 'すでにSBT実施中です'
    const prev = { ...this.settings }
    const s = { ...this.settings }
    if (method === 'psv') {
      s.mode = 'PSV'
      s.ps = 5
      s.peep = 5
    } else if (method === 'cpap') {
      s.mode = 'PSV'
      s.ps = 0
      s.peep = 5
    } else {
      s.mode = 'TPIECE'
    }
    s.fio2 = Math.min(prev.fio2, 0.5)
    this.applySettings(s)
    this.sbtTimers.clear()
    this.sbt = {
      active: true,
      method,
      start: this.t,
      duration: minutes * 60,
      baseline: { hr: this.hr, sbp: this.sbp, spo2: this.spo2, rr: this.rrPatient(), paco2: this.paco2 },
      rsbi: null,
      rsbiMeasuredAt: null,
      failReasons: [],
      result: 'running',
      savedSettings: prev,
      endedAt: null,
    }
    this.addLog('action', `SBT開始（${method === 'psv' ? 'PS 5 / PEEP 5' : method === 'cpap' ? 'CPAP 5' : 'Tピース'}・${minutes}分）`)
    return null
  }

  stopSbt(silent = false) {
    const sb = this.sbt
    if (!sb || !sb.active) return
    sb.active = false
    if (sb.result === 'running') sb.result = 'aborted'
    sb.endedAt = this.t
    if (sb.savedSettings && this.airway === 'intubated' && !silent) this.applySettings(sb.savedSettings)
    if (!silent) this.addLog('action', 'SBTを終了し元の設定に戻しました')
  }

  /** SBT成功後に設定を維持したまま終了（抜管へ進む） */
  finishSbtKeep() {
    if (this.sbt) this.sbt.active = false
  }

  sbtUpdate(dt: number) {
    const sb = this.sbt
    if (!sb || !sb.active) return
    const el = this.t - sb.start
    if (sb.rsbi === null && el >= 120) {
      const vt = this.avgPatientVt(60)
      const f = this.rrPatient()
      sb.rsbi = vt > 0.02 ? f / vt : 999
      sb.rsbiMeasuredAt = this.t
      this.addLog('info', `RSBI ${sb.rsbi.toFixed(0)} 回/分/L`)
    }
    const fail = (key: string, cond: boolean, sustain: number, label: string) => {
      const v = cond ? (this.sbtTimers.get(key) ?? 0) + dt : 0
      this.sbtTimers.set(key, v)
      if (cond && v >= sustain && !sb.failReasons.includes(label)) sb.failReasons.push(label)
    }
    if (el > 60) {
      fail('rr', this.rrPatient() > 35, 180, '呼吸数 > 35回/分が持続')
      fail('spo2', this.spo2 < 90, 90, 'SpO2 < 90% が持続')
      fail('hr', this.hr > 140 || this.hr > sb.baseline.hr * 1.2, 120, '心拍数 > 140 または 20%以上の上昇')
      fail('bp', this.sbp > 180 || this.sbp < 90, 120, '収縮期血圧 > 180 または < 90')
      fail('co2', this.paco2 > sb.baseline.paco2 + 10, 60, 'PaCO2 が 10mmHg 以上上昇')
      fail('distress', this.pmusPeakLast / Math.max(1, this.ep.pmax) > 0.5 || this.drive > 2.6, 150, '努力呼吸（呼吸補助筋の使用・不穏）')
      fail('apnea', el > 90 && this.t - (this.patBreaths[this.patBreaths.length - 1]?.t ?? 0) > 30, 0, '無呼吸')
    }
    if (sb.failReasons.length > 0) {
      sb.result = 'fail'
      sb.active = false
      sb.endedAt = this.t
      this.addLog('event', `SBT失敗: ${sb.failReasons.join('、')}`)
      if (sb.savedSettings && this.airway === 'intubated') {
        this.settings = { ...sb.savedSettings }
        this.vphase = 'exp'
        this.tPhase = 0
        this.addLog('action', '元の換気設定に戻しました')
      }
      return
    }
    if (el >= sb.duration) {
      sb.result = 'pass'
      sb.active = false
      sb.endedAt = this.t
      this.addLog('event', 'SBT成功（基準を満たしました）')
    }
  }

  avgPatientVt(win: number): number {
    let s = 0
    let c = 0
    for (let i = this.patBreaths.length - 1; i >= 0; i--) {
      const b = this.patBreaths[i]
      if (this.t - b.t > win) break
      s += b.vt
      c++
    }
    return c ? s / c : 0
  }

  /** 時間を飛ばした後に、呼吸の履歴・換気器のタイマーを現在時刻に合わせる */
  resyncAfterJump() {
    this.patBreaths = []
    this.breaths = []
    this.windowStart = this.t
    this.breathStart = this.t
    this.simvCycleStart = this.t
    this.vphase = 'exp'
    this.tPhase = 0
    this.backup = false
    this.pendingTrig = -1
    this.pendingMand = false
    this.effortTimes = []
    this.alarmCond.clear()
    this.ppList = []
  }

  // ---- 時間スキップ（病態経過）
  skipHours(hours: number): string | null {
    if (this.sbt?.active) return 'SBT実施中は時間を進められません（速度変更を使ってください）'
    if (this.arrest) return '心停止中です'
    const chunk = 0.1
    const n = Math.round(hours / chunk)
    const keep0 = this.settling
    this.settling = true
    // 現在の設定での呼吸筋負荷を反映させてから進める
    this.advance(45)
    this.skipping = true
    for (let i = 0; i < n; i++) {
      if (i > 0 && i % 20 === 0) {
        // 2時間ごとに呼吸パターンを再評価（病態の変化を反映）
        this.skipping = false
        this.baseP = computeParams(this.cfg, this.progress)
        this.updateEffective()
        this.resyncAfterJump()
        this.settleGas(40)
        this.skipping = true
      }
      const sec = chunk * 3600
      this.t += sec
      // 長期経過をまとめて進める
      const sub = 20
      for (let j = 0; j < sub; j++) this.longTermUpdate(sec / sub)
      this.rass = this.rassTarget
      this.lactate += (this.ep.lactateBase - this.lactate) * Math.min(1, sec / 3600 / 0.7)
      if (this.edemaOnset !== null && this.t > this.edemaOnset && !this.intubated()) this.edemaLevel = Math.min(1, this.edemaLevel + sec / 1500)
    }
    this.skipping = false
    // 呼吸パターン・ガス交換を新しい状態に合わせて落ち着かせる
    this.baseP = computeParams(this.cfg, this.progress)
    this.updateEffective()
    const keepSettling = keep0
    this.resyncAfterJump()
    this.settleGas(120)
    this.settling = keepSettling
    this.trendAcc = 0
    this.recordTrend()
    this.addLog('action', `時間経過 +${hours}時間`)
    return null
  }

  // ============================================================
  // スナップショット（UI表示用）
  // ============================================================
  snapshotVent() {
    const s = this.settings
    const bs = this.breaths
    const lb = this.lastBreath
    const t = this.t
    let pawInt = 0
    let dur = 0
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i]
      if (t - b.start > 30) break
      pawInt += b.pawInt
      dur += b.dur
    }
    const win = Math.min(60, Math.max(15, t - this.windowStart))
    let vteSum = 0
    let nSp = 0
    let nAll = 0
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i]
      if (b.start + b.dur < t - win) break
      vteSum += b.vte
      nAll++
      if (!b.mandatory) nSp++
    }
    const mve = (vteSum / 1000) * (60 / win)
    // 呼吸回数: 直近の呼吸間隔から算出（間隔が空けば減衰）
    const starts = bs.filter((b) => t - b.start <= 60).map((b) => b.start)
    if (this.breathStart > (starts[starts.length - 1] ?? -1)) starts.push(this.breathStart)
    let rrTot = (nAll * 60) / win
    if (starts.length >= 3) {
      const k = Math.min(5, starts.length - 1)
      const span = starts[starts.length - 1] - starts[starts.length - 1 - k]
      const meanI = span / k
      const sinceLast = t - starts[starts.length - 1]
      rrTot = span > 0 ? 60 / Math.max(meanI, sinceLast > meanI * 1.5 ? sinceLast : 0) : 0
    }
    const rrSpont = (nSp * 60) / win
    const base = isNppv(s.mode) ? s.epap : s.mode === 'APRV' ? s.pLow : s.peep
    const pp = this.pplatMeasured && t - this.pplatMeasured.t < 600 ? this.pplatMeasured : null
    const pt = this.peepTotMeasured && t - this.peepTotMeasured.t < 600 ? this.peepTotMeasured : null
    const crs = pp?.crs ?? null
    const raw = pp?.raw ?? null
    const ti = lb?.ti ?? 0
    const te = lb ? lb.dur - lb.ti : 0
    return {
      ppeak: lb ? lb.ppeak : 0,
      pmean: dur > 0 ? pawInt / dur : this.measPaw,
      peepSet: base,
      peepMeasured: lb ? lb.peepEnd : base,
      vti: lb ? lb.vti : 0,
      vte: lb ? lb.vte : 0,
      mve,
      rrTot,
      rrSpont,
      ti,
      ie: ti > 0 && te > 0 ? (te / ti >= 1 ? `1:${(te / ti).toFixed(1)}` : `${(ti / te).toFixed(1)}:1`) : '---',
      leak: lb ? lb.leakAvg : 0,
      vtPerKg: lb ? lb.vte / this.ibw : 0,
      pplat: pp ? pp.v : null,
      pplatAge: pp ? t - pp.t : null,
      crs,
      raw,
      drivingP: pp ? pp.dp : null,
      peepTot: pt ? pt.v : null,
      peepTotAge: pt ? t - pt.t : null,
      autoPeep: pt ? pt.v - base : null,
      tau: crs !== null && raw !== null ? (crs / 1000) * raw : null,
      backup: this.backup,
      phase: this.vphase,
      prvcP: s.mode === 'PRVC' ? this.prvcP : null,
      endExpFlow: this.endExpFlow * 60,
    }
  }

  snapshot(): Snapshot {
    const v = this.snapshotVent()
    const p = this.ep
    const counts: Record<AsyncType, number> = {
      ineffective: 0,
      double: 0,
      autoTrigger: 0,
      delayedCycle: 0,
      prematureCycle: 0,
      flowStarvation: 0,
    }
    const recentA = this.asyncs.filter((a) => this.t - a.t < 120)
    for (const a of recentA) counts[a.type]++
    const nb = this.breaths.filter((b) => this.t - b.start < 120).length
    const asyncIdx = nb + counts.ineffective > 0 ? (recentA.length / (nb + counts.ineffective)) * 100 : 0
    const fi = this.fio2Eff
    const vtSp = this.avgPatientVt(30)
    const capOK = this.capnoAvailable()
    return {
      t: this.t,
      elapsed: this.t - this.t0,
      mode: this.settings.mode,
      airway: this.airway,
      connected: this.connected(),
      vent: v,
      vitals: {
        hr: this.arrest ? 0 : this.hr,
        sbp: this.arrest ? 0 : this.sbp,
        dbp: this.arrest ? 0 : this.dbp,
        map: this.map,
        spo2: this.arrest || this.map < 30 ? NaN : this.spo2,
        etco2: capOK ? this.etco2Disp : NaN,
        rr: this.rrPatient(),
        temp: p.temp,
        cvp: this.rap,
        ppv: this.ppv(),
        arrest: this.arrest,
      },
      gas: {
        pao2: this.pao2,
        paco2: this.paco2,
        ph: this.ph,
        hco3: this.hco3,
        be: this.be,
        sao2: this.sao2 * 100,
        lactate: this.lactate,
        pf: this.pao2 / fi,
        aado2: pio2(fi) - this.paco2 / 0.8 - this.pao2,
        vdvt: this.vdvt,
        shunt: this.shunt,
        fio2Eff: fi,
        va: this.va,
        svo2: this.svo2 * 100,
        co: this.co,
        do2: this.co * this.cao2 * 10,
      },
      patient: {
        rass: this.effectiveRass(),
        rassTarget: this.rassTarget,
        drive: this.drive,
        pmusPeak: this.n.phase === 'idle' ? 0 : this.pmusPeakLast,
        p01: this.n.phase === 'idle' ? 0 : this.pmusPeakLast * Math.sin((Math.PI / 2) * (0.1 / this.n.ti)),
        fatigue: this.fatigue,
        pmaxEff: p.pmax,
        progress: this.progress,
        recruit: this.r,
        secretion: this.sLoad,
        diaphragm: this.dStr,
        ptp: this.ptiEma,
        rsbi: vtSp > 0.02 ? this.rrPatient() / vtSp : null,
        vtSpont: vtSp * 1000,
        rrPatient: this.rrPatient(),
        ptiPct: this.ptiEma * 100,
        edema: this.edemaLevel,
        prone: this.prone,
        na: this.na,
        fluid: this.fluidBoost,
      },
      async: { index: asyncIdx, counts, recent: recentA },
      alarms: [...this.activeAlarms],
      muted: this.t < this.muteUntil,
      events: [...this.events.keys()],
      sbt: this.sbt ? { ...this.sbt } : null,
      ibw: this.ibw,
      recruiting: this.recruitUntil > this.t,
    }
  }

  muteAlarms(sec = 120) {
    this.muteUntil = this.t + sec
  }

  resuscitate() {
    this.arrest = false
    this.hypoxTime = 0
    this.hr = this.ep.hr0
    this.map = this.ep.map0 * 0.8
    this.addLog('action', '蘇生（心拍再開）')
  }
}
