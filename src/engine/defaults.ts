import type { AlarmSettings, DiseaseId, VentMode, VentSettings } from './types'

export const DEFAULT_SETTINGS: VentSettings = {
  mode: 'VC-AC',
  fio2: 0.5,
  peep: 5,
  vt: 450,
  rr: 14,
  peakFlow: 50,
  flowPattern: 'decel',
  pause: 0,
  pinsp: 15,
  ti: 1.0,
  rise: 0.15,
  ps: 10,
  ets: 25,
  trigType: 'flow',
  trigFlow: 2,
  trigPressure: 2,
  pmaxPrvc: 35,
  pHigh: 28,
  pLow: 5,
  tHigh: 4.5,
  tLow: 0.5,
  ipap: 12,
  epap: 5,
  nppvRR: 12,
  nppvTi: 1.0,
  nppvTiMax: 1.5,
  maskFit: 0,
  hfncFlow: 50,
  o2Device: 'mask',
  o2Flow: 5,
}

export const DEFAULT_ALARMS: AlarmSettings = {
  pHigh: 40,
  pLow: 8,
  mvHigh: 16,
  mvLow: 4,
  vtLow: 250,
  vtHigh: 900,
  rrHigh: 35,
  apnea: 20,
  spo2Low: 90,
  hrHigh: 130,
  hrLow: 50,
  sbpLow: 90,
  sbpHigh: 180,
  etco2High: 55,
  etco2Low: 25,
}

/** 病態別のアラーム初期値 */
export function initialAlarmsFor(disease: DiseaseId): AlarmSettings {
  const a = { ...DEFAULT_ALARMS }
  if (disease === 'asthma' || disease === 'copd') a.pHigh = 50
  if (disease === 'copd') {
    a.etco2High = 65
    a.etco2Low = 18
    a.spo2Low = 86
  }
  if (disease === 'ards' || disease === 'pneumonia') {
    a.etco2High = 65
    a.etco2Low = 18
  }
  return a
}

/** 病態別の初期設定（自由操作モード開始時） */
export function initialSettingsFor(disease: DiseaseId, ibw: number): VentSettings {
  const s: VentSettings = { ...DEFAULT_SETTINGS }
  const r10 = (v: number) => Math.round(v / 10) * 10
  s.vt = r10(7 * ibw)
  s.rr = 16
  switch (disease) {
    case 'ards':
      s.vt = r10(6 * ibw)
      s.peep = 10
      s.fio2 = 0.7
      s.rr = 22
      s.peakFlow = 60
      break
    case 'pneumonia':
      s.vt = r10(7 * ibw)
      s.peep = 8
      s.fio2 = 0.6
      s.rr = 20
      s.peakFlow = 60
      break
    case 'copd':
      s.vt = r10(7 * ibw)
      s.rr = 12
      s.peakFlow = 70
      s.fio2 = 0.35
      break
    case 'asthma':
      s.vt = r10(6.5 * ibw)
      s.rr = 12
      s.peakFlow = 70
      s.flowPattern = 'square'
      s.fio2 = 0.4
      s.peep = 3
      break
    case 'obesity':
      s.peep = 10
      s.fio2 = 0.5
      s.rr = 20
      s.peakFlow = 60
      break
    case 'neuromuscular':
      s.fio2 = 0.3
      break
    case 'postop':
      s.fio2 = 0.4
      s.rr = 14
      break
  }
  return s
}

export interface ModeInfo {
  id: VentMode
  label: string
  short: string
  invasive: boolean
  description: string
}

