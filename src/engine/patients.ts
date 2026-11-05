import type { DiseaseId, DiseasePreset, PatientConfig, PatientParams, Severity } from './types'

/** 基準値（正常肺・挿管鎮静下、IBW 66kg 相当） */
export const BASE_PARAMS: PatientParams = {
  cOpen: 55,
  cClosed: 50,
  frcOpen: 2.2,
  frcClosed: 2.0,
  rInsp: 8,
  rExp: 9,
  rEtt: 4,
  pcrit: 0,
  pover: 33,
  kover: 0.04,
  cwFrac: 0.35,
  ppl0: 3,
  shuntFixed: 0.03,
  shuntRec: 0.04,
  popen: 16,
  pclose: 2,
  rw: 3,
  lowVQ: 0.03,
  vq: 0.3,
  vdAnatPerKg: 2.2,
  vdAlv: 0.18,
  vco2: 200,
  vo2: 250,
  hb: 12.5,
  hco3: 24,
  paco2Set: 40,
  temp: 36.8,
  driveBase: 8.5,
  fBase: 14,
  tiRatio: 0.35,
  pmax: 75,
  secretion: 0.2,
  cough: 0.85,
  cuffLeak: 220,
  edemaRisk: 0.03,
  hr0: 78,
  map0: 86,
  co0: 5.0,
  pmsf0: 12,
  lactateBase: 1.0,
  pain: 0,
}

