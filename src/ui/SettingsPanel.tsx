import { useState } from 'react'
import type { VentMode, VentSettings } from '../engine/types'
import { MODES, modeInfo } from '../engine/defaults'
import { isInvasiveMode } from '../engine/simulator'

type Key = keyof VentSettings

interface KnobDef {
  key: Key
  label: string
  unit: string
  step: number
  min: number
  max: number
  digits?: number
  scale?: number // 表示倍率（FiO2 → %）
  options?: { v: string | number; label: string }[]
  help: string
}

const K: Record<string, KnobDef> = {
  fio2: { key: 'fio2', label: 'FiO2', unit: '%', step: 0.05, min: 0.21, max: 1, scale: 100, help: '吸入酸素濃度。SpO2の目標（一般に92〜96%、COPDでは88〜92%）を保てる最小の値にします。高濃度酸素の長時間投与は吸収性無気肺や酸素毒性の原因になります。' },
  peep: { key: 'peep', label: 'PEEP', unit: 'cmH2O', step: 1, min: 0, max: 25, help: '呼気終末陽圧。肺胞の虚脱を防いで酸素化を改善します。上げすぎると過膨張・静脈還流の低下（血圧低下）を起こします。COPDでは内因性PEEPの70〜80%程度の外因性PEEPがトリガー仕事量を減らします。' },
  vt: { key: 'vt', label: '1回換気量', unit: 'mL', step: 10, min: 150, max: 1000, help: '1回の強制換気で送る量。理想体重（IBW）あたり6〜8 mL/kg を目安にし、ARDSでは6 mL/kg、プラトー圧30 cmH2O以下を目標にします。' },
  rr: { key: 'rr', label: '換気回数', unit: '回/分', step: 1, min: 4, max: 40, help: '設定した強制換気の回数（最低保証）。患者のトリガーがあれば実際の回数は増えます。回数を上げると分時換気量は増えますが、呼気時間が短くなりauto-PEEPの原因になります。' },
  peakFlow: { key: 'peakFlow', label: '吸気流量', unit: 'L/分', step: 5, min: 20, max: 120, help: '従量式での最大吸気流量。高くすると吸気時間が短く呼気時間が長くなります（auto-PEEP対策）。患者の吸気需要より低いとフロー不足（flow starvation）が起こり、気道内圧波形が凹みます。' },
  flowPattern: { key: 'flowPattern', label: '流量波形', unit: '', step: 0, min: 0, max: 0, options: [{ v: 'decel', label: '漸減波' }, { v: 'square', label: '矩形波' }], help: '矩形波は一定流量、漸減波は吸気の初めに高く徐々に減る流量です。漸減波は最高気道内圧が低くなり、ガス分布が均一になりやすいとされます。矩形波では Ppeak − Pplat から気道抵抗を計算できます。' },
  pause: { key: 'pause', label: '吸気ポーズ', unit: '秒', step: 0.1, min: 0, max: 2, digits: 1, help: '吸気終了後に弁を閉じて保持する時間。プラトー圧が表示されます。ポーズ分だけ呼気時間が短くなる点に注意します。' },
  pinsp: { key: 'pinsp', label: '吸気圧', unit: 'cmH2O', step: 1, min: 0, max: 50, help: 'PEEPの上に加える吸気圧（Pinsp / ΔP）。最高気道内圧は PEEP + 吸気圧 です。換気量はコンプライアンスと患者の吸気努力で変わります。' },
  ti: { key: 'ti', label: '吸気時間', unit: '秒', step: 0.1, min: 0.3, max: 3, digits: 1, help: '強制換気の吸気時間。長いと平均気道内圧が上がり酸素化は改善しやすい一方、呼気時間が短くなります。患者の神経吸気時間と合わないと非同調の原因になります。' },
  rise: { key: 'rise', label: '立ち上がり', unit: '秒', step: 0.05, min: 0.05, max: 0.4, digits: 2, help: '設定圧に到達するまでの時間。短いほど初期の流量が高く、吸気需要の強い患者に適します。短すぎると圧のオーバーシュートや不快感の原因になります。' },
  ps: { key: 'ps', label: 'PS', unit: 'cmH2O', step: 1, min: 0, max: 30, help: 'プレッシャーサポート。自発呼吸の吸気時にPEEPの上に加える圧。高すぎると過剰換気・サイクル遅延・ミストリガー、低すぎると呼吸仕事量の増加（浅く速い呼吸）を招きます。0でCPAPです。' },
  ets: { key: 'ets', label: '呼気トリガー', unit: '%', step: 5, min: 5, max: 70, help: 'ETS（呼気トリガー感度）。吸気流量がピークの何％まで低下したら呼気に切り替えるか。COPDでは高め（40〜50%）にすると吸気が早く終わり、サイクル遅延とミストリガーが減ります。' },
  trigType: { key: 'trigType', label: 'トリガー方式', unit: '', step: 0, min: 0, max: 0, options: [{ v: 'flow', label: 'フロー' }, { v: 'pressure', label: '圧' }], help: '患者の吸気努力を検出する方法。フロートリガーは一般に反応が速く仕事量が少ない方式です。' },
  trigFlow: { key: 'trigFlow', label: 'トリガー感度', unit: 'L/分', step: 0.5, min: 0.5, max: 10, digits: 1, help: 'フロートリガーの閾値。小さいほど敏感ですが、リークや心拍動でオートトリガーが起こりやすくなります。' },
  trigPressure: { key: 'trigPressure', label: 'トリガー感度', unit: 'cmH2O', step: 0.5, min: 0.5, max: 10, digits: 1, help: '圧トリガーの閾値。PEEPからこの値だけ気道内圧が下がると吸気を開始します。' },
  pmaxPrvc: { key: 'pmaxPrvc', label: '上限圧', unit: 'cmH2O', step: 1, min: 15, max: 60, help: 'PRVCで自動調整される吸気圧の上限（総圧）。この値の5 cmH2O下までしか吸気圧は上がりません。' },
  pHigh: { key: 'pHigh', label: 'P high', unit: 'cmH2O', step: 1, min: 5, max: 40, help: 'APRVの高圧相の圧。肺胞をリクルートし平均気道内圧を高く保ちます。' },
  pLow: { key: 'pLow', label: 'P low', unit: 'cmH2O', step: 1, min: 0, max: 20, help: 'APRVの開放相の圧。通常0〜5 cmH2O。短いT lowにより内因性PEEPが生じ虚脱を防ぎます。' },
  tHigh: { key: 'tHigh', label: 'T high', unit: '秒', step: 0.5, min: 1, max: 10, digits: 1, help: 'APRVの高圧相の時間。長いほど開放回数が減り、自発呼吸の割合が増えます。' },
  tLow: { key: 'tLow', label: 'T low', unit: '秒', step: 0.05, min: 0.2, max: 2, digits: 2, help: 'APRVの開放時間。呼気流量がピークの50〜75％まで減った時点で終わるよう調整し、肺胞の虚脱を防ぎます。' },
  ipap: { key: 'ipap', label: 'IPAP', unit: 'cmH2O', step: 1, min: 4, max: 30, help: 'NPPVの吸気圧。IPAP − EPAP が換気の補助（PSに相当）です。20 cmH2Oを超えると呑気（胃膨満）のリスクが増えます。' },
  epap: { key: 'epap', label: 'EPAP', unit: 'cmH2O', step: 1, min: 3, max: 20, help: 'NPPVの呼気圧。酸素化の改善、上気道の開存、COPDではトリガー仕事量の軽減に働きます。呼気ポートからの洗い出しのため最低4 cmH2O程度は必要です。' },
  nppvRR: { key: 'nppvRR', label: 'バックアップ回数', unit: '回/分', step: 1, min: 4, max: 30, help: '自発呼吸がこの回数を下回るとタイムド呼吸を送ります。' },
  nppvTi: { key: 'nppvTi', label: 'タイムド吸気時間', unit: '秒', step: 0.1, min: 0.5, max: 2, digits: 1, help: 'バックアップ（タイムド）呼吸の吸気時間。' },
  nppvTiMax: { key: 'nppvTiMax', label: '最大吸気時間', unit: '秒', step: 0.1, min: 0.6, max: 3, digits: 1, help: '自発呼吸の吸気がこの時間を超えると強制的に呼気へ移ります。リークが多いと流量が下がらずサイクルしにくいため、COPDでは短めにします。' },
  maskFit: { key: 'maskFit', label: 'マスク密着', unit: '', step: 0, min: 0, max: 0, options: [{ v: 0, label: '良好' }, { v: 1, label: 'やや漏れ' }, { v: 2, label: '大きく漏れ' }], help: 'マスクのフィッティング。意図しないリークが増えるとトリガー・サイクルの非同調やEPAPの維持困難が起こります。' },
  hfncFlow: { key: 'hfncFlow', label: '流量', unit: 'L/分', step: 5, min: 10, max: 60, help: 'HFNCの総流量。患者の吸気流量を上回ると設定FiO2がそのまま吸入され、死腔洗い出しと軽いPEEP効果が得られます。' },
  o2Device: { key: 'o2Device', label: '酸素器具', unit: '', step: 0, min: 0, max: 0, options: [{ v: 'none', label: '室内気' }, { v: 'cannula', label: '鼻カニュラ' }, { v: 'mask', label: '簡易マスク' }, { v: 'reservoir', label: 'リザーバー' }], help: '鼻カニュラ（〜5L/分）・簡易酸素マスク（5〜8L/分）・リザーバー付きマスク（10〜15L/分）。FiO2は患者の分時換気量で変動します。簡易マスクは5L/分未満ではCO2再呼吸の恐れがあります。' },
  o2Flow: { key: 'o2Flow', label: '酸素流量', unit: 'L/分', step: 1, min: 0, max: 15, help: '酸素流量。' },
}

