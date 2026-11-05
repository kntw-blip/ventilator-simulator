import { useState } from 'react'
import type { Scenario } from './scenarios'
import { SCENARIOS } from './scenarios'
import { fmtTime } from '../ui/hub'

export interface ScenarioMetrics {
  hypoxSec: number
  pplatSec: number
  hypotSec: number
  highVtSec: number
  arrest: boolean
  stepTimes: number[]
}

export interface ScenarioRun {
  sc: Scenario
  idx: number
  stepStart: number
  holdAcc: number
  phase: 'doing' | 'done' | 'finished'
  startT: number
  metrics: ScenarioMetrics
}

export function ScenarioPicker({ onPick, onClose }: { onPick: (s: Scenario) => void; onClose: () => void }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="学習シナリオを選ぶ">
      <div className="modal">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>学習シナリオを選ぶ</h3>
          <button className="btn" onClick={onClose}>
            閉じる
          </button>
        </div>
        <p className="muted">課題を順に進めます。各ステップの達成条件を満たすと解説が表示されます。安全に関わる指標（低酸素・高いプラトー圧・低血圧・過大な換気量）の時間が記録され、最後に振り返りが表示されます。</p>
        <div className="scenario-list">
          {SCENARIOS.map((s) => (
            <button key={s.id} className="scenario-card" onClick={() => onPick(s)}>
              <b>{s.title}</b>
              <span className="muted">{s.summary}</span>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {s.goals.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ScenarioPanel({ run, simT, onNext, onExit }: { run: ScenarioRun; simT: number; onNext: () => void; onExit: () => void }) {
  const [hint, setHint] = useState(false)
  const st = run.sc.steps[run.idx]
  const m = run.metrics
  const score = Math.max(0, Math.round(100 - m.hypoxSec / 30 - m.pplatSec / 60 - m.hypotSec / 30 - m.highVtSec / 120 - (m.arrest ? 40 : 0)))
  if (run.phase === 'finished') {
    return (
      <div className="scenario">
        <div className="scenario-head">
          <h2>{run.sc.title}：振り返り</h2>
          <span className="spacer" />
          <button className="btn" onClick={onExit}>
            シナリオを終了
          </button>
        </div>
        <p>
          所要時間（シミュレーション時間）{fmtTime(simT - run.startT)}・安全性スコア <b className="num" style={{ fontSize: 20 }}>{score}</b> / 100
        </p>
        <table className="data">
          <tbody>
            <tr><td>SpO2 &lt; 88% の時間</td><td>{fmtTime(m.hypoxSec)}</td></tr>
            <tr><td>プラトー圧 &gt; 30 cmH2O の時間</td><td>{fmtTime(m.pplatSec)}</td></tr>
            <tr><td>MAP &lt; 65 mmHg の時間</td><td>{fmtTime(m.hypotSec)}</td></tr>
            <tr><td>1回換気量 &gt; 8.5 mL/kg の時間</td><td>{fmtTime(m.highVtSec)}</td></tr>
            <tr><td>心停止</td><td>{m.arrest ? 'あり' : 'なし'}</td></tr>
          </tbody>
        </table>
        <p className="muted">スコアは安全に関わる指標が目標を外れていた時間から計算しています。時間スキップ中の値は含みません。</p>
      </div>
    )
  }
  return (
    <div className="scenario" aria-live="polite">
      <div className="scenario-head">
        <h2>{run.sc.title}</h2>
        <span className="muted">
          ステップ {run.idx + 1} / {run.sc.steps.length}：{st.title}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={onExit}>
          シナリオを中止
        </button>
      </div>
      <div className="steps" aria-hidden="true">
        {run.sc.steps.map((_, i) => (
          <div key={i} className={`step-pip${i < run.idx || (i === run.idx && run.phase === 'done') ? ' done' : i === run.idx ? ' cur' : ''}`} />
        ))}
      </div>
      {run.idx === 0 && run.phase === 'doing' && <p className="muted">{run.sc.summary}</p>}
      <div className="instr">{st.instruction}</div>
      {run.phase === 'doing' && st.hold && run.holdAcc > 0 && (
        <p className="muted">
          条件を満たしています… {Math.floor(run.holdAcc)} / {st.hold} 秒
        </p>
      )}
      {run.phase === 'doing' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" onClick={() => setHint((h) => !h)}>
            {hint ? 'ヒントを隠す' : 'ヒントを見る'}
          </button>
        </div>
      )}
      {hint && run.phase === 'doing' && <div className="hint">{st.hint}</div>}
      {run.phase === 'done' && (
        <>
          <div className="feedback">
            <b>達成しました。</b> {st.feedback}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                setHint(false)
                onNext()
              }}
            >
              {run.idx + 1 < run.sc.steps.length ? '次のステップへ' : '振り返りを見る'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
