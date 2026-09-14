import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { EV } from '../core/events.js';
import { createHumanMesh, applyHumanPose, handWorld } from './HumanFactory.js';

// 로컬 플레이어: 말랑 걷기 + 양손 잡기 + 매달리기/올라타기.
// 물리 충돌 해결은 WorldSystem.collidePlayer에 위임.
export class HumanSystem {
  pos = new THREE.Vector3(0, 0.1, -4);  // 발바닥
  vel = new THREE.Vector3();
  yaw = Math.PI;                        // 스폰 시 맵 쪽(-Z... 실제로 +Z)을 바라봄
  grounded = false;
  coyote = 0;
  walkPhase = 0;
  speed01 = 0;
  grabL = null;   // { kind:'prop'|'player'|'wall', ref, offset:Vector3 }
  grabR = null;
  nickname = '말랑이';
  color = '#ff8c42';
  wins = 0;

  #prevGrabL = false;
  #prevGrabR = false;
  #mesh = null;
  #reachL = 0; #reachR = 0;
  #tauntT = 0;
  #airTime = 0;

  async init(ctx) {
    this.ctx = ctx;
    this.#mesh = createHumanMesh({ suit: this.color });
    this.#mesh.setName(this.nickname);
    ctx.scene.add(this.#mesh.root);
    this.world = () => ctx.get('world');
    this.net = () => ctx.get('net');
  }

  setIdentity(name, color) {
    this.nickname = name || '말랑이';
    this.color = color || '#ff8c42';
    if (this.#mesh) {
      this.#mesh.setName(this.nickname);
      this.#mesh.suitMat.color.set(this.color);
    }
  }

  chestPos(out) { return out.set(this.pos.x, this.pos.y + 1.25, this.pos.z); }
  handPos(side, out) {
    const m = side === 'L' ? this.#mesh.armL : this.#mesh.armR;
    return handWorld(m, out);
  }

  snapshot() {
    return {
      p: [this.pos.x, this.pos.y, this.pos.z],
      y: this.yaw,
      s: this.speed01,
      a: this.grounded ? 0 : 1,
      r: (this.grabL ? 1 : 0) | (this.grabR ? 2 : 0),
      ph: this.walkPhase % (Math.PI * 2),
      lp: this.ctx.get('camera')?.pitch ?? 0,
    };
  }

  fixedUpdate(dt, ctx) {
    const input = ctx.input, world = this.world(), cam = ctx.get('camera');
    const C = Config;

    // --- 이동 (카메라 기준) ---
    const wish = new THREE.Vector3(input.move.x, 0, -input.move.y);
    // input.move.y가 +면 앞으로: 카메라 yaw 기준 회전
    const cy = cam.yaw;
    const sin = Math.sin(cy), cos = Math.cos(cy);
    const wx = wish.x * cos - wish.z * sin;
    const wz = wish.x * sin + wish.z * cos;
    const moving = wish.lengthSq() > 0.001;
    const maxSp = input.held('sprint') ? C.sprintSpeed : C.walkSpeed;

    if (moving) {
      const targetYaw = Math.atan2(wx, wz) + Math.PI; // 모델 정면 -Z 보정
      this.yaw = dampAngle(this.yaw, targetYaw, 12, dt);
      const acc = (this.grounded ? C.accel : C.accel * C.airControl);
      this.vel.x += wx * acc * dt;
      this.vel.z += wz * acc * dt;
    } else if (this.grounded) {
      const f = Math.max(0, 1 - 10 * dt);
      this.vel.x *= f; this.vel.z *= f;
    }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > maxSp) { this.vel.x *= maxSp / hs; this.vel.z *= maxSp / hs; }

    // --- 점프 (버퍼 + 코요테) ---
    if (input.consume('jump')) this.jumpBuf = C.jumpBuffer; else this.jumpBuf = Math.max(0, (this.jumpBuf ?? 0) - dt);
    if (this.grounded) this.coyote = C.coyote; else this.coyote -= dt;
    if (this.jumpBuf > 0 && this.coyote > 0) {
      this.vel.y = C.jumpVel;
      this.grounded = false; this.coyote = 0; this.jumpBuf = 0;
      ctx.events.emit(EV.JUMP);
    }

    // --- 벽 잡고 오르기 (클라임 벽 근처, 공중, 위를 보며 W) ---
    const wallHold = (this.grabL?.kind === 'wall' || this.grabR?.kind === 'wall');
    if (wallHold && !this.grounded) {
      this.vel.y = Math.max(this.vel.y, -1.2);       // 미끄러지듯 천천히
      if (cam.pitch < -0.2 && input.move.y > 0.3) this.vel.y = 2.0;  // 위 보고 앞으로 = 오르기
    } else {
      this.vel.y -= C.gravity * dt;
      if (this.vel.y < -30) this.vel.y = -30;
    }

    // --- 다른 플레이어 붙잡고 매달리기: 그쪽으로 살짝 끌려감 ---
    for (const g of [this.grabL, this.grabR]) {
      if (g?.kind === 'player') {
        _t.set(g.ref.pos.x - this.pos.x, (g.ref.pos.y + 1.2) - (this.pos.y + 1.2), g.ref.pos.z - this.pos.z);
        const d = _t.length();
        if (d > 0.6) { _t.normalize().multiplyScalar(26 * dt); this.vel.add(_t); }
      }
    }

    // --- 적분 + 충돌 ---
    const wasGrounded = this.grounded, fallV = this.vel.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    const col = world.collidePlayer(this.pos, this.vel, dt);
    this.grounded = col.grounded;
    if (!wasGrounded && this.grounded && fallV < -9) ctx.events.emit(EV.LAND);

    if (!this.grounded) this.#airTime += dt; else this.#airTime = 0;

    // --- 잡기 엣지 처리 ---
    this.#edgeGrab('L', input.grabL, ctx);
    this.#edgeGrab('R', input.grabR, ctx);
    this.#prevGrabL = input.grabL; this.#prevGrabR = input.grabR;

    // --- 걷기 위상 ---
    const hsp = Math.hypot(this.vel.x, this.vel.z);
    this.speed01 = THREE.MathUtils.clamp(hsp / C.walkSpeed, 0, 1.4);
    if (this.grounded && hsp > 0.4) this.walkPhase += dt * (4 + hsp * 1.6);

    // --- 낙사 / 골인 ---
    if (this.pos.y < C.killY) { this.respawn(ctx, false); }
    const goal = world.checkGoal(this.pos);
    if (goal) {
      this.wins++;
      ctx.events.emit(EV.GOAL, { name: this.nickname, self: true });
      this.net()?.sendEvent({ t: 'goal', name: this.nickname });
      this.respawn(ctx, true);
    }

    if (input.consume('taunt')) this.#tauntT = 1.2;
    this.#tauntT = Math.max(0, this.#tauntT - dt);
  }

