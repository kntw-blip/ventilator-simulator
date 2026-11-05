/** アラーム音（高優先度: 3+2回のビープ、中優先度: 3回のビープ） */
export class AlarmSound {
  ctx: AudioContext | null = null
  current: 'high' | 'medium' | null = null
  timer: number | null = null

  resume() {
    try {
      if (!this.ctx) this.ctx = new AudioContext()
      if (this.ctx.state === 'suspended') void this.ctx.resume()
    } catch {
      this.ctx = null
    }
  }

  beep(freq: number, start: number, dur: number) {
    const ctx = this.ctx
    if (!ctx) return
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'square'
    o.frequency.value = freq
    g.gain.setValueAtTime(0, start)
    g.gain.linearRampToValueAtTime(0.06, start + 0.01)
    g.gain.setValueAtTime(0.06, start + dur - 0.02)
    g.gain.linearRampToValueAtTime(0, start + dur)
    o.connect(g).connect(ctx.destination)
    o.start(start)
    o.stop(start + dur + 0.02)
  }

  play(p: 'high' | 'medium') {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime + 0.02
    if (p === 'high') {
      const f = 960
      ;[0, 0.2, 0.4, 0.9, 1.1].forEach((d) => this.beep(f, t + d, 0.13))
    } else {
      ;[0, 0.25, 0.5].forEach((d) => this.beep(660, t + d, 0.16))
    }
  }

  update(p: 'high' | 'medium' | null) {
    if (p === this.current) return
    this.current = p
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (p) {
      this.play(p)
      this.timer = window.setInterval(() => this.play(p), p === 'high' ? 5000 : 12000)
    }
  }
}
