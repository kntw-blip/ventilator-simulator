import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DT, Simulator, type Snapshot } from './engine/simulator'
import { initialSettingsFor } from './engine/defaults'
import { DISEASES, SEVERITY_LABEL, idealBodyWeight } from './engine/patients'
import type { PatientConfig, VentSettings } from './engine/types'
import { HubContext, fmtTime, type SimHub } from './ui/hub'
import { VentScreen } from './ui/VentScreen'
import { SettingsPanel } from './ui/SettingsPanel'
import { Monitor } from './ui/Monitor'
import { AbgPanel, AlarmPanel, EventsPanel, ExplainPanel, PatientPanel, TrendPanel, WeaningPanel } from './ui/Panels'
import { analyze } from './ui/explain'
import type { Level } from './ui/types'
import { ScenarioPanel, ScenarioPicker, type ScenarioRun } from './scenarios/ScenarioPanel'
import type { Scenario } from './scenarios/scenarios'
import { AlarmSound } from './ui/sound'

const INITIAL_CFG: PatientConfig = { disease: 'normal', severity: 'moderate', sex: 'male', height: 170, weight: 65, volumeStatus: 'normal' }

type Tab = 'explain' | 'patient' | 'events' | 'weaning' | 'abg' | 'trend' | 'alarm'
const TABS: { id: Tab; label: string }[] = [
  { id: 'explain', label: '解説' },
  { id: 'patient', label: '患者・薬剤' },
  { id: 'events', label: '急変・処置' },
  { id: 'weaning', label: 'ウィーニング・抜管' },
  { id: 'abg', label: '血液ガス' },
  { id: 'trend', label: 'トレンド' },
  { id: 'alarm', label: 'アラーム設定' },
]
const SPEEDS = [0, 1, 5, 20, 60]