export const MODES: ModeInfo[] = [
  {
    id: 'VC-AC',
    label: 'VC-A/C（従量式 補助/調節）',
    short: 'VC-A/C',
    invasive: true,
    description:
      '設定した1回換気量を設定した吸気流量で送ります。換気量は保証されますが、気道内圧は肺のコンプライアンスと気道抵抗で決まります。自発呼吸でトリガーされた呼吸も同じ換気量になります。',
  },
  {
    id: 'PC-AC',
    label: 'PC-A/C（従圧式 補助/調節）',
    short: 'PC-A/C',
    invasive: true,
    description:
      '設定した吸気圧を設定した吸気時間だけかけます。気道内圧は一定ですが、1回換気量はコンプライアンス・気道抵抗・患者の吸気努力で変化します。',
  },
  {
    id: 'PRVC',
    label: 'PRVC（圧制御従量式）',
    short: 'PRVC',
    invasive: true,
    description:
      '従圧式の波形で、目標の1回換気量に近づくよう吸気圧を1呼吸ごとに自動調整します（1回あたり最大±3cmH2O）。患者の吸気努力が強いと吸気圧が下がり、補助が減ってしまう点に注意します。',
  },
  {
    id: 'SIMV-VC',
    label: 'SIMV（VC）＋PS',
    short: 'SIMV-VC',
    invasive: true,
    description:
      '設定回数の強制換気（従量式）を自発呼吸に同期させて送り、それ以外の自発呼吸はプレッシャーサポートで補助します。',
  },
  {
    id: 'SIMV-PC',
    label: 'SIMV（PC）＋PS',
    short: 'SIMV-PC',
    invasive: true,
    description:
      '設定回数の強制換気（従圧式）を自発呼吸に同期させて送り、それ以外の自発呼吸はプレッシャーサポートで補助します。',
  },
  {
    id: 'PSV',
    label: 'PSV / CPAP',
    short: 'PSV/CPAP',
    invasive: true,
    description:
      '患者の吸気でトリガーし、設定したサポート圧をかけ、吸気流量がピークの設定％（ETS）まで下がると呼気に移ります。PS=0 で CPAP になります。無呼吸時はバックアップ換気（PC）が作動します。',
  },
  {
    id: 'APRV',
    label: 'APRV',
    short: 'APRV',
    invasive: true,
    description:
      '高いCPAP（P high）を長時間保ち、短時間だけ低圧（P low）に開放して換気します。どちらの圧でも自発呼吸ができます。T low は呼気流量がピークの50〜75％に低下した時点で終わるよう設定するのが一般的です。',
  },
  {
    id: 'TPIECE',
    label: 'Tピース（補助なし）',
    short: 'Tピース',
    invasive: true,
    description:
      '人工呼吸器から外し、気管チューブに酸素を流すだけの状態です。SBT（自発呼吸トライアル）で用います。気管チューブの抵抗分の仕事量がかかります。',
  },
  {
    id: 'NPPV-ST',
    label: 'NPPV（S/T）',
    short: 'NPPV S/T',
    invasive: false,
    description:
      'マスクによる非侵襲的陽圧換気。自発呼吸にはIPAP、呼気にはEPAPをかけ、設定回数を下回るとタイムド呼吸を送ります。マスクリークの管理が重要です。',
  },
  {
    id: 'NPPV-CPAP',
    label: 'NPPV（CPAP）',
    short: 'NPPV CPAP',
    invasive: false,
    description: 'マスクで一定の陽圧をかけます。換気の補助はありません。',
  },
  {
    id: 'HFNC',
    label: '高流量鼻カニュラ（HFNC）',
    short: 'HFNC',
    invasive: false,
    description:
      '加温加湿した高流量の酸素を鼻から投与します。患者の吸気流量を上回る流量で安定したFiO2を保ち、上気道の死腔を洗い出し、わずかな呼気終末陽圧（流量10L/分あたり約0.5cmH2O）を生じます。',
  },
  {
    id: 'O2',
    label: '通常の酸素療法',
    short: '酸素',
    invasive: false,
    description:
      '鼻カニュラ・簡易酸素マスク・リザーバー付きマスク。実際のFiO2は患者の分時換気量によって変わります（呼吸が速いほど室内気を多く吸い込み、FiO2は下がります）。',
  },
]

export function modeInfo(m: VentMode): ModeInfo {
  return MODES.find((x) => x.id === m) ?? MODES[0]
}