  #edgeGrab(side, held, ctx) {
    const cur = side === 'L' ? this.grabL : this.grabR;
    const prev = side === 'L' ? this.#prevGrabL : this.#prevGrabR;
    if (held && !prev && !cur) {
      const found = this.#findGrabTarget(side, ctx);
      if (found) {
        if (side === 'L') this.grabL = found; else this.grabR = found;
        if (found.kind === 'prop') this.world().setGrab(found.ref, this, side);
        ctx.events.emit(EV.GRAB, { side });
      }
    } else if (!held && cur) {
      if (cur.kind === 'prop') this.world().releaseGrab(cur.ref, this);
      if (side === 'L') this.grabL = null; else this.grabR = null;
      ctx.events.emit(EV.THROW);
    }
    // 잡은 대상이 멀어지면 자동 해제
    if (cur?.kind === 'prop' && cur.ref.pos.distanceToSquared(this.pos) > 16) {
      this.world().releaseGrab(cur.ref, this);
      if (side === 'L') this.grabL = null; else this.grabR = null;
    }
    if (cur?.kind === 'player' && _t.copy(cur.ref.pos).sub(this.pos).lengthSq() > 12) {
      if (side === 'L') this.grabL = null; else this.grabR = null;
    }
  }

  #findGrabTarget(side, ctx) {
    const world = this.world(), net = this.net();
    this.chestPos(_c);
    const C = Config;
    let best = null, bestD = C.reach;

    for (const p of world.props) {
      const d = _t.copy(p.pos).sub(_c).length();
      if (d < bestD) { bestD = d; best = { kind: 'prop', ref: p, offset: new THREE.Vector3() }; }
    }
    for (const r of net?.remotes() ?? []) {
      _t.set(r.pos.x - _c.x, (r.pos.y + 1.2) - _c.y, r.pos.z - _c.z);
      const d = _t.length();
      if (d < 2.3 && d < bestD + 0.4) { bestD = d - 0.4; best = { kind: 'player', ref: r, offset: new THREE.Vector3() }; }
    }
    // 클라임 벽: 손 근처 판정 (유효거리 1.4m)
    this.handPos(side, _h);
    const wall = world.nearClimbWall(_h, 1.5);
    if (wall && !best) best = { kind: 'wall', ref: wall, offset: new THREE.Vector3() };
    if (best?.kind === 'prop') best.offset.copy(best.ref.pos).sub(_h);
    return best;
  }

  respawn(ctx, quiet) {
    const s = this.world().spawnPoint;
    this.pos.set(s.x, s.y + 0.1, s.z);
    this.vel.set(0, 0, 0);
    this.yaw = s.yaw;
    if (this.grabL?.kind === 'prop') this.world().releaseGrab(this.grabL.ref, this);
    if (this.grabR?.kind === 'prop') this.world().releaseGrab(this.grabR.ref, this);
    this.grabL = this.grabR = null;
    if (!quiet) ctx.events.emit(EV.RESPAWN);
  }

  update(dt, ctx) {
    const m = this.#mesh;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.yaw;
    // 잡기 뻗기 블렌드
    const tL = this.ctx.input.grabL || this.grabL ? 1 : 0;
    const tR = this.ctx.input.grabR || this.grabR ? 1 : 0;
    this.#reachL += (tL - this.#reachL) * Math.min(1, 12 * dt);
    this.#reachR += (tR - this.#reachR) * Math.min(1, 12 * dt);
    applyHumanPose(m, {
      walkPhase: this.walkPhase,
      speed01: this.speed01,
      airborne: !this.grounded,
      reachL: this.#reachL, reachR: this.#reachR,
      lookPitch: ctx.get('camera')?.pitch ?? 0,
      taunt: this.#tauntT > 0,
    }, dt, ctx.clock.elapsed);
  }
}

const _t = new THREE.Vector3(), _c = new THREE.Vector3(), _h = new THREE.Vector3();

function dampAngle(a, b, lambda, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
