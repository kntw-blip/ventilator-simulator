import { CH, type Snapshot } from '../engine/simulator'
import { Waveform } from './Waveform'
import { fmt, useHub } from './hub'

export function Monitor({ snap }: { snap: Snapshot }) {
  const hub = useHub()
  const al = hub.sim.alarmSettings
  const v = snap.vitals
  const has = (id: string) => snap.alarms.some((a) => a.id === id)
  const bg = '#000'
  const capOK = Number.isFinite(v.etco2)
  return (
    <div className="screen">
      <div className="mon-row">
        <Waveform ch={CH.ecg} color="#3be36b" label="II" height={92} range={{ min: -0.45, max: 1.25 }} bg={bg} grid="#111" windowSec={6} showScale={false} zeroLine={false} lineWidth={1.5} />
        <div className="mon-num" style={{ color: '#3be36b' }}>
          <div className="k">
            <span>HR</span>
            <span>
              {al.hrHigh}/{al.hrLow}
            </span>
          </div>
          <div className={`v num${has('hrhigh') || has('hrlow') || has('arrest') ? ' alarm-on' : ''}`}>{v.arrest ? '0' : fmt(v.hr)}</div>
        </div>
      </div>
      <div className="mon-row">
        <Waveform ch={CH.pleth} color="#3dd6f5" label="Pleth" height={70} range={{ min: -0.1, max: 1.7 }} bg={bg} windowSec={6} showScale={false} zeroLine={false} />
        <div className="mon-num" style={{ color: '#3dd6f5' }}>
          <div className="k">
            <span>SpO2 %</span>
            <span>{al.spo2Low}</span>
          </div>
          <div className={`v num${has('spo2low') ? ' alarm-on' : ''}`}>{fmt(v.spo2)}</div>
        </div>
      </div>
      <div className="mon-row">
        <Waveform ch={CH.abp} color="#ff5a52" label="ART" unit="mmHg" height={86} scales={[100, 150, 200]} minFloor={0} bg={bg} windowSec={6} zeroLine={false} />
        <div className="mon-num" style={{ color: '#ff5a52' }}>
          <div className="k">
            <span>ART</span>
            <span>{al.sbpLow}</span>
          </div>
          <div className={`v mid num${has('sbplow') || has('sbphigh') ? ' alarm-on' : ''}`}>
            {v.arrest ? '---' : `${fmt(v.sbp)}/${fmt(v.dbp)}`}
          </div>
          <div className="sub">({fmt(v.map)})</div>
        </div>
      </div>
      <div className="mon-row">
        <Waveform ch={CH.capno} color="#f5e04a" label="CO2" unit="mmHg" height={70} scales={[50, 80]} minFloor={0} bg={bg} windowSec={8} zeroLine={false} />
        <div className="mon-num" style={{ color: '#f5e04a' }}>
          <div className="k">
            <span>EtCO2</span>
            <span>RR {fmt(v.rr)}</span>
          </div>
          <div className={`v mid num${has('etco2high') || has('etco2low') ? ' alarm-on' : ''}`}>{capOK ? fmt(v.etco2) : '---'}</div>
          {!capOK && <div className="sub">非挿管</div>}
        </div>
      </div>
      <div className="mon-extra">
        <div style={{ color: '#e6e6e6' }}>
          <div className="k">体温 ℃</div>
          <div className="v">{fmt(v.temp, 1)}</div>
        </div>
        <div style={{ color: '#9fb4ff' }}>
          <div className="k">CVP mmHg</div>
          <div className="v">{fmt(v.cvp)}</div>
        </div>
        <div style={{ color: '#ff9e98' }}>
          <div className="k">PPV %</div>
          <div className="v">{fmt(v.ppv)}</div>
        </div>
      </div>
    </div>
  )
}