export const DISEASES: Record<DiseaseId, DiseasePreset> = {
  normal: {
    id: 'normal',
    name: '正常肺',
    description: '肺に病変のない患者（例: 意識障害による気道保護目的の挿管）。比較の基準として使用します。',
    recoveryTau: 6,
    acute: {},
    recovered: {},
  },
  ards: {
    id: 'ards',
    name: 'ARDS',
    description:
      '急性呼吸窮迫症候群。含気肺（baby lung）が小さく、コンプライアンス低下・大量のシャント・肺胞死腔の増加を示します。PEEPとリクルートメントで酸素化が改善し、高いプラトー圧では過膨張が起こります。',
    recoveryTau: 110,
    acute: {
      cOpen: 40,
      cClosed: 20,
      frcOpen: 1.6,
      frcClosed: 0.8,
      rInsp: 11,
      rExp: 12,
      pover: 27,
      kover: 0.05,
      cwFrac: 0.22,
      ppl0: 6,
      shuntFixed: 0.1,
      shuntRec: 0.36,
      popen: 30,
      pclose: 13,
      rw: 4.5,
      lowVQ: 0.1,
      vq: 0.25,
      vdAlv: 0.28,
      vco2: 230,
      vo2: 280,
      temp: 38.2,
      driveBase: 9,
      fBase: 26,
      tiRatio: 0.32,
      hr0: 104,
      map0: 76,
      co0: 6.0,
      pmsf0: 11,
      lactateBase: 1.8,
      secretion: 0.3,
      cuffLeak: 180,
    },
    recovered: { cOpen: 50, cClosed: 44, shuntFixed: 0.04, shuntRec: 0.05, vdAlv: 0.12, pmax: 60 },
  },
  copd: {
    id: 'copd',
    name: 'COPD急性増悪',
    description:
      '気道抵抗（特に呼気）の上昇と呼気流量制限により、動的過膨張と内因性PEEP（auto-PEEP）が生じます。慢性高二酸化炭素血症のため HCO3- が代償性に上昇しています。',
    recoveryTau: 80,
    acute: {
      cOpen: 62,
      cClosed: 60,
      frcOpen: 3.6,
      frcClosed: 3.5,
      rInsp: 19,
      rExp: 27,
      pcrit: 7,
      pover: 30,
      cwFrac: 0.45,
      shuntFixed: 0.04,
      shuntRec: 0.03,
      lowVQ: 0.3,
      vq: 0.2,
      vdAlv: 0.36,
      hco3: 31,
      paco2Set: 55,
      driveBase: 9,
      fBase: 22,
      tiRatio: 0.4,
      pmax: 42,
      secretion: 0.45,
      cough: 0.5,
      hr0: 100,
      map0: 88,
    },
    recovered: {
      cOpen: 62,
      cClosed: 60,
      frcOpen: 3.4,
      frcClosed: 3.3,
      rInsp: 12,
      rExp: 15,
      pcrit: 4,
      cwFrac: 0.42,
      lowVQ: 0.14,
      vq: 0.25,
      vdAlv: 0.26,
      hco3: 30,
      paco2Set: 50,
      fBase: 18,
      pmax: 52,
      secretion: 0.35,
      cough: 0.6,
      hr0: 88,
    },
  },
  asthma: {
    id: 'asthma',
    name: '気管支喘息（重積発作）',
    description:
      '吸気・呼気ともに気道抵抗が著明に上昇し、最高気道内圧の上昇とauto-PEEPを示します。プラトー圧との差（Ppeak−Pplat）が大きいのが特徴です。',
    recoveryTau: 30,
    acute: {
      cOpen: 48,
      cClosed: 46,
      frcOpen: 3.2,
      frcClosed: 3.1,
      rInsp: 30,
      rExp: 36,
      pcrit: 2,
      cwFrac: 0.4,
      lowVQ: 0.22,
      vq: 0.25,
      vdAlv: 0.22,
      driveBase: 10,
      fBase: 26,
      tiRatio: 0.36,
      hr0: 116,
      map0: 84,
      secretion: 0.4,
      vco2: 220,
    },
    recovered: {},
  },
  pneumonia: {
    id: 'pneumonia',
    name: '重症肺炎（敗血症）',
    description:
      '浸潤影による固定性シャントが主体で、PEEPへの反応はARDSより限定的です。発熱でCO2産生と酸素消費が増え、敗血症による末梢血管抵抗の低下と相対的な循環血液量の減少を伴います。分泌物が多く、気道閉塞を起こしやすい病態です。',
    recoveryTau: 80,
    acute: {
      cOpen: 38,
      cClosed: 28,
      frcOpen: 1.8,
      frcClosed: 1.4,
      rInsp: 10,
      rExp: 11,
      shuntFixed: 0.2,
      shuntRec: 0.16,
      popen: 26,
      pclose: 9,
      lowVQ: 0.14,
      vdAlv: 0.16,
      vco2: 245,
      vo2: 300,
      temp: 38.9,
      driveBase: 9.5,
      fBase: 26,
      hr0: 114,
      map0: 68,
      co0: 6.8,
      pmsf0: 10,
      lactateBase: 2.8,
      secretion: 0.75,
      cough: 0.5,
      hco3: 21,
    },
    recovered: { secretion: 0.3 },
  },
  obesity: {
    id: 'obesity',
    name: '高度肥満（BMI 40）',
    description:
      '胸壁コンプライアンスの低下と腹圧上昇により、仰臥位で背側肺が虚脱します（PEEP反応性の無気肺）。FRCが小さく酸素消費量が多いため、無呼吸時に急速に低酸素になります。気道内圧の多くが胸壁に費やされるため、Pplatが高くても経肺圧は高くないことがあります。',
    defaultWeight: 116,
    recoveryTau: 40,
    acute: {
      cOpen: 44,
      cClosed: 26,
      frcOpen: 1.7,
      frcClosed: 0.9,
      rInsp: 10,
      rExp: 11,
      cwFrac: 0.55,
      ppl0: 11,
      pover: 39,
      shuntFixed: 0.04,
      shuntRec: 0.26,
      popen: 22,
      pclose: 10,
      rw: 3.5,
      lowVQ: 0.08,
      hco3: 27,
      paco2Set: 44,
      pmax: 60,
      hr0: 92,
      map0: 94,
      co0: 6.5,
      fBase: 20,
      cuffLeak: 160,
      edemaRisk: 0.1,
    },
    recovered: {
      cOpen: 46,
      cClosed: 30,
      frcOpen: 1.8,
      frcClosed: 1.1,
      cwFrac: 0.52,
      ppl0: 10,
      pover: 39,
      shuntRec: 0.18,
      popen: 21,
      pclose: 9,
      hco3: 27,
      paco2Set: 44,
      pmax: 65,
      hr0: 84,
      map0: 92,
      co0: 6.5,
      fBase: 18,
      cuffLeak: 170,
      edemaRisk: 0.08,
    },
  },
  neuromuscular: {
    id: 'neuromuscular',
    name: '神経筋疾患（GBS・MGクリーゼ等）',
    description:
      '肺自体はほぼ正常ですが、呼吸筋力（最大吸気圧）と咳嗽力が著しく低下しています。自発呼吸では浅く速い呼吸となり、呼吸筋疲労から高CO2血症をきたします。抜管後は排痰困難が問題となります。',
    recoveryTau: 220,
    acute: {
      cOpen: 50,
      cClosed: 40,
      frcOpen: 2.0,
      frcClosed: 1.6,
      shuntRec: 0.1,
      popen: 18,
      pclose: 6,
      pmax: 16,
      driveBase: 8.5,
      fBase: 22,
      secretion: 0.6,
      cough: 0.12,
      hr0: 92,
    },
    recovered: { pmax: 55, cough: 0.6, secretion: 0.3 },
  },
  postop: {
    id: 'postop',
    name: '術後（上腹部手術後）',
    description:
      '全身麻酔と上腹部手術により下葉背側の無気肺が生じ、軽度の酸素化障害を示します。麻酔薬の残存で呼吸ドライブが低下していますが数時間で回復します。創部痛のため覚醒時は浅く速い呼吸になりがちです。',
    recoveryTau: 8,
    acute: {
      cOpen: 48,
      cClosed: 34,
      frcOpen: 1.9,
      frcClosed: 1.4,
      cwFrac: 0.42,
      shuntFixed: 0.03,
      shuntRec: 0.2,
      popen: 20,
      pclose: 7,
      driveBase: 5,
      pmax: 55,
      pain: 1,
      cough: 0.5,
      secretion: 0.3,
      hr0: 90,
      map0: 82,
      temp: 36.4,
    },
    recovered: { pain: 0.3, cough: 0.75, shuntRec: 0.06 },
  },
}

