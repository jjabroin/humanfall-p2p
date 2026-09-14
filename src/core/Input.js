import * as THREE from 'three';

// stickfight Input을 차용: WASD 이동 + 마우스 룩 + 버퍼드 점프.
// 차이점: 좌/우클릭은 "손 잡기(홀드)"로 사용, E는 까꿍(장난)용.
const JUMP_BUFFER = 0.18;
const DEADZONE = 0.22;

const KEYMAP = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyE: 'taunt', Enter: 'jump',
};
const KEY_LOOK = {
  ArrowLeft: [1, 0], ArrowRight: [-1, 0],
  ArrowUp: [0, 1], ArrowDown: [0, -1],
};

export class Input {
  static name = 'input';
  move = new THREE.Vector2();   // x: right, y: forward (카메라 기준)
  look = new THREE.Vector2();   // 소비되기 전까지 누적된 룩 델타(rad)
  zoom = 0;                     // 휠 누적 (camera가 소비)
  #down = new Set();
  #actions = new Map();         // action -> { held, queue: [] }
  #time = 0;
  #locked = false;
  #el = null;
  grabL = false;                // 왼손 홀드
  grabR = false;                // 오른손 홀드

  attach(el, events) {
    this.#el = el;
    this.events = events;
    const setAction = (name, held) => {
      let a = this.#actions.get(name);
      if (!a) this.#actions.set(name, (a = { held: false, queue: [] }));
      if (held && !a.held) { a.queue.push(this.#time); if (a.queue.length > 3) a.queue.shift(); }
      a.held = held;
    };
    this.setAction = setAction;

    addEventListener('keydown', (e) => {
      if (KEY_LOOK[e.code]) { e.preventDefault(); this.#down.add(e.code); return; }
      if (e.repeat) return;
      const a = KEYMAP[e.code];
      if (!a) return;
      e.preventDefault();
      this.#down.add(e.code);
      setAction(a, true);
    });
    addEventListener('keyup', (e) => {
      if (KEY_LOOK[e.code]) { this.#down.delete(e.code); return; }
      const a = KEYMAP[e.code];
      if (!a) return;
      this.#down.delete(e.code);
      const still = Object.entries(KEYMAP).some(([c, act]) => act === a && this.#down.has(c));
      if (!still) setAction(a, false);
    });

    el.addEventListener('mousedown', (e) => {
      if (!this.#locked) { el.requestPointerLock?.(); return; }
      if (e.button === 0) this.grabL = true;
      if (e.button === 2) this.grabR = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.grabL = false;
      if (e.button === 2) this.grabR = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { this.zoom += Math.sign(e.deltaY); }, { passive: true });

    addEventListener('mousemove', (e) => {
      if (!this.#locked) return;
      this.look.x -= e.movementX * 0.0023;
      this.look.y -= e.movementY * 0.0023;
    });
    document.addEventListener('pointerlockchange', () => {
      this.#locked = document.pointerLockElement === el;
      this.events?.emit('input:pointerlock', this.#locked);
    });
    addEventListener('blur', () => this.releaseAll());
    addEventListener('gamepadconnected', (e) => { this.#pad = e.gamepad.index; });
    addEventListener('gamepaddisconnected', () => { this.#pad = null; });
  }

  get pointerLocked() { return this.#locked; }
  releaseAll() {
    this.#down.clear();
    for (const a of this.#actions.values()) { a.held = false; a.queue.length = 0; }
    this.move.set(0, 0); this.grabL = this.grabR = false;
  }
  held(n) { return this.#actions.get(n)?.held ?? false; }
  consume(n) {
    const a = this.#actions.get(n);
    if (!a || !a.queue.length) return false;
    while (a.queue.length && this.#time - a.queue[0] > JUMP_BUFFER) a.queue.shift();
    if (!a.queue.length) return false;
    a.queue.shift();
    return true;
  }

  #pad = null;
  #padDriving = false;

  update(dt) {
    this.#time += dt;
    this.#pollPad();
    for (const code in KEY_LOOK) {
      if (!this.#down.has(code)) continue;
      const [ax, ay] = KEY_LOOK[code];
      this.look.x += ax * 2.4 * dt;
      this.look.y += ay * 1.7 * dt;
    }
    if (!this.#padDriving) {
      const x = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
      const y = (this.held('up') ? 1 : 0) - (this.held('down') ? 1 : 0);
      this.move.set(x, y);
      if (this.move.lengthSq() > 1) this.move.normalize();
    }
  }
  endFrame() { this.look.set(0, 0); this.zoom = 0; }

  #pollPad() {
    this.#padDriving = false;
    if (this.#pad === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.#pad];
    if (!gp) return;
    const dz = (v) => { const a = Math.abs(v); return a < DEADZONE ? 0 : Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE)); };
    const mx = dz(gp.axes[0] ?? 0), my = -dz(gp.axes[1] ?? 0);
    if (mx || my) { this.move.set(mx, my); if (this.move.lengthSq() > 1) this.move.normalize(); this.#padDriving = true; }
    const lx = dz(gp.axes[2] ?? 0), ly = dz(gp.axes[3] ?? 0);
    this.look.x -= lx * 2.6 * (1 / 60);
    this.look.y -= ly * 2.0 * (1 / 60);
    const b = gp.buttons, p = (i) => !!b[i]?.pressed;
    this.setAction?.('jump', p(0));
    this.setAction?.('sprint', p(10));
    this.grabL = p(6) || p(2); this.grabR = p(7) || p(3);
  }
}
