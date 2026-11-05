// 各学習シナリオが想定どおりの操作で完了できるか確認: npx tsx scripts/scenarios-check.ts
import { Simulator } from '../src/engine/simulator'
import { idealBodyWeight } from '../src/engine/patients'
import { SCENARIOS, type Scenario } from '../src/scenarios/scenarios'
import type { VentSettings } from '../src/engine/types'

function runScenario(sc: Scenario, actions: ((sim: Simulator) => void)[]) {
  const ibw = idealBodyWeight(sc.patient.sex, sc.patient.height)
  const sim = new Simulator(sc.patient, sc.settings(ibw))
  sim.reset(sc.patient, sc.settings(ibw), { airway: sc.airway, rass: sc.rass, progress: sc.progress })
  console.log(`\n### ${sc.title}`)
  sc.steps.forEach((st, i) => {
    st.onEnter?.(sim)
    const stepStart = sim.t
    actions[i]?.(sim)
    let hold = 0
    let ok = false
    for (let k = 0; k < 9000 && !ok; k++) {
      sim.advance(1)
      const snap = sim.snapshot()
      if (st.check({ sim, snap, stepStart })) {
        hold += 1
        if (!st.hold || hold >= st.hold) ok = true
      } else hold = 0
    }
    const s = sim.snapshot()
    console.log(`${ok ? 'OK ' : 'NG '} ${i + 1}. ${st.title}  (SpO2 ${s.vitals.spo2.toFixed(0)} PaCO2 ${s.gas.paco2.toFixed(0)} pH ${s.gas.ph.toFixed(2)} MAP ${s.vitals.map.toFixed(0)} RR ${s.patient.rrPatient.toFixed(0)} VT ${s.patient.vtSpont.toFixed(0)} prog ${s.patient.progress.toFixed(2)} sbt ${s.sbt?.result ?? '-'} ${s.sbt?.failReasons.join(',') ?? ''})`)
  })
}
const set = (p: Partial<VentSettings>) => (sim: Simulator) => sim.applySettings({ ...sim.settings, ...p })
const seq = (...fs: ((sim: Simulator) => void)[]) => (sim: Simulator) => fs.forEach((f) => f(sim))
const holdI = (sim: Simulator) => { sim.advance(20); sim.inspHold() }
const holdE = (sim: Simulator) => { sim.advance(20); sim.expHold() }
const abgLater = (sec: number) => (sim: Simulator) => { sim.advance(sec); sim.sampleAbg() }
const by = (id: string) => SCENARIOS.find((s) => s.id === id)!

runScenario(by('ards'), [
  set({ vt: 410 }), set({ rr: 26 }), holdI,
  seq(set({ peep: 14, fio2: 0.5 }), (s) => s.intervene('recruit')),
  holdI, abgLater(600),
])
runScenario(by('copd'), [holdE, seq(set({ rr: 12, peakFlow: 70 }), holdE), set({ peep: 6 }), abgLater(600)])
runScenario(by('postop'), [
  (s) => s.skipHours(6), (s) => s.setRassTarget(0), set({ fio2: 0.4 }), (s) => s.startSbt('psv', 30), () => {},
  (s) => { s.cuffLeakTest(); s.coughAssessment() },
  (s) => s.extubate({ ...s.settings, mode: 'O2', o2Device: 'cannula', o2Flow: 2 }), () => {},
])
runScenario(by('dope'), [(s) => s.intervene('suction'), (s) => s.intervene('chestDrain'), (s) => s.intervene('reconnect'), (s) => s.intervene('tubeReposition'), (s) => s.intervene('cuffAdjust')])
runScenario(by('nm'), [
  set({ mode: 'PSV', ps: 10 }), set({ ps: 5 }),
  seq(set({ ps: 12 }), (s) => { for (let i = 0; i < 5; i++) s.skipHours(24) }),
  (s) => { s.setRassTarget(0); s.advance(1800); s.startSbt('psv', 30) },
  (s) => s.coughAssessment(),
  (s) => s.extubate({ ...s.settings, mode: 'NPPV-ST', ipap: 12, epap: 5, fio2: 0.35 }),
  (s) => { s.advance(3600); s.intervene('suction') },
])
runScenario(by('nppv'), [
  (s) => s.sampleAbg(), set({ mode: 'NPPV-ST', ipap: 14, epap: 5, fio2: 0.3 }), set({ fio2: 0.4 }),
  (s) => { s.skipHours(1); s.sampleAbg() },
])