const TRIG = (s: VentSettings) => [K.trigType, s.trigType === 'flow' ? K.trigFlow : K.trigPressure]

function knobsFor(s: VentSettings): KnobDef[] {
  switch (s.mode) {
    case 'VC-AC':
      return [K.vt, K.rr, K.peakFlow, K.flowPattern, K.pause, K.peep, K.fio2, ...TRIG(s)]
    case 'PC-AC':
      return [K.pinsp, K.ti, K.rr, K.rise, K.peep, K.fio2, ...TRIG(s)]
    case 'PRVC':
      return [K.vt, K.ti, K.rr, K.pmaxPrvc, K.rise, K.peep, K.fio2, ...TRIG(s)]
    case 'SIMV-VC':
      return [K.vt, K.rr, K.peakFlow, K.flowPattern, K.ps, K.ets, K.peep, K.fio2, ...TRIG(s)]
    case 'SIMV-PC':
      return [K.pinsp, K.ti, K.rr, K.ps, K.ets, K.rise, K.peep, K.fio2, ...TRIG(s)]
    case 'PSV':
      return [K.ps, K.peep, K.ets, K.rise, K.fio2, ...TRIG(s), { ...K.pinsp, label: 'バックアップ圧' }, { ...K.rr, label: 'バックアップ回数' }, { ...K.ti, label: 'バックアップTi' }]
    case 'APRV':
      return [K.pHigh, K.pLow, K.tHigh, K.tLow, K.fio2]
    case 'TPIECE':
      return [{ ...K.fio2, label: '酸素濃度' }]
    case 'NPPV-ST':
      return [K.ipap, K.epap, K.nppvRR, K.nppvTi, K.nppvTiMax, K.ets, K.rise, K.trigFlow, K.fio2, K.maskFit]
    case 'NPPV-CPAP':
      return [{ ...K.epap, label: 'CPAP' }, K.fio2, K.maskFit]
    case 'HFNC':
      return [K.hfncFlow, K.fio2]
    case 'O2':
      return [K.o2Device, K.o2Flow]
  }
}

