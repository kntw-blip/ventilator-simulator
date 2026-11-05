import type { ReactNode } from 'react'
import { CH, isNppv, isVentMode, type Snapshot } from '../engine/simulator'
import { modeInfo } from '../engine/defaults'
import { Waveform } from './Waveform'
import { Loop } from './Loops'
import { fmt, useHub } from './hub'
import type { Level } from './types'

function N({ k, v, u, cls, wide, sub }: { k: ReactNode; v: ReactNode; u?: string; cls?: string; wide?: boolean; sub?: ReactNode }) {
  return (
    <div className={`vnum${wide ? ' wide' : ''}`}>
      <div className="k">
        <span>{k}</span>
        {sub && <span>{sub}</span>}
      </div>
      <div className={`v ${cls ?? ''}`}>
        {v}
        {u && <small>{u}</small>}
      </div>
    </div>
  )
}

export function VentScreen({ snap, level }: { snap: Snapshot; level: Level }) {
  const hub = useHub()
  const sim = hub.sim
  const m = snap.mode
  const vent = isVentMode(m)
  const v = snap.vent
  const s = sim.settings
  const detail = level === 'detail'
  const est = !vent || !snap.connected
  const wh = detail ? 96 : 110
  const ventAlarms = snap.alarms
  const fio2 = m === 'HFNC' || m === 'O2' ? snap.gas.fio2Eff : s.fio2
  const pplatHi = v.pplat !== null && v.pplat > 30
  const vtkgHi = v.vtPerKg > 8.5

  return (
    <div className="screen">
      <div className="alarmbar" role="status" aria-live="polite">
        <span className="mode-tag">{modeInfo(m).short}</span>
        {snap.sbt?.active && <span className="alarm medium">SBT実施中</span>}
        {v.backup && m === 'PSV' && <span className="alarm medium">バックアップ換気</span>}
        {snap.recruiting && <span className="alarm medium">リクルートメント中</span>}
        {ventAlarms.length === 0 && <span className="quiet">アラームなし</span>}
        {ventAlarms
          .slice()
          .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1))
          .map((a) => (
            <span key={a.id} className={`alarm ${a.priority}`}>
              {a.label}
            </span>
          ))}
        <span className="spacer" />
        {snap.muted && <span className="quiet">消音中</span>}
      </div>
      <div className={`vent-body${detail ? ' detail' : ''}`}>
        <div className="waves">
          <Waveform
            ch={CH.paw}
            color="#f2c14e"
            label={est ? '気道内圧（推定）' : '気道内圧'}
            unit="cmH2O"
            height={wh}
            scales={[20, 30, 40, 50, 60, 80]}
            minFloor={0}
          />
          <Waveform
            ch={CH.flow}
            color="#4fd1a5"
            label={est ? '流量（患者・推定）' : '流量'}
            unit="L/分"
            height={wh}
            scales={[30, 60, 90, 120, 180]}
            symmetric
          />
          <Waveform ch={CH.vol} color="#7aa7ff" label={est ? '換気量（推定）' : '換気量'} unit="mL" height={wh} scales={[300, 600, 900, 1200, 1500, 2000]} minFloor={0} />
          {detail && <Waveform ch={CH.pes} color="#e98bd2" label="食道内圧 Pes" unit="cmH2O" height={80} scales={[10, 20, 30, 40]} symmetric />}
        </div>
        <div className="vnums">
          {vent ? (
            <>
              <N k="Ppeak" v={fmt(v.ppeak)} u="cmH2O" cls={v.ppeak > 35 ? 'bad' : ''} />
              <N k="Pmean" v={fmt(v.pmean, 1)} u="cmH2O" />
              <N k="PEEP" v={fmt(v.peepMeasured, 1)} u="cmH2O" sub={`設定 ${fmt(v.peepSet)}`} />
              <N
                k="Pplat"
                v={fmt(v.pplat, 1)}
                u="cmH2O"
                cls={pplatHi ? 'bad' : ''}
                sub={v.pplatAge !== null ? `${Math.round(v.pplatAge / 60)}分前` : '未測定'}
              />
              <N k="VTe" v={fmt(v.vte)} u="mL" cls={vtkgHi ? 'warn' : ''} sub={`${fmt(v.vtPerKg, 1)} mL/kg`} />
              <N k="MVe" v={fmt(v.mve, 1)} u="L/分" />
              <N k="RR（総）" v={fmt(v.rrTot)} u="回/分" />
              <N k="FiO2" v={fmt(fio2 * 100)} u="%" />
              <N k="I:E" v={v.ie} sub={`Ti ${fmt(v.ti, 2)}s`} />
              {isNppv(m) || v.leak > 0.5 ? <N k="リーク" v={fmt(v.leak)} u="L/分" cls={v.leak > (isNppv(m) ? 60 : 10) ? 'warn' : ''} /> : <N k="VTi" v={fmt(v.vti)} u="mL" />}
              {detail && (
                <>
                  <N k="RR（自発）" v={fmt(v.rrSpont)} u="回/分" />
                  <N k="ΔP（駆動圧）" v={fmt(v.drivingP, 1)} u="cmH2O" cls={v.drivingP !== null && v.drivingP > 15 ? 'bad' : ''} />
                  <N k="Crs" v={fmt(v.crs)} u="mL/cmH2O" />
                  <N k="Raw" v={fmt(v.raw)} u="cmH2O/L/s" />
                  <N k="総PEEP" v={fmt(v.peepTot, 1)} u="cmH2O" sub={v.peepTotAge !== null ? `${Math.round(v.peepTotAge / 60)}分前` : '未測定'} />
                  <N k="auto-PEEP" v={fmt(v.autoPeep, 1)} u="cmH2O" cls={v.autoPeep !== null && v.autoPeep > 3 ? 'warn' : ''} />
                  <N k="時定数 τ" v={fmt(v.tau, 2)} u="s" />
                  <N k="P0.1" v={fmt(snap.patient.p01, 1)} u="cmH2O" cls={snap.patient.p01 > 3.5 ? 'warn' : ''} />
                  <N k="非同調指数" v={fmt(snap.async.index)} u="%" cls={snap.async.index > 10 ? 'warn' : ''} />
                  <N k="RSBI" v={fmt(snap.patient.rsbi)} u="回/分/L" cls={snap.patient.rsbi !== null && snap.patient.rsbi > 105 ? 'warn' : ''} />
                  {m === 'PRVC' && <N k="PRVC 吸気圧" v={fmt(v.prvcP, 1)} u="cmH2O" wide />}
                </>
              )}
            </>
          ) : (
            <>
              <N k="呼吸数" v={fmt(snap.patient.rrPatient)} u="回/分" />
              <N k="1回換気量（推定）" v={fmt(snap.patient.vtSpont)} u="mL" />
              <N k="分時換気量（推定）" v={fmt((snap.patient.vtSpont * snap.patient.rrPatient) / 1000, 1)} u="L/分" />
              <N k="実効FiO2" v={fmt(snap.gas.fio2Eff * 100)} u="%" sub={m === 'HFNC' ? `設定 ${fmt(s.fio2 * 100)}%` : undefined} />
              {m === 'HFNC' && <N k="流量" v={fmt(s.hfncFlow)} u="L/分" />}
              {m === 'HFNC' && <N k="推定PEEP" v={fmt(sim.hfncPeep(), 1)} u="cmH2O" />}
              {m === 'TPIECE' && <N k="O2" v={fmt(s.fio2 * 100)} u="%" />}
              <N k="RSBI" v={fmt(snap.patient.rsbi)} u="回/分/L" cls={snap.patient.rsbi !== null && snap.patient.rsbi > 105 ? 'warn' : ''} />
              {detail && <N k="P0.1" v={fmt(snap.patient.p01, 1)} u="cmH2O" />}
            </>
          )}
        </div>
      </div>
      <div className="loops">
        <Loop kind="pv" height={detail ? 150 : 140} />
        <Loop kind="fv" height={detail ? 150 : 140} />
      </div>
      <div className="vent-toolbar">
        <button className="lcd-btn" onClick={() => sim.inspHold()} disabled={!vent || m === 'APRV'}>
          吸気ポーズ（Pplat測定）
        </button>
        <button className="lcd-btn" onClick={() => sim.expHold()} disabled={!vent || m === 'APRV' || isNppv(m)}>
          呼気ポーズ（総PEEP測定）
        </button>
        <button className="lcd-btn" onClick={() => sim.muteAlarms(120)}>
          アラーム消音 2分
        </button>
        <span className="note">
          {sim.pplatMeasured?.effort && v.pplat !== null ? '※ポーズ中に自発呼吸あり：Pplatは参考値 ' : ''}
          {sim.peepTotMeasured?.effort && v.peepTot !== null ? '※呼気ポーズ中に自発呼吸あり：総PEEPは参考値' : ''}
          {!vent && '補助なしのため、波形は患者の呼吸から推定した値です'}
        </span>
      </div>
    </div>
  )
}
