// stickfight의 Engine 구조를 차용한 고정 스텝 게임 루프.
// 시뮬레이션은 60Hz 고정, 렌더링은 매 프레임.
import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';
import { Config } from './Config.js';
import { EV } from './events.js';

const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.1;
const MAX_FIXED_STEPS = 5;

export class Engine {
  systems = new Map();
  #order = [];
  #accum = 0;
  #last = 0;
  #raf = 0;
  #running = false;

  clock = { elapsed: 0, dt: 0, frame: 0 };

  constructor(canvas) {
    this.canvas = canvas;
    this.events = new EventBus();
    this.input = new Input();
    // 모바일(터치) 기기는 픽셀비를 낮게 시작 + 그림자 축소 (발열/프레임対策)
    this.mobile = matchMedia('(pointer: coarse)').matches;
    this.prCap = this.mobile ? 1.5 : 2;
    this.pr = Math.min(devicePixelRatio || 1, this.prCap);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(this.pr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.ctx = {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      canvas,
      mobile: this.mobile,
      clock: this.clock,
      input: this.input,
      events: this.events,
      config: Config,
      get: (name) => this.systems.get(name),
    };
    this.input.attach(canvas, this.events);
    addEventListener('resize', () => this.#resize());
  }

  use(key, system) { this.systems.set(key, system); return this; }

  async init(onProgress) {
    // 순서: world(지형) -> human -> net -> camera -> audio -> ui
    const order = ['world', 'human', 'net', 'camera', 'audio', 'ui'];
    const labels = { world: '섬 만드는 중...', human: '말랑이 깨우는 중...', net: 'P2P 준비 중...', camera: '카메라 조정 중...', audio: '효과음 준비 중...', ui: '메뉴 차리는 중...' };
    let i = 0;
    for (const key of order) {
      const s = this.systems.get(key);
      if (s?.init) await s.init(this.ctx);
      i++;
      onProgress?.(i / order.length, labels[key] ?? key);
    }
    this.#resize();
    this.events.emit(EV.READY);
    return this;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    const tick = (now) => {
      this.#raf = requestAnimationFrame(tick);
      this.#frame(now);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  #frame(now) {
    const raw = (now - this.#last) / 1000;
    this.#last = now;
    const dt = Math.min(raw, MAX_FRAME_DT);
    this.clock.dt = dt;
    this.clock.elapsed += dt;
    this.clock.frame++;

    this.input.update(dt);

    this.#accum += dt;
    let steps = 0;
    while (this.#accum >= FIXED_DT && steps < MAX_FIXED_STEPS) {
      for (const key of ['net', 'human', 'world', 'camera']) {
        const s = this.systems.get(key);
        if (s?.fixedUpdate) s.fixedUpdate(FIXED_DT, this.ctx);
      }
      this.#accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_FIXED_STEPS) this.#accum = 0;

    for (const key of ['net', 'human', 'world', 'camera', 'audio', 'ui']) {
      const s = this.systems.get(key);
      if (s?.update) s.update(dt, this.ctx);
    }
    this.#autoTune(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  #perfAcc = 0; #perfN = 0;
  // 자동 품질 조절: 평균 fps가 낮으면 픽셀비를 내리고, 여유로우면 올림.
  #autoTune(dt) {
    this.#perfAcc += dt; this.#perfN++;
    if (this.#perfN < 150) return;
    const avg = this.#perfAcc / this.#perfN;
    this.#perfAcc = 0; this.#perfN = 0;
    if (avg > 1 / 42 && this.pr > 1) {
      this.pr = Math.max(1, this.pr - 0.25);
      this.renderer.setPixelRatio(this.pr);
      this.#resize();
    } else if (avg < 1 / 57 && this.pr < this.prCap) {
      this.pr = Math.min(this.prCap, this.pr + 0.25);
      this.renderer.setPixelRatio(this.pr);
      this.#resize();
    }
  }

  #resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
