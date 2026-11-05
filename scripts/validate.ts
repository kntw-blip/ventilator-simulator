// エンジンの妥当性検証: npx tsx scripts/validate.ts
import { Simulator } from '../src/engine/simulator'
import { initialSettingsFor } from '../src/engine/defaults'
import { idealBodyWeight } from '../src/engine/patients'
import type { DiseaseId, PatientConfig, VentSettings } from '../src/engine/types'

const f = (x: number | null | undefined, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '--' : x.toFixed(d))

function report(label: string, sim: Simulator) {
  const s = sim.snapshot()
  const v = s.vent
  console.log(
    `${label.padEnd(34)} Ppk ${f(v.ppeak).padStart(3)} Pplat ${f(v.pplat).padStart(3)} PEEPtot ${f(v.peepTot, 1).padStart(4)} VTe ${f(v.vte).padStart(4)} RR ${f(v.rrTot).padStart(2)}/${f(s.vitals.rr).padStart(2)} MV ${f(v.mve, 1).padStart(4)} | SpO2 ${f(s.vitals.spo2).padStart(3)} PaO2 ${f(s.gas.pao2).padStart(3)} PaCO2 ${f(s.gas.paco2).padStart(3)} pH ${f(s.gas.ph, 2)} EtCO2 ${f(s.vitals.etco2)} | HR ${f(s.vitals.hr)} BP ${f(s.vitals.sbp)}/${f(s.vitals.dbp)}(${f(s.vitals.map)}) PPV ${f(s.vitals.ppv)} | sh ${f(s.gas.shunt * 100)}% r ${f(s.patient.recruit, 2)} drv ${f(s.patient.drive, 2)} Pmus ${f(s.patient.pmusPeak, 1)} async ${f(s.async.index)}% ${JSON.stringify(Object.fromEntries(Object.entries(s.async.counts).filter(([, n]) => n > 0)))}`,
  )
}

function mk(d: DiseaseId, sev: 'mild' | 'moderate' | 'severe' = 'moderate', weight?: number): [PatientConfig, VentSettings] {
  const cfg: PatientConfig = { disease: d, severity: sev, sex: 'male', height: 170, weight: weight ?? (d === 'obesity' ? 116 : 65), volumeStatus: 'normal' }
  return [cfg, initialSettingsFor(d, idealBodyWeight('male', 170))]
}

function measure(sim: Simulator) {
  sim.inspHold()
  sim.advance(12)
  sim.expHold()
  sim.advance(12)
}

console.log('=== 病態別 初期設定（5分後） ===')
for (const d of ['normal', 'ards', 'copd', 'asthma', 'pneumonia', 'obesity', 'neuromuscular', 'postop'] as DiseaseId[]) {
  const [cfg, st] = mk(d)
  const sim = new Simulator(cfg, st)
  sim.advance(300)
  measure(sim)
  report(`${d} ${st.mode} VT${st.vt} PEEP${st.peep} Fi${st.fio2}`, sim)
}

console.log('\n=== ARDS: PEEP / リクルートメント ===')
{
  const [cfg, st] = mk('ards')
  const sim = new Simulator(cfg, { ...st, peep: 5, fio2: 0.6 })
  sim.advance(300)
  measure(sim)
  report('PEEP5 FiO2 0.6', sim)
  sim.applySettings({ ...sim.settings, peep: 10 })
  sim.advance(300)
  measure(sim)
  report('PEEP10', sim)
  sim.applySettings({ ...sim.settings, peep: 15 })
  sim.advance(300)
  measure(sim)
  report('PEEP15', sim)
  sim.intervene('recruit')
  sim.advance(300)
  measure(sim)
  report('RM後 PEEP15', sim)
  sim.applySettings({ ...sim.settings, peep: 5 })
  sim.advance(300)
  measure(sim)
  report('PEEP5に戻す', sim)
  sim.applySettings({ ...sim.settings, vt: 650, peep: 10 })
  sim.advance(300)
  measure(sim)
  report('VT 650 (10mL/kg) PEEP10', sim)
}

console.log('\n=== COPD: auto-PEEP と外因性PEEP ===')
{
  const [cfg, st] = mk('copd')
  const sim = new Simulator(cfg, { ...st, vt: 550, rr: 22, peakFlow: 40, peep: 0, fio2: 0.35 })
  sim.advance(300)
  measure(sim)
  report('RR22 flow40 PEEP0', sim)
  sim.applySettings({ ...sim.settings, peep: 6 })
  sim.advance(300)
  measure(sim)
  report('PEEP6', sim)
  sim.applySettings({ ...sim.settings, rr: 12, peakFlow: 70 })
  sim.advance(300)
  measure(sim)
  report('RR12 flow70 PEEP6', sim)
  sim.applySettings({ ...sim.settings, mode: 'PSV', ps: 10, peep: 6 })
  sim.advance(300)
  report('PSV10 PEEP6', sim)
  sim.applySettings({ ...sim.settings, mode: 'PSV', ps: 10, peep: 6, ets: 50 })
  sim.advance(300)
  report('PSV10 PEEP6 ETS50', sim)
}