export const SEVERITY_FACTOR: Record<Severity, number> = {
  mild: 0.6,
  moderate: 1.0,
  severe: 1.4,
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  mild: '軽症',
  moderate: '中等症',
  severe: '重症',
}

/** 理想体重（IBW） */
export function idealBodyWeight(sex: 'male' | 'female', heightCm: number): number {
  const base = sex === 'male' ? 50 : 45.5
  return Math.max(30, base + 0.91 * (heightCm - 152.4))
}

/** 病態・重症度・経過（progress 1→0）から現在の患者パラメータを算出 */
export function computeParams(cfg: PatientConfig, progress: number): PatientParams {
  const preset = DISEASES[cfg.disease]
  const sev = SEVERITY_FACTOR[cfg.severity]
  const acute: PatientParams = { ...BASE_PARAMS, ...preset.acute }
  const rec: PatientParams = { ...BASE_PARAMS, ...preset.recovered }
  const k = sev * progress
  const out = { ...BASE_PARAMS }
  for (const key of Object.keys(BASE_PARAMS) as (keyof PatientParams)[]) {
    out[key] = rec[key] + (acute[key] - rec[key]) * k
  }
  // 体格補正（IBWでコンプライアンス・FRCを、実体重で代謝をスケール）
  const ibw = idealBodyWeight(cfg.sex, cfg.height)
  const sz = ibw / 66
  out.cOpen *= sz
  out.cClosed *= sz
  out.frcOpen *= sz
  out.frcClosed *= sz
  const met = Math.pow(cfg.weight / 70, 0.75)
  out.vco2 *= met
  out.vo2 *= met
  // 発熱による代謝亢進（1℃あたり約10%）
  const feverF = 1 + 0.1 * Math.max(0, out.temp - 37)
  out.vco2 *= feverF
  out.vo2 *= feverF
  // 女性は気道がやや細い
  if (cfg.sex === 'female') {
    out.rInsp *= 1.1
    out.rExp *= 1.1
    out.hb -= 1
  }
  // 循環血液量
  if (cfg.volumeStatus === 'low') out.pmsf0 -= 3
  if (cfg.volumeStatus === 'high') out.pmsf0 += 4
  // 範囲制限
  out.cOpen = Math.max(10, out.cOpen)
  out.cClosed = Math.max(7, Math.min(out.cOpen, out.cClosed))
  out.frcClosed = Math.max(0.4, Math.min(out.frcOpen, out.frcClosed))
  out.shuntFixed = clamp(out.shuntFixed, 0, 0.6)
  out.shuntRec = clamp(out.shuntRec, 0, 0.7 - out.shuntFixed)
  out.lowVQ = clamp(out.lowVQ, 0, 0.45)
  out.vdAlv = clamp(out.vdAlv, 0, 0.6)
  out.pmax = Math.max(8, out.pmax)
  out.cough = clamp(out.cough, 0, 1)
  out.secretion = clamp(out.secretion, 0, 1)
  out.pain = clamp(out.pain, 0, 1)
  out.pcrit = Math.max(0, out.pcrit)
  out.map0 = Math.max(55, out.map0)
  return out
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
