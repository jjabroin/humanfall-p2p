import { EV } from '../core/events.js';

// 초미니 WebAudio 신스 효과음. 첫 사용자 제스처에 resume.
export class AudioSystem {
  #ac = null;

  async init(ctx) {
    this.ctx = ctx;
    const resume = () => this.#ensure();
    addEventListener('pointerdown', resume, { once: false });
    addEventListener('keydown', resume, { once: false });
    ctx.events.on(EV.JUMP, () => this.#blip(300, 420, 0.12, 'square', 0.08));
    ctx.events.on(EV.LAND, () => this.#blip(140, 90, 0.12, 'sine', 0.15));
    ctx.events.on(EV.GRAB, () => this.#blip(500, 700, 0.08, 'square', 0.08));
    ctx.events.on(EV.THROW, () => this.#blip(700, 350, 0.12, 'sawtooth', 0.06));
    ctx.events.on(EV.GOAL, () => this.#jingle());
    ctx.events.on(EV.RESPAWN, () => this.#blip(400, 150, 0.2, 'sine', 0.1));
  }

  #ensure() {
    if (!this.#ac) { try { this.#ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* noop */ } }
    if (this.#ac?.state === 'suspended') this.#ac.resume();
    return this.#ac;
  }

  #blip(f0, f1, dur, type = 'sine', gain = 0.1) {
    const ac = this.#ensure();
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), ac.currentTime + dur);
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + dur);
  }

  #jingle() {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => this.#blip(f, f, 0.18, 'triangle', 0.12), i * 110));
  }

  update() { /* noop */ }
}