interface Props {
  applied: VentSettings
  draft: VentSettings
  setDraft: (s: VentSettings) => void
  onConfirm: () => void
  onCancel: () => void
  airway: 'intubated' | 'extubated'
  ibw: number
  showHelp: boolean
}

export function SettingsPanel({ applied, draft, setDraft, onConfirm, onCancel, airway, ibw, showHelp }: Props) {
  const [focus, setFocus] = useState<Key | null>(null)
  const modes = MODES.filter((m) => (airway === 'intubated' ? isInvasiveMode(m.id) : !isInvasiveMode(m.id)))
  const knobs = knobsFor(draft)
  const dirty = JSON.stringify(applied) !== JSON.stringify(draft)
  const setMode = (m: VentMode) => setDraft({ ...draft, mode: m })
  const focusDef = focus ? Object.values(K).find((k) => k.key === focus) : null

  const change = (d: KnobDef, dir: number) => {
    const cur = draft[d.key] as number
    let nv = Math.round((cur + dir * d.step) * 1000) / 1000
    nv = Math.min(d.max, Math.max(d.min, nv))
    if (d.key === 'fio2') nv = Math.round(nv * 100) / 100
    setDraft({ ...draft, [d.key]: nv })
    setFocus(d.key)
  }

  return (
    <div className="settings">
      <div className="mode-row" role="group" aria-label="換気モード">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`mode-btn${draft.mode === m.id && applied.mode !== m.id ? ' pending' : ''}`}
            aria-pressed={draft.mode === m.id}
            onClick={() => setMode(m.id)}
            title={m.label}
          >
            {m.short}
          </button>
        ))}
      </div>
      <div>
        <div className="knobs">
          {knobs.map((d) => {
            const val = draft[d.key]
            const was = applied[d.key]
            const changed = val !== was
            const display = d.options
              ? null
              : d.scale
                ? ((val as number) * d.scale).toFixed(0)
                : (val as number).toFixed(d.digits ?? 0)
            return (
              <div
                key={d.label + d.key}
                className={`knob${changed ? ' changed' : ''}${focus === d.key ? ' focus' : ''}`}
                onMouseEnter={() => setFocus(d.key)}
                onFocus={() => setFocus(d.key)}
              >
                <div className="kl" title={d.label}>
                  {d.label}
                </div>
                {d.options ? (
                  <select
                    aria-label={d.label}
                    value={String(val)}
                    onChange={(e) => {
                      const o = d.options!.find((x) => String(x.v) === e.target.value)!
                      setDraft({ ...draft, [d.key]: o.v })
                    }}
                  >
                    {d.options.map((o) => (
                      <option key={String(o.v)} value={String(o.v)}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="kv" aria-live="polite">
                    {display}
                  </div>
                )}
                <div className="ku">
                  {d.key === 'vt' ? `${d.unit}（${((val as number) / ibw).toFixed(1)}/kg）` : d.unit}
                </div>
                {!d.options && (
                  <div className="kb">
                    <button aria-label={`${d.label}を下げる`} onClick={() => change(d, -1)}>
                      −
                    </button>
                    <button aria-label={`${d.label}を上げる`} onClick={() => change(d, 1)}>
                      ＋
                    </button>
                  </div>
                )}
                {changed && !d.options && (
                  <div className="was">
                    現在 {d.scale ? ((was as number) * d.scale).toFixed(0) : (was as number).toFixed(d.digits ?? 0)}
                  </div>
                )}
              </div>
            )
          })}
        <div className="confirm-col">
          <button className="btn confirm" disabled={!dirty} onClick={onConfirm}>
            確定
          </button>
          <button className="btn" disabled={!dirty} onClick={onCancel}>
            取消
          </button>
        </div>
        </div>
      </div>
      {showHelp && (
        <div className="knob-help">
          {focusDef ? (
            <>
              <b>{focusDef.label}</b>
              {focusDef.help}
            </>
          ) : (
            <>
              <b>{modeInfo(draft.mode).label}</b>
              {modeInfo(draft.mode).description}
            </>
          )}
          {dirty && <div style={{ marginTop: 4, color: '#9b5a00' }}>変更は「確定」を押すまで反映されません。</div>}
        </div>
      )}
      {!showHelp && dirty && <div className="knob-help">変更は「確定」を押すまで反映されません。</div>}
    </div>
  )
}
