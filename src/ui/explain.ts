import { isNppv, isVentMode, type Simulator, type Snapshot } from '../engine/simulator'

export interface Finding {
  level: 'good' | 'info' | 'warn' | 'danger'
  title: string
  body: string
}

/** 現在の状態を評価し、所見と対応のヒントを返す */
export function analyze(snap: Snapshot, sim: Simulator): Finding[] {
  const out: Finding[] = []
  const m = snap.mode
  const v = snap.vent
  const s = sim.settings
  const vent = isVentMode(m) && snap.connected
  const disease = sim.cfg.disease
  const c = snap.async.counts
  const g = snap.gas
  const vt = snap.vitals

  if (vt.arrest) {
    out.push({ level: 'danger', title: '心停止', body: '高度の低酸素血症または循環不全により心停止しています。換気と酸素化を確保し、原因（回路外れ・気胸・高すぎる胸腔内圧など）を除去してください。患者タブの「蘇生」で心拍を再開できます。' })
  }
  if (!snap.connected && snap.airway === 'intubated') {
    out.push({ level: 'danger', title: '換気が届いていません', body: '回路外れ（または計画外抜管）で、患者は大気圧で自発呼吸しているだけです。最高気道内圧と呼気換気量がほぼ0になっていることを確認し、すぐに原因を探してください。' })
  }

  // ---- 換気量・圧
  if (vent && m !== 'APRV' && v.vtPerKg > 8.5) {
    out.push({
      level: disease === 'ards' ? 'danger' : 'warn',
      title: `1回換気量が多い（${v.vtPerKg.toFixed(1)} mL/kg IBW）`,
      body: '肺保護換気では理想体重あたり6〜8 mL/kg（ARDSでは6 mL/kg）が目安です。圧規定のモードでは、吸気圧の設定や患者の吸気努力によって換気量が増えます。',
    })
  }
  if (v.pplat !== null && v.pplat > 30) {
    out.push({
      level: 'danger',
      title: `プラトー圧が高い（${v.pplat.toFixed(0)} cmH2O）`,
      body: disease === 'obesity'
        ? '肥満では胸壁の硬さのため気道内圧が高くなりやすく、経肺圧で評価すると許容できる場合があります（詳細表示で食道内圧を確認）。それでも1回換気量の見直しを検討します。'
        : 'プラトー圧30 cmH2O超は人工呼吸器関連肺傷害（VILI）のリスクです。1回換気量を下げる、過剰なPEEPを見直す、などを検討します。',
    })
  }
  if (v.drivingP !== null && v.drivingP > 15) {
    out.push({ level: 'warn', title: `駆動圧が高い（ΔP ${v.drivingP.toFixed(0)} cmH2O）`, body: '駆動圧（Pplat − 総PEEP）は換気量を含気肺の大きさで割った指標で、15 cmH2O以下が目標です。換気量を下げるか、リクルートメントでコンプライアンスが改善するPEEPを探します。' })
  }
  if (vent && (m === 'VC-AC' || m === 'SIMV-VC') && v.pplat === null) {
    out.push({ level: 'info', title: 'プラトー圧を測定しましょう', body: '従量式では最高気道内圧だけでは肺への負荷はわかりません。「吸気ポーズ」ボタンでプラトー圧を測り、駆動圧とコンプライアンスを確認します。' })
  }
  if (vent && v.ppeak > 35 && v.pplat !== null && v.ppeak - v.pplat > 10) {
    out.push({ level: 'warn', title: '気道抵抗の上昇', body: `最高気道内圧とプラトー圧の差が ${(v.ppeak - v.pplat).toFixed(0)} cmH2O あります。分泌物・気管支攣縮・チューブの屈曲や閉塞などの「気道抵抗」の問題を考えます。` })
  }

  // ---- auto-PEEP
  const flowLimited = vent && v.endExpFlow < -6 && m !== 'APRV'
  if (flowLimited || (v.autoPeep !== null && v.autoPeep > 3)) {
    out.push({
      level: 'warn',
      title: 'auto-PEEP（内因性PEEP）',
      body:
        (v.autoPeep !== null ? `呼気ポーズで ${v.autoPeep.toFixed(1)} cmH2O の auto-PEEP を認めます。` : '呼気終末に流量波形がゼロまで戻っていません。') +
        '呼気が終わる前に次の吸気が始まっています。換気回数を下げる、吸気流量を上げて吸気時間を短くする、1回換気量を減らす、PSVでは呼気トリガー（ETS）を上げる、などで呼気時間を延ばします。血圧低下やトリガー不良の原因になります。',
    })
  }

  // ---- 非同調
  if (vent) {
    if (c.ineffective >= 3)
      out.push({ level: 'warn', title: `ミストリガー（無効な吸気努力 ${c.ineffective}回/2分）`, body: '患者の吸気努力が呼吸器に検出されていません。流量波形の呼気相に小さな凹み（流量がゼロに近づく）が見えます。原因は auto-PEEP（努力がPEEPi分を打ち消せない）や過剰なサポートです。COPDでは外因性PEEPの付加、ETSを上げる、PS・換気量を下げることを検討します。' })
    if (c.double >= 3)
      out.push({ level: 'warn', title: `ダブルトリガー（${c.double}回/2分）`, body: '患者の吸気が呼吸器の吸気時間より長く、1回の努力で2回の送気が起きています（呼吸のスタッキング）。吸気時間を延ばす、換気量や吸気流量の調整、PCやPSへの変更、呼吸ドライブの原因への対応を考えます。' })
    if (c.autoTrigger >= 3)
      out.push({ level: 'warn', title: `オートトリガー（${c.autoTrigger}回/2分）`, body: '患者の吸気努力がないのに送気が始まっています。リーク（カフ・回路）や結露、過敏すぎるトリガー設定が原因です。リークを探し、トリガー感度を鈍くします。' })
    if (c.delayedCycle >= 3)
      out.push({ level: 'warn', title: `サイクルの遅れ（${c.delayedCycle}回/2分）`, body: '患者が息を吐き始めても吸気が続いています。時定数の長い肺（COPD）やリークで起こります。ETSを上げる（例: 40〜50%）、PSを下げることを検討します。' })
    if (c.prematureCycle >= 3)
      out.push({ level: 'warn', title: `早すぎるサイクル（${c.prematureCycle}回/2分）`, body: '患者がまだ吸おうとしているのに吸気が終わっています。ETSを下げる、吸気時間を延ばす（PC）ことを検討します。' })
    if (c.flowStarvation >= 3)
      out.push({ level: 'warn', title: `フロー不足（${c.flowStarvation}回/2分）`, body: '従量式で患者の吸気需要が送気流量を上回り、気道内圧波形が吸気中に凹んでいます。吸気流量を上げる、PCやPRVCに変更する、呼吸ドライブを高めている原因（低酸素・アシドーシス・痛み・不安）に対応します。' })
  }
  if (snap.patient.p01 > 3.5 || snap.patient.pmusPeak > 12) {
    out.push({ level: 'warn', title: '呼吸ドライブが強い', body: `吸気努力が強く（Pmus ${snap.patient.pmusPeak.toFixed(0)} cmH2O, P0.1 ${snap.patient.p01.toFixed(1)}）、呼吸筋疲労や自発呼吸誘発性肺傷害（P-SILI）のリスクがあります。低酸素・高CO2・代謝性アシドーシス・痛みや不穏の評価とサポートの調整を行います。` })
  }
  if (snap.patient.fatigue > 0.25) {
    out.push({ level: 'warn', title: '呼吸筋疲労', body: '呼吸筋の負荷が耐えられる限界（圧時間指数 0.15）を超えた状態が続いています。浅く速い呼吸とCO2の上昇が進みます。サポートを増やして呼吸筋を休ませます。' })
  }
  if (vent && m === 'PSV' && s.ps >= 12 && snap.patient.pmusPeak < 2 && snap.patient.drive > 0) {
    out.push({ level: 'info', title: 'サポート過剰の可能性', body: '患者の吸気努力がほとんどありません。過剰なサポートは横隔膜の廃用（VIDD）やミストリガーの原因になります。PSを下げて適切な努力（呼吸数・換気量）を確認します。' })
  }
  if (snap.patient.diaphragm < 0.9) {
    out.push({ level: 'info', title: '横隔膜筋力の低下', body: `自発呼吸のない調節換気が長く続き、横隔膜の筋力が ${(snap.patient.diaphragm * 100).toFixed(0)}% に低下しています（人工呼吸器関連横隔膜機能障害）。病態が許せば自発呼吸を温存するモードを検討します。` })
  }
  if (v.backup && m === 'PSV') out.push({ level: 'info', title: 'バックアップ換気中', body: '設定時間以上の無呼吸が検出され、PC（バックアップ圧・回数）で換気しています。自発呼吸が再開すれば自動で解除されます。鎮静が深すぎないか確認します。' })

  // ---- ガス交換
  const spo2 = vt.spo2
  if (Number.isFinite(spo2)) {
    const copd = disease === 'copd'
    if (spo2 < 88)
      out.push({ level: 'danger', title: `低酸素血症（SpO2 ${spo2.toFixed(0)}%）`, body: 'FiO2を上げると同時に原因を考えます。PEEPを上げて虚脱肺をリクルートする（ARDS・肥満・術後無気肺で効果的）、分泌物・片肺挿管・気胸・回路の問題を除外します。' })
    else if (spo2 < (copd ? 88 : 92))
      out.push({ level: 'warn', title: `SpO2がやや低い（${spo2.toFixed(0)}%）`, body: copd ? 'COPDでは88〜92%を目標にします。' : 'FiO2またはPEEPの調整を検討します。' })
    if (spo2 >= 98 && g.fio2Eff > 0.5)
      out.push({ level: 'info', title: '酸素の過剰投与', body: `SpO2 ${spo2.toFixed(0)}% に対しFiO2 ${(g.fio2Eff * 100).toFixed(0)}%。SpO2の目標範囲を保てる範囲でFiO2を下げます。` })
    if (copd && spo2 > 95 && g.paco2 > 60) out.push({ level: 'info', title: 'COPDでの高濃度酸素', body: 'COPDでは過剰な酸素投与がCO2上昇（V/Q不均等の悪化・Haldane効果）を招くことがあります。目標SpO2は88〜92%です。' })
  }
  if (g.ph < 7.25 && g.paco2 > 50)
    out.push({ level: 'warn', title: `呼吸性アシドーシス（pH ${g.ph.toFixed(2)}, PaCO2 ${g.paco2.toFixed(0)}）`, body: disease === 'ards' ? 'ARDSでは肺保護のため pH 7.25〜7.30 程度までの高CO2血症を許容します（permissive hypercapnia）。換気回数を上げて分時換気量を増やし、それでも不十分なら死腔の削減などを考えます。' : '分時換気量（換気回数・換気量・サポート圧）を増やします。閉塞性疾患では換気回数を上げるとauto-PEEPが増えるので注意します。' })
  if (g.ph > 7.5 && g.paco2 < 35)
    out.push({ level: 'warn', title: `過換気（pH ${g.ph.toFixed(2)}, PaCO2 ${g.paco2.toFixed(0)}）`, body: disease === 'copd' ? 'COPDの患者は慢性的に高CO2・高HCO3-のため、正常値までCO2を下げると高度のアルカレミアになります。患者の普段のPaCO2を目標にします。' : '換気回数や換気量を下げます。自発呼吸が多い場合は原因（痛み・不安・低酸素）を評価します。' })
  if (g.ph < 7.3 && g.be < -5)
    out.push({ level: 'info', title: '代謝性アシドーシス', body: `BE ${g.be.toFixed(1)}、乳酸 ${g.lactate.toFixed(1)} mmol/L。組織低灌流（敗血症・低心拍出）を考えます。呼吸性代償のため換気需要が増えています。` })

  // ---- 循環
  if (!vt.arrest && vt.map < 65) {
    out.push({
      level: 'danger',
      title: `低血圧（MAP ${vt.map.toFixed(0)} mmHg）`,
      body:
        '陽圧換気は胸腔内圧を上げて静脈還流を減らします。高いPEEP・auto-PEEP・気胸・循環血液量減少を考えます。' +
        (vt.ppv > 13 ? ` 脈圧変動（PPV）が ${vt.ppv.toFixed(0)}% と大きく、輸液反応性がある可能性があります。` : '') +
        ' 原因に応じてPEEPの調整、輸液、昇圧薬を検討します。',
    })
  }
  if (!vt.arrest && vt.ppv > 13 && vt.map >= 65) out.push({ level: 'info', title: `脈圧変動が大きい（PPV ${vt.ppv.toFixed(0)}%）`, body: '調節換気下でPPV > 13%は輸液反応性を示唆します（換気量が少ない・自発呼吸がある・不整脈がある場合は信頼性が下がります）。' })

  // ---- 非侵襲
  if (isNppv(m) && v.leak > 50) out.push({ level: 'warn', title: 'マスクリークが多い', body: `総リーク ${v.leak.toFixed(0)} L/分。マスクの位置・サイズ・固定を見直します。リークが多いとトリガーやサイクルが乱れ、EPAPが保てません。` })
  if (m === 'HFNC' && g.fio2Eff < s.fio2 - 0.05) out.push({ level: 'info', title: '患者の吸気流量がHFNCの流量を上回っています', body: `実効FiO2は ${(g.fio2Eff * 100).toFixed(0)}%（設定 ${(s.fio2 * 100).toFixed(0)}%）。吸気時に室内気を吸い込んでいます。流量を上げると改善します。` })
  if (m === 'O2' && s.o2Device !== 'none') out.push({ level: 'info', title: `実効FiO2 約${(g.fio2Eff * 100).toFixed(0)}%`, body: '通常の酸素療法では、呼吸が速く深いほど室内気を多く吸い込み、FiO2が下がります。' })
  if (!vent && snap.patient.rrPatient > 30) out.push({ level: 'warn', title: '頻呼吸', body: `呼吸数 ${snap.patient.rrPatient.toFixed(0)} 回/分（RSBI ${snap.patient.rsbi?.toFixed(0) ?? '---'}）。呼吸仕事量が増えています。サポートの追加や再挿管の必要性を評価します。` })

  if (out.length === 0) out.push({ level: 'good', title: '大きな問題は見当たりません', body: '設定を変えて、波形・計測値・バイタルサインがどう変化するか観察してみましょう。' })
  const order = { danger: 0, warn: 1, info: 2, good: 3 }
  return out.sort((a, b) => order[a.level] - order[b.level])
}
