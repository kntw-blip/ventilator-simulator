import type { Simulator, Snapshot } from '../engine/simulator'
import { isNppv } from '../engine/simulator'
import { DEFAULT_SETTINGS } from '../engine/defaults'
import type { PatientConfig, VentSettings } from '../engine/types'

export interface ScenarioCtx {
  sim: Simulator
  snap: Snapshot
  stepStart: number
}

export interface Step {
  title: string
  instruction: string
  hint: string
  feedback: string
  check: (c: ScenarioCtx) => boolean
  /** 条件を満たし続ける必要のある時間（シミュレーション秒） */
  hold?: number
  onEnter?: (sim: Simulator) => void
}

export interface Scenario {
  id: string
  title: string
  summary: string
  goals: string[]
  patient: PatientConfig
  settings: (ibw: number) => VentSettings
  airway: 'intubated' | 'extubated'
  rass: number
  progress?: number
  hideEvents?: boolean
  steps: Step[]
}

const r10 = (v: number) => Math.round(v / 10) * 10
const male = (over: Partial<PatientConfig>): PatientConfig => ({ disease: 'normal', severity: 'moderate', sex: 'male', height: 170, weight: 65, volumeStatus: 'normal', ...over })
const measuredSince = (m: { t: number } | null, t0: number) => !!m && m.t >= t0
const abgSince = (sim: Simulator, t0: number) => sim.abgs.filter((a) => a.t >= t0).at(-1)

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------
  {
    id: 'ards',
    title: 'ARDS：肺保護換気の導入',
    summary: '肺炎から中等症ARDSになった男性。救急外来で挿管され、1回換気量 10 mL/kg・PEEP 5 で ICU に入室しました。',
    goals: ['1回換気量を理想体重で設定する', 'プラトー圧・駆動圧を測定して評価する', 'PEEP/FiO2 で酸素化を最適化する', '許容的高CO2血症を理解する'],
    patient: male({ disease: 'ards', height: 172 }),
    settings: (ibw) => ({ ...DEFAULT_SETTINGS, mode: 'VC-AC', vt: r10(ibw * 10), rr: 14, peep: 5, fio2: 0.6, peakFlow: 50 }),
    airway: 'intubated',
    rass: -4,
    steps: [
      {
        title: '1回換気量を見直す',
        instruction: '身長から理想体重（IBW）を求め、1回換気量を 6 mL/kg IBW に設定して「確定」してください（従量式のまま）。',
        hint: '男性の IBW = 50 + 0.91 ×（身長 − 152.4）。身長172cm なら約 67.8 kg、6 mL/kg ≒ 410 mL です。設定ノブの単位欄に mL/kg が表示されます。',
        feedback: 'ARDSNet の研究では、6 mL/kg IBW の低容量換気は 12 mL/kg に比べて死亡率を下げました。体重は「実体重」ではなく「理想体重」で計算します。肺の大きさは身長で決まるためです。',
        check: ({ sim }) => ['VC-AC', 'PRVC', 'SIMV-VC'].includes(sim.settings.mode) && sim.settings.vt / sim.ibw >= 5.5 && sim.settings.vt / sim.ibw <= 6.5,
      },
      {
        title: '換気回数を上げる',
        instruction: '換気量を減らした分、分時換気量が減りました。換気回数を 20 回/分以上に上げてください。',
        hint: '低容量換気では死腔の割合が増えるため CO2 が上がりやすくなります。ARDSNet プロトコルでは最大 35 回/分まで許容されます。',
        feedback: '換気回数を上げると分時換気量は回復しますが、呼気時間が短くなります。流量波形で呼気終末にゼロに戻っているか（auto-PEEP がないか）を必ず確認しましょう。',
        check: ({ sim }) => sim.settings.rr >= 20,
      },
      {
        title: 'プラトー圧を測る',
        instruction: '「吸気ポーズ（Pplat測定）」を押してプラトー圧を測定し、30 cmH2O 以下であることを確認してください。',
        hint: 'Pplat は気流のない状態の肺胞内圧で、肺にかかる負荷の指標です。30 を超える場合は換気量をさらに減らします（最小 4 mL/kg）。',
        feedback: '最高気道内圧は気道抵抗の影響を含みますが、プラトー圧は肺と胸壁の硬さだけを反映します。肺保護の目標は Pplat ≤ 30 cmH2O です。',
        check: ({ sim, stepStart, snap }) => measuredSince(sim.pplatMeasured, stepStart) && (snap.vent.pplat ?? 99) <= 30,
      },
      {
        title: '酸素化を最適化する',
        instruction: 'PEEP と FiO2 を調整し、FiO2 0.6 以下で SpO2 88〜95% を 1 分間維持してください。必要ならリクルートメント手技も使えます（急変・処置タブ）。',
        hint: 'ARDSNet の PEEP/FiO2 表（高PEEP）では FiO2 0.5 で PEEP 16〜18、0.6 で PEEP 20 が目安です。PEEP を上げたら血圧も見てください。',
        feedback: 'PEEP で虚脱した肺胞を開けるとシャントが減り、同じ FiO2 でも SpO2 が上がります。ただし PEEP を上げすぎると過膨張・静脈還流の低下を起こします。PEEP の効果は「酸素化」「コンプライアンス（駆動圧）」「血圧」の3点で評価します。',
        check: ({ sim, snap }) => sim.settings.fio2 <= 0.6 && snap.vitals.spo2 >= 88 && snap.vitals.spo2 <= 95,
        hold: 60,
      },
      {
        title: '駆動圧を評価する',
        instruction: 'もう一度プラトー圧を測定し、駆動圧（ΔP = Pplat − PEEP）が 15 cmH2O 以下であることを確認してください。',
        hint: '駆動圧は 1回換気量 ÷ コンプライアンス です。PEEP でリクルートされればコンプライアンスが上がり、駆動圧は下がります。',
        feedback: '駆動圧は ARDS の予後と最も強く関連する換気指標とされます。PEEP を上げて駆動圧が下がるなら「リクルート」、上がるなら「過膨張」のサインです。',
        check: ({ sim, stepStart, snap }) => measuredSince(sim.pplatMeasured, stepStart) && (snap.vent.drivingP ?? 99) <= 15,
      },
      {
        title: '血液ガスで評価する',
        instruction: '数分待ってから（速度 ×20 が便利です）動脈血ガスを採取し、pH ≥ 7.25 を確認してください。',
        hint: 'CO2 は設定変更から定常状態になるまで十数分かかります。pH が低ければ換気回数を上げます（auto-PEEP に注意）。',
        feedback: 'ARDS では肺保護を優先し、pH 7.25〜7.30 程度までの高CO2血症を許容します（permissive hypercapnia）。お疲れさまでした。',
        check: ({ sim, stepStart }) => {
          const a = abgSince(sim, stepStart)
          return !!a && a.ph >= 7.25
        },
      },
    ],
  },
  // ------------------------------------------------------------
  {
    id: 'copd',
    title: 'COPD増悪：auto-PEEPとトリガー不良',
    summary: 'COPD急性増悪で挿管された男性。挿管直後から血圧が下がり気味で、患者の吸気努力に呼吸器が反応していないことがあります。',
    goals: ['呼気ポーズで auto-PEEP を測定する', '呼気時間を延ばして動的過膨張を減らす', '外因性PEEP でトリガー不良を改善する', '慢性高CO2血症の目標値を理解する'],
    patient: male({ disease: 'copd' }),
    settings: (ibw) => ({ ...DEFAULT_SETTINGS, mode: 'VC-AC', vt: r10(ibw * 8), rr: 20, peep: 0, fio2: 0.4, peakFlow: 40, flowPattern: 'decel' }),
    airway: 'intubated',
    rass: -2,
    steps: [
      {
        title: 'auto-PEEP を測定する',
        instruction: '流量波形で、呼気の終わりに流量がゼロに戻っているか観察してください。次に「呼気ポーズ（総PEEP測定）」で総PEEPを測定します。',
        hint: '呼気ポーズ中は弁が閉じ、肺胞内圧が回路で測れるようになります。総PEEP − 設定PEEP = auto-PEEP です。',
        feedback: '呼気が終わる前に次の吸気が始まり、肺に空気が溜まっています（動的過膨張）。COPD では気道の呼気流量制限のため、呼気に時間がかかります。auto-PEEP は胸腔内圧を上げて血圧を下げ、吸気努力の負担を増やします。',
        check: ({ sim, stepStart }) => measuredSince(sim.peepTotMeasured, stepStart),
      },
      {
        title: '呼気時間を延ばす',
        instruction: '換気回数を下げる、吸気流量を上げる、換気量を減らす、のいずれか（または組み合わせ）で呼気時間を延ばし、再測定した総PEEPを 10 cmH2O 以下にしてください。',
        hint: '最も効果が大きいのは換気回数を下げることです（例: 12 回/分）。吸気流量を 60〜80 L/分に上げると吸気時間が短くなります。I:E 比の変化にも注目しましょう。',
        feedback: '呼気時間が長くなり、動的過膨張が減りました。ただし COPD では気道が呼気中に虚脱するため（流量制限）、どれだけ呼気時間を延ばしても一定の内因性PEEPが残ります。',
        check: ({ sim, stepStart, snap }) => measuredSince(sim.peepTotMeasured, stepStart) && (snap.vent.peepTot ?? 99) <= 10,
      },
      {
        title: 'トリガー不良を減らす',
        instruction: '患者の吸気努力が呼吸器に届かない「ミストリガー」が残っています。外因性PEEPを総PEEPの約 70〜80% に設定し、ミストリガーを 2分間で 3回未満にしてください。',
        hint: '流量制限がある場合、内因性PEEP を超えない外因性PEEP は肺の過膨張を増やさずに、トリガーに必要な吸気努力を減らします（ウォーターフォール効果）。',
        feedback: '外因性PEEP によって、患者が吸気を始めるために打ち消さなければならない圧の差が小さくなり、トリガーしやすくなりました。総PEEP がほとんど変わらないことも確認してみてください。',
        check: ({ sim, snap }) => sim.settings.peep >= 4 && snap.async.counts.ineffective < 3,
        hold: 60,
      },
      {
        title: '目標の PaCO2',
        instruction: '速度を上げて 10 分ほど経過させ、動脈血ガスを採取してください。pH 7.30 以上、かつ PaCO2 が下がりすぎていない（45 以上）ことを確認します。',
        hint: 'この患者の普段の PaCO2 は 50〜55 mmHg、HCO3- は約 31 mmol/L です。正常値の 40 まで下げると高度のアルカレミアになります。',
        feedback: '慢性高CO2血症の患者では、普段の PaCO2 を目標にします。過換気にすると代償性に上昇した HCO3- のため pH が大きく上がり、抜管後に呼吸ドライブが不足する原因にもなります。',
        check: ({ sim, stepStart }) => {
          const a = abgSince(sim, stepStart)
          return !!a && a.ph >= 7.3 && a.paco2 >= 45
        },
      },
    ],
  },
  // ------------------------------------------------------------
  {
    id: 'postop',
    title: '術後患者のウィーニングと抜管',
    summary: '上腹部手術後、麻酔からの覚醒遅延のため挿管のまま ICU に入室した男性。手術から数時間後の抜管を目指します。',
    goals: ['SAT（鎮静中止）と SBT の流れを理解する', '抜管前評価（カフリーク・咳嗽）を行う', '抜管後の酸素療法を選択し経過を観察する'],
    patient: male({ disease: 'postop' }),
    settings: (ibw) => ({ ...DEFAULT_SETTINGS, mode: 'VC-AC', vt: r10(ibw * 7), rr: 14, peep: 5, fio2: 0.5 }),
    airway: 'intubated',
    rass: -3,
    steps: [
      {
        title: '回復を待つ',
        instruction: 'ウィーニングタブの「時間を進める」で、麻酔からの回復と無気肺の改善を待ってください（目安 6 時間）。',
        hint: '病態の残存が 50% を切るまで進めます。',
        feedback: '時間とともに残存麻酔薬が代謝され、呼吸ドライブが回復しました。',
        check: ({ snap }) => snap.patient.progress < 0.5,
      },
      {
        title: 'SAT を行う',
        instruction: '鎮静を中止（SAT）し、RASS が −1〜0 になるまで観察してください。',
        hint: 'ウィーニングタブまたは患者タブの「鎮静を中止（SAT）」を押し、速度を上げて待ちます。',
        feedback: 'SAT と SBT を組み合わせる（ABCDEF バンドル）ことで、人工呼吸期間と ICU 滞在が短縮します。覚醒すると呼吸数と吸気努力が増えることを波形で確認しましょう。',
        check: ({ snap }) => snap.patient.rass >= -1,
      },
      {
        title: '酸素化を確認する',
        instruction: 'FiO2 を 0.5 以下、PEEP を 8 以下にしても SpO2 92% 以上を 30 秒維持できることを確認してください。',
        hint: 'FiO2 を段階的に下げ、SpO2 を見ながら調整します。',
        feedback: 'SBT の前提条件として、低い PEEP と FiO2 で酸素化が保たれていることが必要です。',
        check: ({ sim, snap }) => sim.settings.fio2 <= 0.5 && sim.settings.peep <= 8 && snap.vitals.spo2 >= 92,
        hold: 30,
      },
      {
        title: 'SBT を開始する',
        instruction: 'ウィーニングタブから SBT（PS 5/PEEP 5、CPAP、または T ピース、30 分）を開始してください。',
        hint: 'SBT 中の観察項目: 呼吸数、1回換気量（RSBI）、SpO2、心拍数、血圧、努力呼吸、意識。',
        feedback: 'SBT は「人工呼吸器なしで呼吸を続けられるか」を確かめる試験です。最初の数分で RSBI（呼吸数 ÷ 1回換気量[L]）を確認します。105 未満が抜管成功の目安です。',
        check: ({ snap }) => !!snap.sbt && (snap.sbt.active || snap.sbt.result === 'pass'),
      },
      {
        title: 'SBT を完了する',
        instruction: '速度を ×60 にして 30 分間の SBT を完了させてください。失敗した場合は原因を考え、時間を進めてから再度実施します。',
        hint: '失敗したら元の設定に戻り、呼吸筋を休ませてから翌日に再評価するのが一般的です。',
        feedback: 'SBT に成功しました。次は上気道と排痰の評価です。',
        check: ({ snap }) => snap.sbt?.result === 'pass',
      },
      {
        title: '抜管前の評価',
        instruction: 'カフリークテストと咳嗽・分泌物の評価を行ってください。',
        hint: 'カフリーク量が 110 mL 未満（または吸気量の 10〜25% 未満）では喉頭浮腫による抜管後喘鳴のリスクが高くなります。',
        feedback: 'SBT は「呼吸できるか」、カフリークテストは「上気道が開いているか」、咳嗽評価は「痰を出せるか」を見ます。いずれかに問題があれば抜管失敗のリスクが高まります。',
        check: ({ sim }) => sim.cuffLeakTested !== null && sim.coughAssessed !== null,
      },
      {
        title: '抜管する',
        instruction: '抜管し、抜管後の酸素療法を選んでください。',
        hint: 'この患者は再挿管の低リスク群です。鼻カニュラや簡易マスクで十分なことが多いでしょう。',
        feedback: '抜管しました。モニタの EtCO2 は非挿管のため表示されなくなります。',
        check: ({ snap }) => snap.airway === 'extubated',
      },
      {
        title: '抜管後の経過観察',
        instruction: '抜管後 30 分間、SpO2 92% 以上・呼吸数 30 回/分未満を保てることを確認してください（速度を上げて構いません）。',
        hint: '術後は創部痛のため浅く速い呼吸になりやすく、無気肺が再発しやすい状態です。',
        feedback: '抜管成功です。術後は早期離床・疼痛管理・呼吸理学療法で無気肺の再発を防ぎます。シナリオ完了です。',
        check: ({ sim, snap }) => sim.extubatedAt !== null && snap.t - sim.extubatedAt >= 1800 && snap.vitals.spo2 >= 92 && snap.patient.rrPatient < 30,
      },
    ],
  },
  // ------------------------------------------------------------
  {
    id: 'dope',
    title: '急変対応（DOPE）',
    summary: '肺炎で人工呼吸中の患者。次々と急変が起こります。アラーム・波形・計測値・バイタルの変化から原因を推定して対処してください。',
    goals: ['急変時の系統的アプローチ（DOPE）を身につける', '気道抵抗の問題とコンプライアンスの問題を区別する', '機器側の問題を見つける'],
    patient: male({ disease: 'pneumonia', severity: 'mild' }),
    settings: (ibw) => ({ ...DEFAULT_SETTINGS, mode: 'VC-AC', vt: r10(ibw * 7), rr: 18, peep: 8, fio2: 0.5, peakFlow: 60 }),
    airway: 'intubated',
    rass: -3,
    hideEvents: true,
    steps: [
      {
        title: '急変 1',
        instruction: '気道内圧上限アラームが鳴り始めました。何が起きているか評価し、適切な処置を行ってください。',
        hint: '吸気ポーズで Pplat を測り、Ppeak との差を見ます。差が大きい = 気道抵抗の問題（痰・攣縮・チューブ）。',
        feedback: '痰による気道閉塞でした。最高気道内圧が上がっても Pplat があまり変わらない場合は気道抵抗の上昇を示し、痰・気管支攣縮・チューブの屈曲や閉塞を考えます。',
        onEnter: (sim) => sim.triggerEvent('mucusPlug'),
        check: ({ snap }) => !snap.events.includes('mucusPlug'),
      },
      {
        title: '急変 2',
        instruction: '数分後、再び状態が変化しました。評価して対処してください。',
        hint: 'Ppeak と Pplat がともに上昇し、SpO2 と血圧が下がっていく場合はコンプライアンスの問題で、緊張性気胸を必ず考えます。',
        feedback: '緊張性気胸でした。Ppeak・Pplat がともに上がり（コンプライアンス低下）、静脈還流の障害で血圧が下がり、CVP が上がります。陽圧換気中の気胸は急速に緊張性になるため、迅速な脱気（ドレナージ）が必要です。',
        onEnter: (sim) => sim.triggerEvent('pneumothorax'),
        check: ({ snap }) => !snap.events.includes('pneumothorax'),
      },
      {
        title: '急変 3',
        instruction: '低圧アラームと無呼吸アラームが鳴っています。対処してください。',
        hint: '気道内圧がほぼ 0、呼気換気量が 0、EtCO2 の波形が消えている…まず確認すべきは？',
        feedback: '回路外れでした。最も頻度が高く、最も早く見つけるべき急変です。用手換気に切り替えると同時に、患者から呼吸器まで回路をたどって確認します。',
        onEnter: (sim) => sim.triggerEvent('disconnect'),
        check: ({ snap }) => !snap.events.includes('disconnect'),
      },
      {
        title: '急変 4',
        instruction: '体位変換の後から SpO2 が下がり、気道内圧が上がっています。対処してください。',
        hint: 'チューブの固定位置（口角の cm 表示）と呼吸音の左右差を確認する場面です。',
        feedback: '片肺挿管でした。チューブが深く入ると右主気管支に入りやすく、左肺が換気されずシャントが増え、全換気量が片肺に入るため気道内圧が上がります。',
        onEnter: (sim) => sim.triggerEvent('mainstem'),
        check: ({ snap }) => !snap.events.includes('mainstem'),
      },
      {
        title: '急変 5',
        instruction: '呼吸回数が急に増え、呼気換気量が吸気換気量より少なくなっています。対処してください。',
        hint: '患者の吸気努力のない呼吸（オートトリガー）が増えていないか、VTi と VTe の差を見ます。',
        feedback: 'カフリークでした。漏れた分だけ呼気換気量が減り、リークを患者の吸気と誤認してオートトリガーが起こります。カフ圧は 20〜30 cmH2O に保ちます。シナリオ完了です。',
        onEnter: (sim) => sim.triggerEvent('cuffLeak'),
        check: ({ snap }) => !snap.events.includes('cuffLeak'),
      },
    ],
  },
  // ------------------------------------------------------------
  {
    id: 'nm',
    title: '神経筋疾患：ウィーニングと抜管後NPPV',
    summary: 'ギラン・バレー症候群で呼吸筋麻痺をきたし、挿管 10 日目の男性。肺は正常ですが呼吸筋力と咳嗽力が低下しています。',
    goals: ['弱い呼吸筋での浅く速い呼吸を観察する', '呼吸筋の回復を待つ', '抜管後の予防的NPPVを理解する'],
    patient: male({ disease: 'neuromuscular' }),
    settings: (ibw) => ({ ...DEFAULT_SETTINGS, mode: 'VC-AC', vt: r10(ibw * 7), rr: 14, peep: 5, fio2: 0.3 }),
    airway: 'intubated',
    rass: -1,
    progress: 0.6,
    steps: [
      {
        title: 'PSV で自発呼吸を評価',
        instruction: 'モードを PSV（PS 10 / PEEP 5）に変更し、1 分間観察してください。',
        hint: '呼吸数と 1回換気量、詳細表示では P0.1 と Pmus にも注目しましょう。',
        feedback: 'PS 10 では換気量が保たれています。患者の吸気努力は弱いですが、呼吸器が補っています。',
        check: ({ sim }) => sim.settings.mode === 'PSV' && sim.settings.ps >= 8,
        hold: 60,
      },
      {
        title: 'サポートを減らす',
        instruction: 'PS を 5 に下げ、2 分間の呼吸パターンの変化を観察してください。',
        hint: '呼吸筋が弱いと、1回換気量が減り呼吸数が増える「浅く速い呼吸」になります。RSBI = 呼吸数 ÷ 1回換気量(L)。',
        feedback: '浅く速い呼吸になり RSBI が上昇しました。弱った呼吸筋に負荷をかけ続けると疲労して CO2 が上がります。今の状態では抜管は困難です。',
        check: ({ sim }) => sim.settings.mode === 'PSV' && sim.settings.ps <= 6,
        hold: 120,
      },
      {
        title: '回復を待つ',
        instruction: 'サポートを十分に戻して（PS 10 以上または A/C）、時間を進め、病態の残存が 40% 未満になるまで回復を待ってください。',
        hint: '+24 時間を数回押します。疲労した呼吸筋の回復には十分な休息が必要です。',
        feedback: '数日の経過で呼吸筋力が回復してきました。',
        check: ({ snap }) => snap.patient.progress < 0.4,
      },
      {
        title: 'SBT に成功する',
        instruction: '鎮静が浅いことを確認し、30 分間の SBT に成功してください。',
        hint: '失敗した場合は時間をさらに進めてから再挑戦します。',
        feedback: 'SBT に成功しました。',
        check: ({ snap }) => snap.sbt?.result === 'pass',
      },
      {
        title: '咳嗽を評価する',
        instruction: '咳嗽・分泌物の評価を行ってください。',
        hint: '神経筋疾患では咳嗽力が抜管成功の鍵です（臨床では咳のピークフロー < 160 L/分が排痰困難の目安）。',
        feedback: '咳嗽力はまだ十分ではありません。抜管後は排痰補助と呼吸サポートが必要になりそうです。',
        check: ({ sim }) => sim.coughAssessed !== null,
      },
      {
        title: '抜管して NPPV / HFNC',
        instruction: '抜管し、抜管後の呼吸サポートとして NPPV または HFNC を選んでください。',
        hint: '神経筋疾患・高CO2・COPD など再挿管の高リスク群では、抜管直後からの NPPV が推奨されます。',
        feedback: '抜管後の予防的 NPPV は、呼吸筋の負担を軽減し再挿管を減らします。',
        check: ({ sim, snap }) => snap.airway === 'extubated' && (isNppv(sim.settings.mode) || sim.settings.mode === 'HFNC'),
      },
      {
        title: '抜管後 2 時間',
        instruction: '抜管後 2 時間、SpO2 92% 以上・PaCO2 50 未満を保ってください（速度変更・時間スキップを使えます）。必要なら吸引（排痰介助）も行います。',
        hint: '痰が溜まると無気肺から低酸素になります。処置タブの「気管吸引」は抜管後は口腔・鼻腔吸引／排痰介助になります。',
        feedback: '抜管後も安定しています。神経筋疾患では、抜管後も NPPV・排痰補助（カフアシスト等）を継続しながら慎重に観察します。シナリオ完了です。',
        check: ({ sim, snap }) => sim.extubatedAt !== null && snap.t - sim.extubatedAt >= 7200 && snap.vitals.spo2 >= 92 && snap.gas.paco2 < 50,
      },
    ],
  },
  // ------------------------------------------------------------
  {
    id: 'nppv',
    title: 'COPD増悪：NPPVの導入',
    summary: 'COPD の急性増悪で救急搬送された男性。酸素マスク 6 L/分で努力呼吸が続いています。挿管を避けるため NPPV を導入します。',
    goals: ['高CO2性呼吸不全を血液ガスで評価する', 'NPPV の初期設定を行う', '酸素の目標範囲を守る', 'NPPV の効果を評価する'],
    patient: male({ disease: 'copd' }),
    settings: () => ({ ...DEFAULT_SETTINGS, mode: 'O2', o2Device: 'mask', o2Flow: 6, fio2: 0.35, ipap: 8, epap: 4 }),
    airway: 'extubated',
    rass: 0,
    steps: [
      {
        title: '血液ガスを評価する',
        instruction: '動脈血ガスを採取してください。',
        hint: '血液ガスタブにあります。',
        feedback: '急性の呼吸性アシドーシス（慢性の代償の上にさらに CO2 が上昇）です。pH 7.35 未満かつ PaCO2 45 超は NPPV の適応です。',
        check: ({ sim, stepStart }) => !!abgSince(sim, stepStart),
      },
      {
        title: 'NPPV を開始する',
        instruction: 'NPPV（S/T）を開始してください。目安は IPAP 10〜15、EPAP 4〜6 cmH2O です。',
        hint: '換気モードの欄に NPPV S/T があります。IPAP − EPAP が換気補助、EPAP は auto-PEEP によるトリガー負荷を軽減します。',
        feedback: 'NPPV が開始されました。マスクを合わせ、リーク量と患者の呼吸の同調を確認します。',
        check: ({ sim }) => sim.settings.mode === 'NPPV-ST' && sim.settings.ipap >= 10 && sim.settings.epap >= 4 && sim.settings.epap <= 6,
      },
      {
        title: '酸素の目標範囲',
        instruction: 'FiO2 を調整し、SpO2 88〜92% を 1 分間保ってください。',
        hint: 'COPD では過剰な酸素は CO2 の上昇を招くことがあります。',
        feedback: 'COPD の増悪では SpO2 88〜92% を目標にします。',
        check: ({ snap }) => snap.vitals.spo2 >= 88 && snap.vitals.spo2 <= 92.5,
        hold: 60,
      },
      {
        title: '効果を評価する',
        instruction: '1 時間後（ウィーニングタブの +1時間）に血液ガスを再検し、pH が改善（7.30 以上）していることを確認してください。改善が不十分なら IPAP を上げます。',
        hint: 'NPPV 開始 1〜2 時間後の pH・PaCO2・呼吸数の改善が、NPPV 成功の最も良い予測因子です。改善しなければ挿管を考慮します。',
        feedback: 'NPPV で呼吸筋の負担が減り、換気が改善しました。シナリオ完了です。',
        check: ({ sim, stepStart }) => {
          const a = abgSince(sim, stepStart)
          return !!a && a.ph >= 7.3 && sim.t - stepStart >= 1800
        },
      },
    ],
  },
]
