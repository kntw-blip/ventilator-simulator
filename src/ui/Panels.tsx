import { useEffect, useRef, useState } from 'react'
import { EVENT_INFO, INTERVENTION_INFO, isVentMode, type Snapshot } from '../engine/simulator'
import { DISEASES, SEVERITY_LABEL, idealBodyWeight } from '../engine/patients'
import { DEFAULT_SETTINGS } from '../engine/defaults'
import type { AlarmSettings, DiseaseId, EventId, InterventionId, PatientConfig, SbtMethod, Severity, VentSettings } from '../engine/types'
import { analyze } from './explain'
import { fmt, fmtTime, useHub } from './hub'
import type { Level } from './types'

// ============================================================
// 解説
// ============================================================
export function ExplainPanel({ snap }: { snap: Snapshot }) {
  const hub = useHub()
  const f = analyze(snap, hub.sim)
  const p = DISEASES[hub.sim.cfg.disease]
  return (
    <div className="cols">
      <div>
        <h3>いま起きていること</h3>
        {f.map((x, i) => (
          <div key={i} className={`finding ${x.level === 'info' ? '' : x.level}`}>
            <b>{x.title}</b>
            <p>{x.body}</p>
          </div>
        ))}
      </div>
      <div>
        <h3>患者: {p.name}</h3>
        <p>{p.description}</p>
        <h4>波形の見かた</h4>
        <p className="muted">
          気道内圧（黄）・流量（緑）・換気量（青）は同じ時間軸です。吸気は流量が上向き、呼気は下向き。呼気の終わりに流量がゼロに戻らなければ
          auto-PEEP、呼気中の小さな凹みはミストリガー、従量式で吸気中に圧が凹めばフロー不足のサインです。ループの「参照を保存」で設定変更の前後を比べられます。
        </p>
        <h4>急変時の考え方（DOPE）</h4>
        <p className="muted">
          D: Displacement（チューブ位置異常・計画外抜管・片肺挿管）／O: Obstruction（痰・チューブ閉塞・気管支攣縮）／P: Pneumothorax（気胸）／E:
          Equipment（回路外れ・リーク・機器の故障）。まず用手換気に切り替えて、問題が患者側か機器側かを切り分けます。
        </p>
      </div>
    </div>
  )
}

