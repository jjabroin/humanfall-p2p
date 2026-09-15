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
  heldMass01 = 0;   // 든 무게 (0~1)
  overhead = false; // 머리 위로 번쩍
  respawnPoint = null;   // { x,y,z,yaw } — 체크포인트가 갱신
  cpIndex = -1;
  #wasGrabbed = false;
  #tethers = [];

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
    const s = this.world().spawnPoint;
    this.respawnPoint = { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
    // 잡기 테더선 (최대 3개: 내 양손 + 나를 잡은 놈)
    for (let i = 0; i < 3; i++) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 })
      );
      line.visible = false;
      line.frustumCulled = false;
      ctx.scene.add(line);
      this.#tethers.push(line);
    }
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
  dbgHand(side) {
    const v = new THREE.Vector3();
    this.handPos(side, v);
    const arm = side === 'L' ? this.#mesh.armL : this.#mesh.armR;
    return { hand: v.toArray().map((x) => +x.toFixed(2)), rotx: +arm.shoulder.rotation.x.toFixed(2) };
  }
  handPos(side, out) {
    const m = side === 'L' ? this.#mesh.armL : this.#mesh.armR;
    return handWorld(m, out);
  }

  snapshot() {
    const tL = this.grabL?.kind === 'player' ? this.grabL.ref.name : null;
    const tR = this.grabR?.kind === 'player' ? this.grabR.ref.name : null;
    return {
      p: [this.pos.x, this.pos.y, this.pos.z],
      v: [this.vel.x, this.vel.y, this.vel.z],
      t: tL ?? tR ?? null,   // 내가 잡은 플레이어 이름 (피해자 끌기용)
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

    // --- 붙잡힘 판정: 누군가의 grab target이 나면 그쪽으로 끌려감 ---
    let grabber = null;
    for (const r of this.net()?.remotes() ?? []) {
      if (r.grabTarget === this.nickname) { grabber = r; break; }
    }
    if (grabber && !this.#wasGrabbed) ctx.events.emit(EV.GRABBED, { by: grabber.name });
    this.#wasGrabbed = !!grabber;
    const damp = grabber ? 0.45 : 1; // 잡히면 조작 반감

    // --- 든 무게 집계 (무게중심 효과용) ---
    let heldMass = 0, overhead = false;
    for (const g of [this.grabL, this.grabR]) {
      if (g?.kind === 'prop') {
        heldMass += g.ref.mass ?? 8;
        if (g.ref.pos.y > this.pos.y + 0.75) overhead = true;
      }
    }
    this.heldMass01 = Math.min(1, heldMass / 30);
    this.overhead = overhead;

    // --- 이동 (카메라 기준) ---
    const wish = new THREE.Vector3(input.move.x, 0, -input.move.y);
    // input.move.y가 +면 앞으로: 카메라 yaw 기준 회전
    // 전진(my=1) → 카메라가 보는 방향 -(sin,cos), 우측은 (cos,-sin)
    const cy = cam.yaw;
    const sin = Math.sin(cy), cos = Math.cos(cy);
    const wx = wish.x * cos + wish.z * sin;
    const wz = -wish.x * sin + wish.z * cos;
    const moving = wish.lengthSq() > 0.001;
    const maxSp = (input.held('sprint') ? C.sprintSpeed : C.walkSpeed) * (1 - 0.25 * this.heldMass01);

    if (moving) {
      const targetYaw = Math.atan2(wx, wz) + Math.PI; // 모델 정면 -Z 보정
      this.yaw = dampAngle(this.yaw, targetYaw, this.overhead ? 7 : 12, dt);
      const acc = (this.grounded ? C.accel : C.accel * C.airControl) * damp;
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

    // --- 잡혀서 끌려가기 (상대 손에 매달림) ---
    if (grabber) {
      _t.set(grabber.pos.x - this.pos.x, 0, grabber.pos.z - this.pos.z);
      const d = _t.length();
      if (d > 0.9) {
        _t.normalize().multiplyScalar(45 * dt);
        this.vel.x += _t.x; this.vel.z += _t.z;
      }
    }

    // --- 무거운 걸 번쩍 들면 휘청 (무게중심 상승) ---
    if (this.overhead) {
      const sw = this.heldMass01, t = ctx.clock.elapsed;
      this.vel.x += Math.sin(t * 5.2) * 4 * sw * dt;
      this.vel.z += Math.cos(t * 4.3) * 4 * sw * dt;
    }

    // --- 적분 + 충돌 ---
    const wasGrounded = this.grounded, fallV = this.vel.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    const col = world.collidePlayer(this.pos, this.vel, dt);
    this.grounded = col.grounded;
    if (!wasGrounded && this.grounded && fallV < -9) ctx.events.emit(EV.LAND);
    // 무빙 발판에 올라탔으면 같이 이동
    if (col.grounded && col.ride) {
      this.pos.x += col.ride.dx;
      this.pos.z += col.ride.dz;
    }
    // 점프대
    if (!this.grounded) {
      const pad = world.padAt(this.pos);
      if (pad && this.vel.y < 3) {
        this.vel.y = pad.power;
        ctx.events.emit(EV.JUMP);
        world.burst(_t.set(pad.x, pad.y + 0.4, pad.z), { count: 10, colors: ['#22d3ee', '#ffffff'], speed: 3, up: 3, life: 0.5, grav: 5 });
      }
    }
    // 체크포인트
    for (let i = 0; i < world.checkpoints.length; i++) {
      const cp = world.checkpoints[i];
      const dx = this.pos.x - cp.x, dy = (this.pos.y + 1) - (cp.y + 1), dz = this.pos.z - cp.z;
      if (dx * dx + dy * dy + dz * dz < cp.r * cp.r && this.cpIndex !== i) {
        this.cpIndex = i;
        this.respawnPoint = { x: cp.x, y: cp.y, z: cp.z, yaw: Math.PI };
        ctx.events.emit(EV.CHECKPOINT, { index: i });
        world.burst(_t.set(cp.x, cp.y + 1.5, cp.z), { count: 16, colors: ['#22b573', '#ffd75e'], speed: 3, up: 4, life: 0.8, grav: 6 });
      }
    }

    // 다른 플레이어와 부딪힘 (부드럽게 밀어냄, 상대도 똑같이 밀어내서 대칭)
    for (const r of this.net()?.remotes() ?? []) {
      const dx = this.pos.x - r.pos.x, dz = this.pos.z - r.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.7 && d > 0.001 && Math.abs(this.pos.y - r.pos.y) < 1.5) {
        const push = (0.7 - d) * 0.5;
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    }

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
      const s = world.spawnPoint;
      this.respawnPoint = { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
      this.cpIndex = -1;
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
      if (cur.kind === 'prop') this.world().releaseGrab(cur.ref, this, side);
      if (side === 'L') this.grabL = null; else this.grabR = null;
      ctx.events.emit(EV.THROW);
    }
    // 잡은 대상이 멀어지면 자동 해제
    if (cur?.kind === 'prop' && cur.ref.pos.distanceToSquared(this.pos) > 16) {
      this.world().releaseGrab(cur.ref, this, side);
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
      if (p.heldByOther) continue; // 남이 든 건 못 잡음 (손이 꽉 참)
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
    return best;
  }

  respawn(ctx, quiet) {
    const s = this.respawnPoint ?? this.world().spawnPoint;
    this.pos.set(s.x, s.y + 0.1, s.z);
    this.vel.set(0, 0, 0);
    this.yaw = s.yaw;
    if (this.grabL?.kind === 'prop') this.world().releaseGrab(this.grabL.ref, this, 'L');
    if (this.grabR?.kind === 'prop') this.world().releaseGrab(this.grabR.ref, this, 'R');
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
      load: this.heldMass01,
      overhead: this.overhead ? 1 : 0,
    }, dt, ctx.clock.elapsed);
    // 잡은 물체로 팔 조준 (손이 물체에 붙는 느낌)
    this.#aimArm('L', this.grabL);
    this.#aimArm('R', this.grabR);
    this.#updateTethers();
  }

  #aimArm(side, grab) {
    if (!grab || grab.kind === 'wall') return;
    const arm = side === 'L' ? this.#mesh.armL : this.#mesh.armR;
    if (grab.kind === 'prop') _c.copy(grab.ref.pos);
    else _c.set(grab.ref.pos.x, grab.ref.pos.y + 1.2, grab.ref.pos.z);
    // 늘어난 정도: 손에 붙으면(가벼움) 기본 들기 포즈, 과신장(무거워서 끌림)일 때만 물체를 조준
    this.handPos(side, _h);
    const anchorY = _h.y - (grab.kind === 'prop' ? grab.ref.half * 0.3 : 0);
    const stretch = Math.hypot(_c.x - _h.x, _c.y - anchorY, _c.z - _h.z);
    const blend = THREE.MathUtils.clamp((stretch - 0.8) / 1.2, 0, 1);
    if (blend <= 0.01) return;
    arm.shoulder.updateWorldMatrix(true, false);
    _c.copy(grab.kind === 'prop' ? grab.ref.pos : _t.set(grab.ref.pos.x, grab.ref.pos.y + 1.2, grab.ref.pos.z));
    arm.shoulder.worldToLocal(_c);
    // 팔은 -Y로 늘어짐, 정면 -Z: 아래=0, 앞=+90°, 위로 쭉=+180°
    const aimPitch = THREE.MathUtils.clamp(Math.atan2(-_c.z, -_c.y), -0.3, 2.7);
    arm.shoulder.rotation.x += (aimPitch - arm.shoulder.rotation.x) * 0.6 * blend;
    const aimRoll = THREE.MathUtils.clamp(_c.x * 1.2, -0.5, 0.5);
    arm.shoulder.rotation.z += (aimRoll - arm.shoulder.rotation.z) * 0.6 * blend;
  }

  // 잡기 테더선: 내 손→잡은 친구, 잡은 놈→나
  #updateTethers() {
    let i = 0;
    const link = (fromObj, fromSide, toPos) => {
      if (i >= this.#tethers.length) return;
      const line = this.#tethers[i++];
      handWorld(fromSide === 'L' ? this.#mesh.armL : this.#mesh.armR, _h);
      const p = line.geometry.attributes.position;
      p.setXYZ(0, _h.x, _h.y, _h.z);
      p.setXYZ(1, toPos.x, toPos.y, toPos.z);
      p.needsUpdate = true;
      line.visible = true;
    };
    for (const [g, side] of [[this.grabL, 'L'], [this.grabR, 'R']]) {
      if (g?.kind === 'player') link(null, side, _t.set(g.ref.pos.x, g.ref.pos.y + 1.2, g.ref.pos.z));
    }
    // 나를 잡은 놈 → 내 가슴
    for (const r of this.net()?.remotes() ?? []) {
      if (r.grabTarget === this.nickname) {
        if (i >= this.#tethers.length) break;
        const line = this.#tethers[i++];
        const p = line.geometry.attributes.position;
        p.setXYZ(0, r.pos.x, r.pos.y + 1.2, r.pos.z);
        p.setXYZ(1, this.pos.x, this.pos.y + 1.2, this.pos.z);
        p.needsUpdate = true;
        line.visible = true;
        break;
      }
    }
    for (; i < this.#tethers.length; i++) this.#tethers[i].visible = false;
  }
}

const _t = new THREE.Vector3(), _c = new THREE.Vector3(), _h = new THREE.Vector3();

function dampAngle(a, b, lambda, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