console.log('\n=== 正常: モード比較 ===')
{
  const [cfg, st] = mk('normal')
  const sim = new Simulator(cfg, st)
  for (const m of [
    { mode: 'PC-AC', pinsp: 12 },
    { mode: 'PRVC' },
    { mode: 'SIMV-VC', rr: 8, ps: 8 },
    { mode: 'PSV', ps: 8 },
    { mode: 'PSV', ps: 0 },
    { mode: 'APRV', pHigh: 25, pLow: 0, tHigh: 4.5, tLow: 0.6 },
    { mode: 'TPIECE' },
  ] as Partial<VentSettings>[]) {
    sim.applySettings({ ...sim.settings, ...m })
    sim.advance(240)
    report(`${m.mode} ${JSON.stringify(m).slice(0, 30)}`, sim)
  }
  sim.setRassTarget(0)
  sim.advance(900)
  report('Tピース RASS0', sim)
}

console.log('\n=== 神経筋疾患 SBT（Tピース） ===')
{
  const [cfg, st] = mk('neuromuscular')
  const sim = new Simulator(cfg, st)
  sim.setRassTarget(0)
  sim.advance(600)
  report('VC RASS0', sim)
  sim.startSbt('tpiece', 30)
  for (let i = 0; i < 6; i++) {
    sim.advance(300)
    report(`SBT ${(i + 1) * 5}分 ${sim.sbt?.result} rsbi ${f(sim.sbt?.rsbi)}`, sim)
  }
  console.log('fail:', sim.sbt?.failReasons)
}

console.log('\n=== 術後 経過 → SBT → 抜管 ===')
{
  const [cfg, st] = mk('postop')
  const sim = new Simulator(cfg, st)
  report('初期', sim)
  sim.skipHours(6)
  report('+6h', sim)
  sim.setRassTarget(0)
  sim.advance(900)
  report('SAT後', sim)
  sim.startSbt('psv', 30)
  sim.advance(1800)
  report(`SBT後 ${sim.sbt?.result} rsbi ${f(sim.sbt?.rsbi)}`, sim)
  sim.extubate({ ...sim.settings, mode: 'O2', o2Device: 'cannula', o2Flow: 2 })
  sim.advance(1200)
  report('抜管20分 カニュラ2L', sim)
  console.log('fio2eff', sim.fio2Eff.toFixed(2), sim.sbt?.failReasons)
}

console.log('\n=== イベント ===')
{
  const [cfg, st] = mk('normal')
  const sim = new Simulator(cfg, st)
  sim.triggerEvent('disconnect')
  sim.advance(60)
  report('回路外れ 60秒', sim)
  console.log(sim.snapshot().alarms.map((a) => a.label))
  sim.intervene('reconnect')
  sim.advance(120)
  report('再接続', sim)
  sim.triggerEvent('pneumothorax')
  sim.advance(60)
  report('気胸 60秒', sim)
  sim.advance(120)
  report('気胸 180秒', sim)
  sim.intervene('chestDrain')
  sim.advance(120)
  sim.triggerEvent('cuffLeak')
  sim.advance(60)
  report('カフリーク', sim)
  sim.intervene('cuffAdjust')
  sim.triggerEvent('hypovolemia')
  sim.applySettings({ ...sim.settings, peep: 15 })
  sim.advance(120)
  report('出血+PEEP15', sim)
  sim.intervene('fluid')
  sim.intervene('fluid')
  sim.intervene('fluid')
  sim.advance(120)
  report('輸液1.5L', sim)
}

console.log('\n=== 無呼吸 ===')
{
  const [cfg, st] = mk('obesity')
  const sim = new Simulator(cfg, { ...st, fio2: 0.21 })
  sim.setRassTarget(-5)
  sim.advance(120)
  sim.applySettings({ ...sim.settings, mode: 'PSV', ps: 5 })
  sim.alarmSettings.apnea = 60
  for (let i = 0; i < 4; i++) {
    sim.advance(20)
    report(`肥満 鎮静深 PSV 室内気 ${(i + 1) * 20}s`, sim)
  }
}