// ============================================================
// 患者設定
// ============================================================
export function PatientPanel({ snap, onRestart, level }: { snap: Snapshot; onRestart: (c: PatientConfig) => void; level: Level }) {
  const hub = useHub()
  const sim = hub.sim
  const [cfg, setCfg] = useState<PatientConfig>(sim.cfg)
  useEffect(() => setCfg(sim.cfg), [sim.cfg, hub.generation])
  const ibw = idealBodyWeight(cfg.sex, cfg.height)
  const bmi = cfg.weight / (cfg.height / 100) ** 2
  const [rass, setRass] = useState(snap.patient.rassTarget)
  const [na, setNa] = useState(snap.patient.na)
  const pt = snap.patient
  return (
    <div className="cols">
      <div>
        <h3>患者を選ぶ</h3>
        <div className="form-grid">
          <label className="field">
            病態
            <select
              value={cfg.disease}
              onChange={(e) => {
                const d = e.target.value as DiseaseId
                setCfg({ ...cfg, disease: d, weight: DISEASES[d].defaultWeight ?? (cfg.disease === 'obesity' ? 65 : cfg.weight) })
              }}
            >
              {Object.values(DISEASES).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            重症度
            <select value={cfg.severity} onChange={(e) => setCfg({ ...cfg, severity: e.target.value as Severity })}>
              {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            性別
            <select value={cfg.sex} onChange={(e) => setCfg({ ...cfg, sex: e.target.value as 'male' | 'female' })}>
              <option value="male">男性</option>
              <option value="female">女性</option>
            </select>
          </label>
          <label className="field">
            身長 cm
            <input type="number" min={130} max={200} value={cfg.height} onChange={(e) => setCfg({ ...cfg, height: Number(e.target.value) })} />
          </label>
          <label className="field">
            体重 kg
            <input type="number" min={30} max={200} value={cfg.weight} onChange={(e) => setCfg({ ...cfg, weight: Number(e.target.value) })} />
          </label>
          <label className="field">
            循環血液量
            <select value={cfg.volumeStatus} onChange={(e) => setCfg({ ...cfg, volumeStatus: e.target.value as PatientConfig['volumeStatus'] })}>
              <option value="low">減少</option>
              <option value="normal">正常</option>
              <option value="high">過剰</option>
            </select>
          </label>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          理想体重 {ibw.toFixed(1)} kg（6 mL/kg = {Math.round(ibw * 6)} mL、8 mL/kg = {Math.round(ibw * 8)} mL）・BMI {bmi.toFixed(1)}
        </p>
        <p>{DISEASES[cfg.disease].description}</p>
        <button className="btn primary" onClick={() => onRestart(cfg)}>
          この患者で開始する
        </button>
        <span className="muted" style={{ marginLeft: 8 }}>
          現在の経過と設定はリセットされます
        </span>
      </div>
      <div>
        <h3>鎮静・薬剤</h3>
        <label className="field">
          鎮静の目標 RASS {rass > 0 ? `+${rass}` : rass}（現在 {pt.rass > 0 ? '+' : ''}
          {pt.rass.toFixed(1)}）
          <input type="range" min={-5} max={4} step={1} value={rass} onChange={(e) => setRass(Number(e.target.value))} />
        </label>
        <div className="row">
          <button className="btn" onClick={() => sim.setRassTarget(rass)}>
            鎮静を変更
          </button>
          <button
            className="btn"
            onClick={() => {
              setRass(0)
              sim.setRassTarget(0)
            }}
          >
            鎮静を中止（SAT）
          </button>
        </div>
        <p className="muted">深い鎮静（RASS −4〜−5）では自発呼吸が弱く、または消失します。浅くすると吸気努力と呼吸数が増えます（覚醒は数分かけて進みます）。</p>
        <label className="field" style={{ marginTop: 10 }}>
          ノルアドレナリン {na.toFixed(2)} μg/kg/分
          <input type="range" min={0} max={0.5} step={0.02} value={na} onChange={(e) => setNa(Number(e.target.value))} />
        </label>
        <button className="btn" onClick={() => sim.setNa(na)}>
          投与量を変更
        </button>
        {snap.vitals.arrest && (
          <div style={{ marginTop: 12 }}>
            <button className="btn danger" onClick={() => sim.resuscitate()}>
              蘇生（心拍再開）
            </button>
          </div>
        )}
        {level === 'detail' && (
          <>
            <h4>患者の内部状態</h4>
            <table className="data">
              <tbody>
                <tr><td>病態の残存</td><td>{fmt(pt.progress * 100)} %</td></tr>
                <tr><td>呼吸ドライブ</td><td>{fmt(pt.drive, 2)}</td></tr>
                <tr><td>吸気筋力（MIP）</td><td>{fmt(pt.pmaxEff)} cmH2O</td></tr>
                <tr><td>呼吸筋疲労</td><td>{fmt(pt.fatigue * 100)} %</td></tr>
                <tr><td>圧時間指数</td><td>{fmt(pt.ptiPct / 100, 2)}</td></tr>
                <tr><td>横隔膜筋力</td><td>{fmt(pt.diaphragm * 100)} %</td></tr>
                <tr><td>リクルートされた肺</td><td>{fmt(pt.recruit * 100)} %</td></tr>
                <tr><td>シャント率</td><td>{fmt(snap.gas.shunt * 100)} %</td></tr>
                <tr><td>死腔換気率 VD/VT</td><td>{fmt(snap.gas.vdvt, 2)}</td></tr>
                <tr><td>肺胞換気量</td><td>{fmt(snap.gas.va, 1)} L/分</td></tr>
                <tr><td>心拍出量</td><td>{fmt(snap.gas.co, 1)} L/分</td></tr>
                <tr><td>酸素運搬量 DO2</td><td>{fmt(snap.gas.do2)} mL/分</td></tr>
                <tr><td>SvO2</td><td>{fmt(snap.gas.svo2)} %</td></tr>
                <tr><td>分泌物</td><td>{fmt(pt.secretion * 100)} %</td></tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================
// 急変・処置
// ============================================================
const INTERVENTIONS: InterventionId[] = ['suction', 'chestDrain', 'reconnect', 'cuffAdjust', 'tubeReposition', 'tubeExchange', 'bronchodilator', 'fluid', 'sedate', 'recruit', 'prone', 'supine']

export function EventsPanel({ snap, level, hideActive }: { snap: Snapshot; level: Level; hideActive: boolean }) {
  const hub = useHub()
  const sim = hub.sim
  const [msg, setMsg] = useState('')
  const [rand, setRand] = useState(sim.randomEvents)
  return (
    <div className="cols">
      <div>
        <h3>急変を発生させる</h3>
        <p className="muted">急変を起こし、波形・アラーム・バイタルの変化から原因を見つけて対処する練習ができます。</p>
        <div className="event-grid">
          {(Object.keys(EVENT_INFO) as EventId[]).map((id) => {
            const active = snap.events.includes(id)
            const info = EVENT_INFO[id]
            return (
              <div key={id} className={`event-card${active && !hideActive ? ' active' : ''}`}>
                <span className="t">{info.name}</span>
                <span className="d">{info.description}</span>
                {level === 'basic' && <span className="d">対処: {info.fix}</span>}
                <button className="btn small" disabled={active} onClick={() => sim.triggerEvent(id)}>
                  {active && !hideActive ? '発生中' : '発生させる'}
                </button>
              </div>
            )
          })}
        </div>
        <label className="row" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={rand}
            onChange={(e) => {
              setRand(e.target.checked)
              sim.randomEvents = e.target.checked
            }}
          />
          ランダムに急変を発生させる（平均 4時間に1回）
        </label>
      </div>
      <div>
        <h3>処置</h3>
        <div className="row">
          {INTERVENTIONS.map((id) => (
            <button key={id} className="btn" onClick={() => setMsg(sim.intervene(id))} disabled={(id === 'prone' && snap.patient.prone) || (id === 'supine' && !snap.patient.prone)}>
              {INTERVENTION_INFO[id]}
            </button>
          ))}
        </div>
        {msg && <p style={{ marginTop: 8 }}>実施: {msg}</p>}
        <p className="muted" style={{ marginTop: 8 }}>
          輸液 計 {(snap.patient.fluid / 1.4 * 500).toFixed(0)} mL ／ 体位 {snap.patient.prone ? '腹臥位' : '仰臥位'}
        </p>
        <h4>記録</h4>
        <LogList />
      </div>
    </div>
  )
}

function LogList() {
  const hub = useHub()
  const sim = hub.sim
  const items = sim.log.slice(-60).reverse()
  return (
    <div className="log">
      {items.length === 0 && <div className="muted">まだ記録はありません</div>}
      {items.map((l, i) => (
        <div key={i}>
          <span className="time">{fmtTime(l.t - sim.t0)}</span>
          <span className={l.kind === 'alarm' ? 'alarm-t' : l.kind === 'event' ? 'event-t' : ''}>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// ウィーニング・抜管
// ============================================================
export function WeaningPanel({ snap, onExtubated, onIntubated }: { snap: Snapshot; onExtubated: (s: VentSettings) => void; onIntubated: (s: VentSettings) => void }) {
  const hub = useHub()
  const sim = hub.sim
  const [method, setMethod] = useState<SbtMethod>('psv')
  const [mins, setMins] = useState(30)
  const [msg, setMsg] = useState('')
  const [showExt, setShowExt] = useState(false)
  const intub = snap.airway === 'intubated'
  const sbt = snap.sbt
  const g = snap.gas
  const s = sim.settings
  const peep = sim.basePressure()
  const fio2 = s.fio2
  const lastAbg = sim.abgs[sim.abgs.length - 1]

  type C = { label: string; ok: boolean | null; note?: string }
  const checks: C[] = [
    { label: '原疾患が改善している', ok: snap.patient.progress < 0.45, note: `病態の残存 ${(snap.patient.progress * 100).toFixed(0)}%` },
    { label: '酸素化: P/F ≥ 150、PEEP ≤ 8、FiO2 ≤ 0.5', ok: g.pf >= 150 && peep <= 8 && fio2 <= 0.5, note: `P/F ${g.pf.toFixed(0)}・PEEP ${peep.toFixed(0)}・FiO2 ${fio2.toFixed(2)}` },
    { label: '循環が安定（MAP ≥ 65、昇圧薬が少量）', ok: snap.vitals.map >= 65 && snap.patient.na <= 0.1 && snap.vitals.hr < 130 },
    { label: '覚醒している（RASS −1〜+1）', ok: snap.patient.rass >= -1.2 && snap.patient.rass <= 1.2, note: `RASS ${snap.patient.rass.toFixed(1)}` },
    { label: '自発呼吸がある', ok: snap.patient.drive > 0.25 && snap.patient.rrPatient > 4 },
    { label: 'pH ≥ 7.30', ok: lastAbg ? lastAbg.ph >= 7.3 : null, note: lastAbg ? `直近の血ガス pH ${lastAbg.ph.toFixed(2)}` : '血液ガス未採取' },
    { label: 'SBT成功', ok: sbt ? sbt.result === 'pass' : null, note: sbt ? ({ running: '実施中', pass: '成功', fail: '失敗', aborted: '中止' } as const)[sbt.result ?? 'running'] : '未実施' },
    { label: '咳嗽が十分', ok: sim.coughAssessed ? sim.coughAssessed.cough !== '弱い' : null, note: sim.coughAssessed ? `咳嗽 ${sim.coughAssessed.cough}` : '未評価' },
    { label: '分泌物が多くない', ok: sim.coughAssessed ? sim.coughAssessed.secretion !== '多量' : null, note: sim.coughAssessed ? `分泌物 ${sim.coughAssessed.secretion}` : '未評価' },
    { label: 'カフリーク ≥ 110 mL（喉頭浮腫のリスク）', ok: sim.cuffLeakTested !== null ? sim.cuffLeakTested >= 110 : null, note: sim.cuffLeakTested !== null ? `${sim.cuffLeakTested.toFixed(0)} mL` : '未測定' },
  ]

  const skip = (h: number) => {
    const e = sim.skipHours(h)
    setMsg(e ?? `${h}時間経過しました`)
  }

  return (
    <div className="cols">
      <div>
        <h3>時間を進める</h3>
        <p className="muted">病態は時間とともに改善します（肺傷害を起こす設定では改善が遅れます）。数時間〜数日単位の経過はここで進め、SBT中は画面上部の速度変更を使います。</p>
        <div className="row">
          <button className="btn" onClick={() => skip(1)} disabled={!!sbt?.active}>
            +1時間
          </button>
          <button className="btn" onClick={() => skip(6)} disabled={!!sbt?.active}>
            +6時間
          </button>
          <button className="btn" onClick={() => skip(24)} disabled={!!sbt?.active}>
            +24時間
          </button>
        </div>
        {msg && <p>{msg}</p>}
        <h3 style={{ marginTop: 16 }}>抜管の準備状況</h3>
        <ul className="checklist">
          {checks.map((c) => (
            <li key={c.label}>
              <span className={`mark ${c.ok === null ? 'na' : c.ok ? 'ok' : 'ng'}`}>{c.ok === null ? '−' : c.ok ? '✓' : '✗'}</span>
              <span style={{ flex: 1 }}>{c.label}</span>
              <span className="muted">{c.note}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>SAT・SBT</h3>
        {intub ? (
          <>
            <div className="row">
              <button className="btn" onClick={() => sim.setRassTarget(0)}>
                SAT（鎮静を中止）
              </button>
              <span className="muted">RASS {snap.patient.rass.toFixed(1)}</span>
            </div>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <label className="field">
                SBTの方法
                <select value={method} onChange={(e) => setMethod(e.target.value as SbtMethod)}>
                  <option value="psv">PS 5 / PEEP 5</option>
                  <option value="cpap">CPAP 5</option>
                  <option value="tpiece">Tピース</option>
                </select>
              </label>
              <label className="field">
                時間
                <select value={mins} onChange={(e) => setMins(Number(e.target.value))}>
                  <option value={30}>30分</option>
                  <option value={60}>60分</option>
                  <option value={120}>120分</option>
                </select>
              </label>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              {!sbt?.active ? (
                <button className="btn primary" onClick={() => setMsg(sim.startSbt(method, mins) ?? 'SBTを開始しました。速度を上げると経過を早く観察できます。')}>
                  SBTを開始
                </button>
              ) : (
                <button className="btn" onClick={() => sim.stopSbt()}>
                  SBTを中止して元の設定に戻す
                </button>
              )}
              <button className="btn" onClick={() => setMsg(`カフリーク量 ${sim.cuffLeakTest()?.toFixed(0)} mL`)}>
                カフリークテスト
              </button>
              <button
                className="btn"
                onClick={() => {
                  const r = sim.coughAssessment()
                  setMsg(`咳嗽 ${r.cough}・分泌物 ${r.secretion}`)
                }}
              >
                咳嗽・分泌物の評価
              </button>
            </div>
            {sbt && (
              <div className={`finding ${sbt.result === 'fail' ? 'danger' : sbt.result === 'pass' ? 'good' : ''}`} style={{ marginTop: 10 }}>
                <b>
                  SBT {({ running: '実施中', pass: '成功', fail: '失敗', aborted: '中止' } as const)[sbt.result ?? 'running']}（
                  {fmtTime((sbt.endedAt ?? snap.t) - sbt.start)} / {sbt.duration / 60}分）
                </b>
                <p>
                  RSBI {sbt.rsbi !== null ? `${sbt.rsbi.toFixed(0)} 回/分/L` : '（開始2分後に測定）'}・呼吸数 {snap.patient.rrPatient.toFixed(0)}・SpO2{' '}
                  {fmt(snap.vitals.spo2)}%・HR {snap.vitals.hr.toFixed(0)}（開始時 {sbt.baseline.hr.toFixed(0)}）
                </p>
                {sbt.failReasons.length > 0 && <p>中止理由: {sbt.failReasons.join('、')}</p>}
              </div>
            )}
            <p className="muted">
              中止基準: 呼吸数 &gt; 35 の持続、SpO2 &lt; 90%、心拍数 &gt; 140 または 20%以上の上昇、収縮期血圧 &gt; 180 または &lt; 90、PaCO2 10 mmHg 以上の上昇、努力呼吸・不穏。
            </p>
            {msg && <p>{msg}</p>}
            <h3 style={{ marginTop: 14 }}>抜管</h3>
            <button className="btn primary" onClick={() => setShowExt(true)}>
              抜管する…
            </button>
          </>
        ) : (
          <>
            <p>
              抜管後 {sim.extubatedAt !== null ? fmtTime(snap.t - sim.extubatedAt) : '---'} 経過。呼吸数 {snap.patient.rrPatient.toFixed(0)}・RSBI {fmt(snap.patient.rsbi)}・SpO2{' '}
              {fmt(snap.vitals.spo2)}%
            </p>
            {snap.patient.edema > 0.05 && <div className="finding danger"><b>吸気性喘鳴（stridor）</b><p>上気道の狭窄が進んでいます（喉頭浮腫）。</p></div>}
            <p className="muted">抜管後は呼吸数・呼吸補助筋の使用・SpO2・意識・痰の量を観察します。悪化すれば NPPV/HFNC の調整または再挿管を判断します。</p>
            <button
              className="btn danger"
              onClick={() => {
                const s0 = sim.lastInvasive ?? { ...DEFAULT_SETTINGS, mode: 'VC-AC' as const, vt: Math.round((snap.ibw * 7) / 10) * 10 }
                sim.intubate(s0)
                onIntubated(sim.settings)
              }}
            >
              挿管する（人工呼吸を開始）
            </button>
          </>
        )}
      </div>
      {showExt && (
        <ExtubateDialog
          onClose={() => setShowExt(false)}
          onDo={(post) => {
            sim.extubate(post)
            onExtubated(sim.settings)
            setShowExt(false)
          }}
        />
      )}
    </div>
  )
}

function ExtubateDialog({ onClose, onDo }: { onClose: () => void; onDo: (s: VentSettings) => void }) {
  const hub = useHub()
  const base = hub.sim.settings
  const [kind, setKind] = useState<'cannula' | 'mask' | 'hfnc' | 'nppv'>('cannula')
  const [flow, setFlow] = useState(2)
  const [fio2, setFio2] = useState(0.4)
  const [hfFlow, setHfFlow] = useState(50)
  const [ipap, setIpap] = useState(10)
  const [epap, setEpap] = useState(5)
  const make = (): VentSettings => {
    if (kind === 'cannula') return { ...base, mode: 'O2', o2Device: 'cannula', o2Flow: flow }
    if (kind === 'mask') return { ...base, mode: 'O2', o2Device: 'mask', o2Flow: flow }
    if (kind === 'hfnc') return { ...base, mode: 'HFNC', hfncFlow: hfFlow, fio2 }
    return { ...base, mode: 'NPPV-ST', ipap, epap, fio2, nppvRR: 12 }
  }
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="抜管後の酸素療法">
      <div className="modal">
        <h3>抜管後の呼吸サポートを選ぶ</h3>
        <p className="muted">再挿管のリスクが高い患者（高齢・心不全・COPD・肥満・高CO2）では、抜管直後からのNPPVやHFNCが再挿管を減らすことが示されています。</p>
        <div className="seg" style={{ margin: '8px 0' }}>
          {(
            [
              ['cannula', '鼻カニュラ'],
              ['mask', '簡易マスク'],
              ['hfnc', 'HFNC'],
              ['nppv', 'NPPV'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="form-grid">
          {(kind === 'cannula' || kind === 'mask') && (
            <label className="field">
              酸素流量 L/分
              <input type="number" min={1} max={10} value={flow} onChange={(e) => setFlow(Number(e.target.value))} />
            </label>
          )}
          {kind === 'hfnc' && (
            <label className="field">
              流量 L/分
              <input type="number" min={10} max={60} step={5} value={hfFlow} onChange={(e) => setHfFlow(Number(e.target.value))} />
            </label>
          )}
          {kind === 'nppv' && (
            <>
              <label className="field">
                IPAP
                <input type="number" min={6} max={25} value={ipap} onChange={(e) => setIpap(Number(e.target.value))} />
              </label>
              <label className="field">
                EPAP
                <input type="number" min={4} max={12} value={epap} onChange={(e) => setEpap(Number(e.target.value))} />
              </label>
            </>
          )}
          {(kind === 'hfnc' || kind === 'nppv') && (
            <label className="field">
              FiO2
              <input type="number" min={0.21} max={1} step={0.05} value={fio2} onChange={(e) => setFio2(Number(e.target.value))} />
            </label>
          )}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn confirm" onClick={() => onDo(make())}>
            抜管する
          </button>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 血液ガス
// ============================================================
export function AbgPanel() {
  const hub = useHub()
  const sim = hub.sim
  const [, force] = useState(0)
  const list = sim.abgs.slice().reverse()
  const cls = (v: number, lo: number, hi: number) => (v < lo ? 'lo' : v > hi ? 'hi' : '')
  return (
    <div>
      <div className="row">
        <button
          className="btn primary"
          onClick={() => {
            sim.sampleAbg()
            force((x) => x + 1)
          }}
        >
          動脈血ガスを採取
        </button>
        <span className="muted">結果はすぐに表示されます。設定変更の効果はCO2で数分〜十数分、酸素化で数分かけて現れます。</span>
      </div>
      {list.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>
          まだ採取していません。
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>時刻</th>
                <th>pH</th>
                <th>PaCO2</th>
                <th>PaO2</th>
                <th>HCO3-</th>
                <th>BE</th>
                <th>SaO2</th>
                <th>Lac</th>
                <th>FiO2</th>
                <th>P/F</th>
                <th>A-aDO2</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                <tr key={i}>
                  <td>{fmtTime(a.t - sim.t0)}</td>
                  <td className={cls(a.ph, 7.35, 7.45)}>{a.ph.toFixed(2)}</td>
                  <td className={cls(a.paco2, 35, 45)}>{a.paco2.toFixed(0)}</td>
                  <td className={cls(a.pao2, 60, 999)}>{a.pao2.toFixed(0)}</td>
                  <td className={cls(a.hco3, 22, 26)}>{a.hco3.toFixed(1)}</td>
                  <td className={cls(a.be, -2, 2)}>{a.be.toFixed(1)}</td>
                  <td>{a.sao2.toFixed(1)}</td>
                  <td className={cls(a.lactate, 0, 2)}>{a.lactate.toFixed(1)}</td>
                  <td>{a.fio2.toFixed(2)}</td>
                  <td className={a.pf < 300 ? 'hi' : ''}>{a.pf.toFixed(0)}</td>
                  <td>{a.aado2.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 10 }}>
        単位: PaCO2・PaO2・A-aDO2 は mmHg、HCO3-・BE・乳酸 は mmol/L。P/F比 &lt; 300 で酸素化障害（ARDSの重症度: 200〜300 軽症、100〜200 中等症、&lt;100 重症）。
      </p>
    </div>
  )
}

// ============================================================
// トレンド
// ============================================================
const TREND_SERIES: { key: string; label: string; color: string; get: (p: import('../engine/types').TrendPoint) => number; min: number; max: number; unit: string }[] = [
  { key: 'spo2', label: 'SpO2', color: '#3dd6f5', get: (p) => p.spo2, min: 70, max: 100, unit: '%' },
  { key: 'hr', label: 'HR', color: '#3be36b', get: (p) => p.hr, min: 40, max: 160, unit: '/分' },
  { key: 'map', label: 'MAP', color: '#ff5a52', get: (p) => p.map, min: 30, max: 130, unit: 'mmHg' },
  { key: 'etco2', label: 'EtCO2', color: '#f5e04a', get: (p) => p.etco2, min: 0, max: 80, unit: 'mmHg' },
  { key: 'paco2', label: 'PaCO2', color: '#ffb36b', get: (p) => p.paco2, min: 20, max: 100, unit: 'mmHg' },
  { key: 'rr', label: 'RR', color: '#c9d6de', get: (p) => p.rr, min: 0, max: 50, unit: '/分' },
  { key: 'vt', label: 'VTe', color: '#7aa7ff', get: (p) => p.vt, min: 0, max: 900, unit: 'mL' },
  { key: 'ppeak', label: 'Ppeak', color: '#f2c14e', get: (p) => p.ppeak, min: 0, max: 50, unit: 'cmH2O' },
  { key: 'fio2', label: 'FiO2', color: '#e6e6e6', get: (p) => p.fio2 * 100, min: 20, max: 100, unit: '%' },
]

export function TrendPanel() {
  const hub = useHub()
  const ref = useRef<HTMLCanvasElement>(null)
  const [range, setRange] = useState<number>(1800)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 2000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const sim = hub.sim
    const dpr = window.devicePixelRatio || 1
    const rows = TREND_SERIES.length
    const rowH = 54
    const W = Math.round(c.clientWidth * dpr)
    const H = Math.round(rows * rowH * dpr)
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#0f1c25'
    ctx.fillRect(0, 0, W, H)
    const all = sim.trends
    const tEnd = sim.t
    const tStart = range > 0 ? tEnd - range : all[0]?.t ?? tEnd - 60
    const pts = all.filter((p) => p.t >= tStart)
    const left = 90 * dpr
    const right = 54 * dpr
    const X = (t: number) => left + ((t - tStart) / Math.max(1, tEnd - tStart)) * (W - left - right)
    ctx.font = `${12 * dpr}px 'BIZ UDPGothic', sans-serif`
    TREND_SERIES.forEach((s, i) => {
      const y0 = i * rowH * dpr
      const h = rowH * dpr
      ctx.strokeStyle = '#24394a'
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.moveTo(0, y0 + h - 0.5)
      ctx.lineTo(W, y0 + h - 0.5)
      ctx.stroke()
      ctx.fillStyle = s.color
      ctx.fillText(s.label, 8 * dpr, y0 + 18 * dpr)
      ctx.fillStyle = '#7b8f9c'
      ctx.font = `${10 * dpr}px 'Barlow Semi Condensed', sans-serif`
      ctx.fillText(`${s.min}–${s.max} ${s.unit}`, 8 * dpr, y0 + 34 * dpr)
      ctx.font = `${12 * dpr}px 'BIZ UDPGothic', sans-serif`
      const Y = (v: number) => y0 + h - 4 * dpr - ((Math.min(s.max, Math.max(s.min, v)) - s.min) / (s.max - s.min)) * (h - 8 * dpr)
      ctx.strokeStyle = s.color
      ctx.lineWidth = 1.6 * dpr
      ctx.beginPath()
      let started = false
      let lastT = -1
      for (const p of pts) {
        const v = s.get(p)
        if (!Number.isFinite(v)) {
          started = false
          continue
        }
        const gapBreak = lastT >= 0 && p.t - lastT > 120
        if (!started || gapBreak) {
          // 時間スキップは破線で結ぶ
          if (gapBreak && started) {
            ctx.stroke()
            ctx.setLineDash([3 * dpr, 3 * dpr])
            ctx.beginPath()
            const prev = pts[pts.indexOf(p) - 1]
            ctx.moveTo(X(prev.t), Y(s.get(prev)))
            ctx.lineTo(X(p.t), Y(v))
            ctx.stroke()
            ctx.setLineDash([])
            ctx.beginPath()
          }
          ctx.moveTo(X(p.t), Y(v))
          started = true
        } else ctx.lineTo(X(p.t), Y(v))
        lastT = p.t
      }
      ctx.stroke()
      const lastP = pts[pts.length - 1]
      if (lastP) {
        ctx.fillStyle = s.color
        ctx.textAlign = 'right'
        ctx.font = `${16 * dpr}px 'Barlow Semi Condensed', sans-serif`
        const val = s.get(lastP)
        ctx.fillText(Number.isFinite(val) ? val.toFixed(0) : '---', W - 8 * dpr, y0 + 32 * dpr)
        ctx.textAlign = 'left'
        ctx.font = `${12 * dpr}px 'BIZ UDPGothic', sans-serif`
      }
    })
  })
  const sim = hub.sim
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span>表示範囲</span>
        <div className="seg">
          {(
            [
              [600, '10分'],
              [1800, '30分'],
              [7200, '2時間'],
              [43200, '12時間'],
              [0, '全期間'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} aria-pressed={range === v} onClick={() => setRange(v)}>
              {l}
            </button>
          ))}
        </div>
        <span className="muted">
          {fmtTime(sim.t - sim.t0)} 経過（時間を進めた区間は破線）
        </span>
      </div>
      <canvas ref={ref} className="trend-canvas" style={{ height: TREND_SERIES.length * 54 }} aria-label="トレンドグラフ" />
    </div>
  )
}

// ============================================================
// アラーム設定
// ============================================================
const ALARM_FIELDS: { key: keyof AlarmSettings; label: string; unit: string; step: number }[] = [
  { key: 'pHigh', label: '気道内圧 上限', unit: 'cmH2O', step: 1 },
  { key: 'pLow', label: '気道内圧 下限（回路外れ）', unit: 'cmH2O', step: 1 },
  { key: 'mvHigh', label: '分時換気量 上限', unit: 'L/分', step: 0.5 },
  { key: 'mvLow', label: '分時換気量 下限', unit: 'L/分', step: 0.5 },
  { key: 'vtHigh', label: '1回換気量 上限', unit: 'mL', step: 10 },
  { key: 'vtLow', label: '1回換気量 下限', unit: 'mL', step: 10 },
  { key: 'rrHigh', label: '呼吸回数 上限', unit: '回/分', step: 1 },
  { key: 'apnea', label: '無呼吸時間', unit: '秒', step: 5 },
  { key: 'spo2Low', label: 'SpO2 下限', unit: '%', step: 1 },
  { key: 'hrHigh', label: '心拍数 上限', unit: '/分', step: 5 },
  { key: 'hrLow', label: '心拍数 下限', unit: '/分', step: 5 },
  { key: 'sbpHigh', label: '収縮期血圧 上限', unit: 'mmHg', step: 5 },
  { key: 'sbpLow', label: '収縮期血圧 下限', unit: 'mmHg', step: 5 },
  { key: 'etco2High', label: 'EtCO2 上限', unit: 'mmHg', step: 1 },
  { key: 'etco2Low', label: 'EtCO2 下限', unit: 'mmHg', step: 1 },
]

export function AlarmPanel({ sound, setSound }: { sound: boolean; setSound: (b: boolean) => void }) {
  const hub = useHub()
  const sim = hub.sim
  const [a, setA] = useState<AlarmSettings>(sim.alarmSettings)
  useEffect(() => setA(sim.alarmSettings), [hub.generation, sim.alarmSettings])
  const dirty = JSON.stringify(a) !== JSON.stringify(sim.alarmSettings)
  return (
    <div>
      <p className="muted">気道内圧上限に達すると、吸気はその時点で打ち切られます（従量式では換気量が入りません）。</p>
      <div className="form-grid">
        {ALARM_FIELDS.map((f) => (
          <label key={f.key} className="field">
            {f.label}（{f.unit}）
            <input type="number" step={f.step} value={a[f.key]} onChange={(e) => setA({ ...a, [f.key]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn confirm" disabled={!dirty} onClick={() => sim.setAlarmSettings(a)}>
          アラーム設定を確定
        </button>
        <label className="row">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
          アラーム音を鳴らす
        </label>
      </div>
      {!isVentMode(sim.settings.mode) && <p className="muted">現在は人工呼吸器を使用していないため、呼吸器のアラームは監視されません。</p>}
    </div>
  )
}
