import { assets } from '../config';

// Placeholder sound effects synthesized with Web Audio until CC0 recordings
// are added. Music plays from a file if one is configured.
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private music: HTMLAudioElement | null = null;
  private volume = 0.8;

  // Browsers only allow audio after a user gesture, so call this from a click.
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise();
    }
    void this.ctx.resume();
    if (assets.sounds.music && !this.music) {
      this.music = new Audio(assets.sounds.music);
      this.music.loop = true;
      this.music.volume = this.volume * 0.3;
      void this.music.play().catch(() => {});
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
    if (this.music) this.music.volume = v * 0.3;
  }

  // Thud of an object landing; intensity 0..1.
  impact(intensity: number): void {
    const t = this.now();
    if (t === null) return;
    this.noiseBurst(t, 0.12, 180 + intensity * 400, 'lowpass', 0.5 * intensity);
    this.tone(t, 90 + intensity * 60, 40, 0.1, 0.4 * intensity, 'sine');
  }

  shatter(intensity: number): void {
    const t = this.now();
    if (t === null) return;
    this.noiseBurst(t, 0.35, 3500, 'highpass', 0.35 + 0.3 * intensity);
    for (let i = 0; i < 6; i++) {
      const at = t + Math.random() * 0.15;
      this.tone(at, 2500 + Math.random() * 3000, 2000, 0.08, 0.08, 'triangle');
    }
  }

  swipe(): void {
    const t = this.now();
    if (t === null) return;
    this.noiseBurst(t, 0.1, 1200, 'bandpass', 0.15);
  }

  meow(): void {
    const t = this.now();
    if (t === null || !this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const formant = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.linearRampToValueAtTime(780, t + 0.15);
    osc.frequency.linearRampToValueAtTime(430, t + 0.55);
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(900, t);
    formant.frequency.linearRampToValueAtTime(1600, t + 0.2);
    formant.frequency.linearRampToValueAtTime(700, t + 0.55);
    formant.Q.value = 4;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(formant).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.65);
  }

  private now(): number | null {
    return this.ctx && this.master ? this.ctx.currentTime : null;
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private noiseBurst(t: number, dur: number, freq: number, type: BiquadFilterType, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(vol, 0.0002), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
  }

  private tone(t: number, from: number, to: number, dur: number, vol: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(vol, 0.0002), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