export default function App() {
  const simRef = useRef<Simulator | null>(null)
  if (!simRef.current) simRef.current = new Simulator(INITIAL_CFG, initialSettingsFor('normal', idealBodyWeight('male', 170)))
  const sim = simRef.current
  const frameFns = useRef(new Set<() => void>())
  const hub = useMemo<SimHub>(
    () => ({
      sim,
      generation: 0,
      onFrame(fn) {
        frameFns.current.add(fn)
        return () => frameFns.current.delete(fn)
      },
    }),
    [sim],
  )

  const [snap, setSnap] = useState<Snapshot>(() => sim.snapshot())
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(1)
  speedRef.current = speed
  const [level, setLevel] = useState<Level>('basic')
  const [tab, setTab] = useState<Tab>('explain')
  const [draft, setDraft] = useState<VentSettings>(sim.settings)
  const appliedRef = useRef<VentSettings>(sim.settings)
  const [run, setRun] = useState<ScenarioRun | null>(null)
  const runRef = useRef<ScenarioRun | null>(null)
  runRef.current = run
  const [picker, setPicker] = useState(false)
  const [sound, setSound] = useState(true)
  const soundRef = useRef<AlarmSound | null>(null)
  const lastTickT = useRef(sim.t)

  // ---- 描画・計算ループ
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let acc = 0
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (speedRef.current > 0) {
        acc += dt * speedRef.current
        const n = Math.floor(acc / DT)
        acc -= n * DT
        for (let i = 0; i < n; i++) sim.step()
      }
      frameFns.current.forEach((f) => f())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sim])

  // ---- 数値表示・シナリオ評価・アラーム音（250ms ごと）
  useEffect(() => {
    const id = setInterval(() => {
      const s = sim.snapshot()
      setSnap(s)
      if (sim.settings !== appliedRef.current) {
        appliedRef.current = sim.settings
        setDraft({ ...sim.settings })
      }
      const dtSim = sim.t - lastTickT.current
      lastTickT.current = sim.t
      const r = runRef.current
      if (r && r.phase === 'doing') {
        const st = r.sc.steps[r.idx]
        const m = { ...r.metrics }
        if (dtSim > 0 && dtSim < 30) {
          if (s.vitals.spo2 < 88) m.hypoxSec += dtSim
          if (sim.pelMaxEma > 30 && sim.airway === 'intubated') m.pplatSec += dtSim
          if (s.vitals.map < 65) m.hypotSec += dtSim
          if (s.vent.vtPerKg > 8.5 && sim.airway === 'intubated') m.highVtSec += dtSim
        }
        if (s.vitals.arrest) m.arrest = true
        const ok = st.check({ sim, snap: s, stepStart: r.stepStart })
        let holdAcc = ok ? r.holdAcc + Math.max(0, Math.min(dtSim, 30)) : 0
        let phase: ScenarioRun['phase'] = r.phase
        if (ok && (!st.hold || holdAcc >= st.hold)) {
          phase = 'done'
          m.stepTimes = [...m.stepTimes, sim.t - r.stepStart]
          holdAcc = st.hold ?? 0
        }
        setRun({ ...r, metrics: m, holdAcc, phase })
      }
      // アラーム音
      if (soundRef.current) {
        const muted = s.muted
        const pr = s.alarms.some((a) => a.priority === 'high') ? 'high' : s.alarms.length ? 'medium' : null
        soundRef.current.update(sound && !muted && speedRef.current > 0 ? pr : null)
      }
    }, 250)
    return () => clearInterval(id)
  }, [sim, sound])

  // オーディオは最初のユーザー操作で初期化
  useEffect(() => {
    const init = () => {
      if (!soundRef.current) soundRef.current = new AlarmSound()
      soundRef.current.resume()
    }
    window.addEventListener('pointerdown', init)
    window.addEventListener('keydown', init)
    return () => {
      window.removeEventListener('pointerdown', init)
      window.removeEventListener('keydown', init)
    }
  }, [])

  const bump = useCallback(() => {
    hub.generation++
    appliedRef.current = sim.settings
    setDraft({ ...sim.settings })
    lastTickT.current = sim.t
    setSnap(sim.snapshot())
  }, [hub, sim])

  const restart = (cfg: PatientConfig) => {
    const ibw = idealBodyWeight(cfg.sex, cfg.height)
    sim.reset(cfg, initialSettingsFor(cfg.disease, ibw))
    setRun(null)
    bump()
  }

  const startScenario = (sc: Scenario) => {
    const ibw = idealBodyWeight(sc.patient.sex, sc.patient.height)
    sim.reset(sc.patient, sc.settings(ibw), { airway: sc.airway, rass: sc.rass, progress: sc.progress })
    sc.steps[0].onEnter?.(sim)
    setRun({
      sc,
      idx: 0,
      stepStart: sim.t,
      holdAcc: 0,
      phase: 'doing',
      startT: sim.t,
      metrics: { hypoxSec: 0, pplatSec: 0, hypotSec: 0, highVtSec: 0, arrest: false, stepTimes: [] },
    })
    setPicker(false)
    setTab('explain')
    bump()
  }

  const nextStep = () => {
    if (!run) return
    if (run.idx + 1 >= run.sc.steps.length) {
      setRun({ ...run, phase: 'finished' })
      return
    }
    const idx = run.idx + 1
    run.sc.steps[idx].onEnter?.(sim)
    setRun({ ...run, idx, stepStart: sim.t, holdAcc: 0, phase: 'doing' })
  }

  const findings = analyze(snap, sim)
  const badge = findings.filter((f) => f.level === 'danger' || f.level === 'warn').length
  const preset = DISEASES[sim.cfg.disease]
  const hideEvents = !!run?.sc.hideEvents && run.phase !== 'finished'

  return (
    <HubContext.Provider value={hub}>
      <div className="app">
        <header className="topbar">
          <h1>人工呼吸器シミュレータ</h1>
          <div className="patient-chip">
            <strong>{preset.name}</strong>
            <span>
              {SEVERITY_LABEL[sim.cfg.severity]}・{sim.cfg.sex === 'male' ? '男性' : '女性'} {sim.cfg.height}cm {sim.cfg.weight}kg・IBW {snap.ibw.toFixed(1)}kg・
              {snap.airway === 'intubated' ? '挿管中' : '非挿管'}
            </span>
          </div>
          <span className="clock" title="シミュレーション経過時間">
            {fmtTime(snap.elapsed)}
          </span>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="シミュレーション速度">
            {SPEEDS.map((v) => (
              <button key={v} aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                {v === 0 ? '一時停止' : `×${v}`}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="表示レベル">
            <button aria-pressed={level === 'basic'} onClick={() => setLevel('basic')}>
              初級
            </button>
            <button aria-pressed={level === 'detail'} onClick={() => setLevel('detail')}>
              詳細
            </button>
          </div>
          <button className="btn primary" onClick={() => setPicker(true)}>
            学習シナリオ
          </button>
        </header>

        {run && <ScenarioPanel run={run} simT={snap.t} onNext={nextStep} onExit={() => setRun(null)} />}

        <div className="cart">
          <section className="device" aria-label="人工呼吸器">
            <div className="device-head">
              <span className="device-led" />
              <b>人工呼吸器</b>
              <span>{snap.airway === 'intubated' ? (snap.connected ? '' : '患者と接続されていません') : '非侵襲的サポート'}</span>
            </div>
            <VentScreen snap={snap} level={level} />
            <SettingsPanel
              applied={sim.settings}
              draft={draft}
              setDraft={setDraft}
              onConfirm={() => sim.applySettings(draft)}
              onCancel={() => setDraft({ ...sim.settings })}
              airway={snap.airway}
              ibw={snap.ibw}
              showHelp
            />
          </section>
          <section className="device monitor" aria-label="生体情報モニタ">
            <div className="device-head">
              <span className="device-led" style={snap.alarms.some((a) => a.priority === 'high') ? { background: '#e5352b', boxShadow: '0 0 8px #e5352b' } : undefined} />
              <b>生体情報モニタ</b>
            </div>
            <Monitor snap={snap} />
          </section>
        </div>

        <div>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'explain' && badge > 0 && <span className="badge">{badge}</span>}
              </button>
            ))}
          </div>
          <div className="panel" role="tabpanel">
            {tab === 'explain' && <ExplainPanel snap={snap} />}
            {tab === 'patient' && <PatientPanel snap={snap} onRestart={restart} level={level} />}
            {tab === 'events' && <EventsPanel snap={snap} level={level} hideActive={hideEvents} />}
            {tab === 'weaning' && <WeaningPanel snap={snap} onExtubated={() => bumpSettings()} onIntubated={() => bumpSettings()} />}
            {tab === 'abg' && <AbgPanel />}
            {tab === 'trend' && <TrendPanel />}
            {tab === 'alarm' && <AlarmPanel sound={sound} setSound={setSound} />}
          </div>
        </div>

        <footer className="footer">
          教育用のシミュレーションです。生理学モデルは学習のために単純化されており、実際の患者の診療判断には使用しないでください。
        </footer>

        {picker && <ScenarioPicker onPick={startScenario} onClose={() => setPicker(false)} />}
      </div>
    </HubContext.Provider>
  )

  function bumpSettings() {
    appliedRef.current = sim.settings
    setDraft({ ...sim.settings })
  }
}
