import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { EV } from '../core/events.js';
import { createHumanMesh, applyHumanPose, handWorld, solveArmIK } from './HumanFactory.js';

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
  armStrain = 0;    // 손당 상대 하중 (0~1, 팔 처짐용)
  grabStrain = 0;   // 실제 힘 발휘율 (0~1, 감속/뒤젖힘용)
  lifting = false;  // 위를 보며 번쩍 드는 중
  overhead = false; // 머리 위로 번쩍
  respawnPoint = null;   // { x,y,z,yaw } — 체크포인트가 갱신
  cpIndex = -1;
  #wasGrabbed = false;
  #tethers = [];

  #prevGrabL = false;
  #prevGrabR = false;
  #prevBoth = false;
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
  // 절차적 손 목표점: 가슴 앞 + 시선上下. 실제 손(IK)은 잡은 점에 붙고, 이 점과의 차이가 힘/당김을 만듦.
  desiredHand(side, out, pitch) {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw); // 우측
    const s = side === 'L' ? -1 : 1;
    out.set(
      this.pos.x + fx * 0.55 + rx * s * 0.18,
      this.pos.y + 1.25 + 0.1 - pitch * 0.9,
      this.pos.z + fz * 0.55 + rz * s * 0.18
    );
    return out;
  }
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
    // strain: 손 하나당 상대 하중 (가벼우면 팔 쭉, 무거우면 팔 처짐+떨림)
    let heldMass = 0, overhead = false, hands = 0;
    for (const g of [this.grabL, this.grabR]) {
      if (g?.kind === 'prop') {
        heldMass += g.ref.mass ?? 8;
        hands++;
        if (g.ref.pos.y > this.pos.y + 0.5) overhead = true;
      } else if (g?.kind === 'player') {
        hands++;
      }
    }
    this.heldMass01 = Math.min(1, heldMass / 30);
    this.armStrain = hands > 0 ? THREE.MathUtils.clamp((heldMass / hands - 8) / 20, 0, 1) : 0;
    this.overhead = overhead;
    // 실제 힘 발휘율 (지난 틱): 무거운 걸 낚아채면 몸이 함께 느려지고 뒤로 젖혀짐
    this.grabStrain = world.strainOf(this);
    // 위를 보며 잡고 있으면 번쩍 모드 (팔 최대 + 힘 1.5배)
    this.lifting = (this.grabL?.kind === 'prop' || this.grabR?.kind === 'prop') && cam.pitch < -0.2;

    // --- 이동 (카메라 기준) ---
    const wish = new THREE.Vector3(input.move.x, 0, -input.move.y);
    // input.move.y가 +면 앞으로: 카메라 yaw 기준 회전
    // 전진(my=1) → 카메라가 보는 방향 -(sin,cos), 우측은 (cos,-sin)
    const cy = cam.yaw;
    const sin = Math.sin(cy), cos = Math.cos(cy);
    const wx = wish.x * cos + wish.z * sin;
    const wz = -wish.x * sin + wish.z * cos;
    const moving = wish.lengthSq() > 0.001;
    // 무거운 걸 낚아채면 몸이 함께 느려짐 (몸+물체가 한 단위로)
    const maxSp = (input.held('sprint') ? C.sprintSpeed : C.walkSpeed)
      * (1 - 0.25 * this.heldMass01) * (1 - 0.6 * this.grabStrain);

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
      // 매달리기: 가슴보다 위를 잡으면 거의 안 미끄러짐. 낮게 잡으면 미끄러짐.
      const chestY = this.pos.y + 1.25;
      const hangHold = (this.grabL?.kind === 'wall' && this.grabL.point.y > chestY - 0.3)
        || (this.grabR?.kind === 'wall' && this.grabR.point.y > chestY - 0.3);
      this.vel.y = THREE.MathUtils.clamp(this.vel.y, hangHold ? -0.15 : -1.2, 3.0);
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

    // --- 정적 잡기 풀업: 벽/모서리를 잡고 매달리면 몸이 올라감 ---
    // (움직이지 않는 대상이라 반작용이 전부 몸으로 옴. HFF 등반의 핵심)
    // 당기는 세기는 시야각 비례: 아래를 볼수록 강하게. 수평 보면 매달리기만.
    // 위로 당기는 분력은 전부, 아래로 잡아끄는 분력은 수평만 살짝 (점프 방해 금지)
    this.chestPos(_c);
    const pullScale = THREE.MathUtils.clamp((cam.pitch - 0.02) / 0.45, 0, 1);
    for (const g of [this.grabL, this.grabR]) {
      if (g?.kind !== 'wall') continue;
      _t.set(g.point.x - _c.x, g.point.y - _c.y, g.point.z - _c.z);
      const d = _t.length();
      if (d < 0.05) continue;
      _t.multiplyScalar(Math.min(2200, 900 * d) / d);
      const k = (dt / 70) * (this.grounded ? 0.2 : 1) * pullScale;
      if (_t.y > 0) {
        this.vel.addScaledVector(_t, k);
      } else {
        this.vel.x += _t.x * k * 0.3;
        this.vel.z += _t.z * k * 0.3;
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
    // 팽팽한 줄: 몸이 물체에서 멀어지면, 물체 속도에 연동 (함께 기어가듯 움직임).
    // 무거울수록 몸이 물체 속도에 묶임. 가벼우면 제한 없음.
    // 힘을 다 쓰고도 물체가 안 오면(풀 스트레인) 몸도 거의 못 빠져나감.
    for (const g of [this.grabL, this.grabR]) {
      if (g?.kind !== 'prop') continue;
      const dx = this.pos.x - g.ref.pos.x, dz = this.pos.z - g.ref.pos.z;
      const d = Math.hypot(dx, dz);
      const slack = 0.9 + g.ref.half;
      if (d > slack && d > 0.001) {
        const m = g.ref.mass ?? 10;
        const s = THREE.MathUtils.clamp(m / 40, 0, 1);
        const nx = dx / d, nz = dz / d;
        const outward = this.vel.x * nx + this.vel.z * nz;
        const objOut = g.ref.vel.x * nx + g.ref.vel.z * nz;
        const margin = 0.8 * (1 - this.grabStrain * 0.9);
        const maxOut = objOut + margin;
        if (outward > maxOut) {
          const kill = (outward - maxOut) * s;
          this.vel.x -= nx * kill;
          this.vel.z -= nz * kill;
        }
      }
    }
    // 리모트 프롭에 겹치면 플레이어가 밀려남
    world.pushPlayerFromRemoteProps(this);

    if (!this.grounded) this.#airTime += dt; else this.#airTime = 0;

    // --- 양손 동시 잡기 (E / 휠클릭 / 🤲) ---
    const bothHeld = input.both || input.held('both');
    if (bothHeld && !this.#prevBoth) {
      for (const side of ['L', 'R']) {
        const cur = side === 'L' ? this.grabL : this.grabR;
        if (cur) continue;
        const found = this.#findGrabTarget(side, ctx);
        if (found) {
          found.fromBoth = true;
          if (side === 'L') this.grabL = found; else this.grabR = found;
          if (found.kind === 'prop') this.world().setGrab(found.ref, this, side, found.offset);
        }
      }
      if (this.grabL || this.grabR) ctx.events.emit(EV.GRAB, { side: 'B' });
    } else if (!bothHeld && this.#prevBoth) {
      // 양손 버튼으로 잡은 것만 해제 (개별 클릭분은 유지)
      for (const side of ['L', 'R']) {
        const cur = side === 'L' ? this.grabL : this.grabR;
        if (!cur || !cur.fromBoth) continue;
        if (cur.kind === 'prop') this.world().releaseGrab(cur.ref, this, side);
        if (side === 'L') this.grabL = null; else this.grabR = null;
      }
      ctx.events.emit(EV.THROW);
    }
    this.#prevBoth = bothHeld;

    // --- 잡기 엣지 처리 ---
    this.#edgeGrab('L', input.grabL, ctx, dt);
    this.#edgeGrab('R', input.grabR, ctx, dt);
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

  #edgeGrab(side, held, ctx, dt) {
    const cur = side === 'L' ? this.grabL : this.grabR;
    const prev = side === 'L' ? this.#prevGrabL : this.#prevGrabR;
    if (held && !prev && !cur) {
      const found = this.#findGrabTarget(side, ctx);
      if (found) {
        if (side === 'L') this.grabL = found; else this.grabR = found;
        if (found.kind === 'prop') this.world().setGrab(found.ref, this, side, found.offset);
        ctx.events.emit(EV.GRAB, { side });
      }
    } else if (!held && cur) {
      // 양손 모드로 잡은 건 양손 버튼이 관리 (개별 해제는 양손 해제 때만)
      const bothActive = ctx.input.both || ctx.input.held('both');
      if (!(cur.fromBoth && bothActive)) {
        if (cur.kind === 'prop') this.world().releaseGrab(cur.ref, this, side);
        if (side === 'L') this.grabL = null; else this.grabR = null;
        ctx.events.emit(EV.THROW);
      }
    }
    // 손이 어깨 반경을 벗어나도 절대 놓치지 않음 (버튼을 놓을 때만 해제). 8m 이상은 강제 해제.
    if (cur && cur.kind !== 'wall') {
      const tp = this.#grabPoint(cur, _t);
      if (tp.distanceToSquared(this.pos) > 64) {
        if (cur.kind === 'prop') this.world().releaseGrab(cur.ref, this, side);
        if (side === 'L') this.grabL = null; else this.grabR = null;
      }
    }
    if (cur?.kind === 'player' && _t.copy(cur.ref.pos).sub(this.pos).lengthSq() > 144) {
      if (side === 'L') this.grabL = null; else this.grabR = null;
    }
  }

  // 잡은 점 월드좌표 (IK 목표 + 힘 계산용)
  #grabPoint(g, out) {
    if (g.kind === 'prop') return out.copy(g.ref.pos).add(g.offset);
    if (g.kind === 'player') return out.set(g.ref.pos.x, g.ref.pos.y + 1.2, g.ref.pos.z);
    return out.copy(g.point);
  }

  #findGrabTarget(side, ctx) {
    const world = this.world(), net = this.net();
    const pitch = ctx.get('camera')?.pitch ?? 0;
    this.desiredHand(side, _h, pitch); // 손이 닿는 범위 기준
    this.chestPos(_c);
    // HFF식 짧은 리치: 가슴 반경 1.25m (자석 금지)
    const C = Config;
    let best = null, bestD = 1.25;

    for (const p of world.props) {
      if (p.heldByOther) continue; // 남이 든 건 못 잡음 (손이 꽉 참)
      const d = _t.copy(p.pos).sub(_c).length();
      if (d < bestD) {
        bestD = d;
        // 잡은 표면점 (물체 기준 오프셋, 회전 없음이라 상수): 손에서 가장 가까운 면
        const ox = THREE.MathUtils.clamp(_h.x - p.pos.x, -p.half, p.half);
        const oy = THREE.MathUtils.clamp(_h.y - p.pos.y, -p.half, p.half);
        const oz = THREE.MathUtils.clamp(_h.z - p.pos.z, -p.half, p.half);
        best = { kind: 'prop', ref: p, offset: new THREE.Vector3(ox, oy, oz), slipT: 0 };
      }
    }
    for (const r of net?.remotes() ?? []) {
      _t.set(r.pos.x - _c.x, (r.pos.y + 1.2) - _c.y, r.pos.z - _c.z);
      const d = _t.length();
      if (d < 2.0 && d < bestD + 0.4) {
        bestD = d - 0.4;
        best = { kind: 'player', ref: r, offset: new THREE.Vector3(), slipT: 0 };
      }
    }
    // 표면 잡기 (벽 전체 + 섬 모서리/옆면): 손 근처 판정
    const surf = world.grabSurface(_h, 1.5);
    if (surf && !best) best = { kind: 'wall', ref: null, point: new THREE.Vector3(surf.x, surf.y, surf.z), slipT: 0 };
    if (best?.kind === 'player') {
      best.offset.set(best.ref.pos.x - _h.x, (best.ref.pos.y + 1.2) - _h.y, best.ref.pos.z - _h.z);
    }
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
      strain: this.armStrain,
      heave: this.lifting ? 1 : 0,
      pull: this.grabStrain,
      overhead: this.overhead ? 1 : 0,
    }, dt, ctx.clock.elapsed);
    // 잡은 손은 IK로 물체 표면에 고정 (벽 잡기도 포함)
    for (const [g, side] of [[this.grabL, 'L'], [this.grabR, 'R']]) {
      if (!g) continue;
      const arm = side === 'L' ? m.armL : m.armR;
      this.#grabPoint(g, _c);
      solveArmIK(arm, m.root, _c);
    }
    this.#updateTethers();
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
