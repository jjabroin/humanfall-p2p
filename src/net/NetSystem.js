import * as THREE from 'three';
import { joinRoom, selfId } from '@trystero-p2p/torrent';
import { EV } from '../core/events.js';
import { Config } from '../core/Config.js';
import { createHumanMesh, applyHumanPose } from '../human/HumanFactory.js';

// 서버 없는 P2P 멀티플레이 (Trystero torrent 전략 = 공개 트래커 경유 WebRTC).
// - 방 코드 6자리 → 같은 코드끼리 full-mesh 연결
// - 15Hz 플레이어 상태, 10Hz 잡은/소유 프롭 상태, 이벤트(골인/참가)
const PALETTE = ['#ff8c42', '#3f6fe0', '#22b573', '#e05260', '#a855f7', '#14b8a6'];

export class NetSystem {
  mode = 'offline';
  roomCode = null;
  selfKey = 'local';
  myName = '말랑이';
  myColor = PALETTE[0];
  peers = new Map(); // peerId -> { name, color, pos, yaw, speed01, airborne, grab, walkPhase, lookPitch, mesh, lastRx, connectedAt }

  #room = null;
  #sendState = null;
  #sendProp = null;
  #sendEvt = null;
  #acc = 0; #propAcc = 0;

  async init(ctx) { this.ctx = ctx; }

  get online() { return this.mode === 'online'; }

  connect(code, name) {
    this.leave();
    this.mode = 'online';
    this.roomCode = code;
    this.myName = (name || '말랑이').slice(0, 12);
    this.myColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    this.selfKey = selfId;

    const human = this.ctx.get('human');
    human.setIdentity(this.myName, this.myColor);

    this.#room = joinRoom({ appId: 'humanfall-p2p-v1' }, code);
    const [sendState, onState] = this.#room.makeAction('st');
    const [sendProp, onProp] = this.#room.makeAction('pr');
    const [sendEvt, onEvt] = this.#room.makeAction('ev');
    this.#sendState = sendState; this.#sendProp = sendProp; this.#sendEvt = sendEvt;

    onState((s, peerId) => this.#onState(s, peerId));
    onProp((p, peerId) => this.#onProp(p, peerId));
    onEvt((e, peerId) => this.#onEvent(e, peerId));

    this.#room.onPeerJoin((peerId) => {
      // 새로 온 피어에게 내 정보 인사
      sendEvt({ t: 'hello', name: this.myName, color: this.myColor });
    });
    this.#room.onPeerLeave((peerId) => this.#removePeer(peerId));

    // 핑 기반 타임아웃 대신 수신 타임아웃으로 정리
    return true;
  }

  leave() {
    if (this.#room) { try { this.#room.leave(); } catch { /* noop */ } }
    this.#room = null;
    for (const id of [...this.peers.keys()]) this.#removePeer(id);
    this.mode = 'offline';
    this.roomCode = null;
  }

  sendEvent(e) { try { this.#sendEvt?.(e); } catch { /* noop */ } }

  claimProp(prop) {
    if (!this.online) return;
    try {
      this.#sendProp?.({
        t: 'claim', id: prop.id,
        p: [prop.pos.x, prop.pos.y, prop.pos.z],
        v: [prop.vel.x, prop.vel.y, prop.vel.z],
      });
    } catch { /* noop */ }
  }

  #ensurePeer(peerId) {
    let r = this.peers.get(peerId);
    if (!r) {
      const mesh = createHumanMesh({ suit: '#999999' });
      this.ctx.scene.add(mesh.root);
      r = {
        name: '???', color: '#999999', pos: new THREE.Vector3(0, -50, 0),
        target: new THREE.Vector3(0, -50, 0), yaw: 0, targetYaw: 0,
        speed01: 0, airborne: false, grab: 0, walkPhase: Math.random() * 6,
        lookPitch: 0, mesh, lastRx: performance.now(),
      };
      this.peers.set(peerId, r);
    }
    return r;
  }

  #onState(s, peerId) {
    const r = this.#ensurePeer(peerId);
    if (s.n && r.name === '???') {
      r.name = String(s.n).slice(0, 12);
      r.color = s.c ?? '#999999';
      r.mesh.suitMat.color.set(r.color);
      r.mesh.setName(r.name);
      this.ctx.events.emit(EV.PEER_JOIN, { id: peerId, name: r.name });
    }
    r.target.set(s.p[0], s.p[1], s.p[2]);
    r.targetYaw = s.y;
    r.speed01 = s.s; r.airborne = !!s.a; r.grab = s.r ?? 0;
    r.lookPitch = s.lp ?? 0;
    r.lastRx = performance.now();
  }

  #onProp(p, peerId) {
    const world = this.ctx.get('world');
    const prop = world.props.find((x) => x.id === p.id);
    if (!prop) return;
    if (p.t === 'claim') {
      if (prop.grabbedBy) return; // 내가 잡고 있으면 내 권한 유지
      prop.owner = peerId;
      prop.remote = true;
      prop.pos.set(p.p[0], p.p[1], p.p[2]);
      prop.mesh.position.copy(prop.pos);
    } else if (p.t === 'pos' && prop.owner === peerId) {
      prop.remote = true;
      _pv.set(p.p[0], p.p[1], p.p[2]);
      // 큰 차이는 스냅, 작은 차이는 WorldSystem이 메시를 보간... 단순화를 위해 직접 lerp 타겟 저장
      if (!prop.syncTarget) prop.syncTarget = new THREE.Vector3();
      prop.syncTarget.copy(_pv);
    }
  }

  #onEvent(e, peerId) {
    if (e.t === 'hello') {
      const r = this.#ensurePeer(peerId);
      r.name = String(e.name ?? '???').slice(0, 12);
      r.color = e.color ?? '#999999';
      r.mesh.suitMat.color.set(r.color);
      r.mesh.setName(r.name);
      this.ctx.events.emit(EV.PEER_JOIN, { id: peerId, name: r.name });
      // 나도 인사 반환
      try { this.#sendEvt?.({ t: 'helloBack', name: this.myName, color: this.myColor }); } catch { /* noop */ }
    } else if (e.t === 'helloBack') {
      const r = this.#ensurePeer(peerId);
      r.name = String(e.name ?? '???').slice(0, 12);
      r.color = e.color ?? '#999999';
      r.mesh.suitMat.color.set(r.color);
      r.mesh.setName(r.name);
      this.ctx.events.emit(EV.PEER_JOIN, { id: peerId, name: r.name });
    } else if (e.t === 'goal') {
      this.ctx.events.emit(EV.GOAL, { name: e.name ?? '???', self: false });
    }
  }

  #removePeer(peerId) {
    const r = this.peers.get(peerId);
    if (!r) return;
    // 잡고 있던 프롭 소유권 회수
    const world = this.ctx.get('world');
    for (const p of world.props) {
      if (p.owner === peerId) { p.owner = this.selfKey; p.remote = false; }
    }
    // 날 잡고 있던 손 해제
    const human = this.ctx.get('human');
    for (const side of ['L', 'R']) {
      const g = side === 'L' ? human.grabL : human.grabR;
      if (g?.kind === 'player' && g.ref === r) {
        if (side === 'L') human.grabL = null; else human.grabR = null;
      }
    }
    this.ctx.scene.remove(r.mesh.root);
    this.ctx.events.emit(EV.PEER_LEAVE, { id: peerId, name: r.name });
    this.peers.delete(peerId);
  }

  remotes() { return this.peers.values(); }
  playerCount() { return this.peers.size + 1; }

  fixedUpdate(dt, ctx) {
    if (!this.online) return;
    const human = ctx.get('human');
    this.#acc += dt;
    if (this.#acc >= 1 / Config.netHz) {
      this.#acc = 0;
      const s = human.snapshot();
      try { this.#sendState?.({ ...s, n: this.myName, c: this.myColor }); } catch { /* noop */ }
    }
    this.#propAcc += dt;
    if (this.#propAcc >= 1 / Config.propHz) {
      this.#propAcc = 0;
      const world = ctx.get('world');
      for (const p of world.props) {
        if (p.owner === this.selfKey && !p.remote) {
          try {
            this.#sendProp?.({ t: 'pos', id: p.id, p: [p.pos.x, p.pos.y, p.pos.z] });
          } catch { /* noop */ }
        }
      }
    }
  }

  update(dt, ctx) {
    const now = performance.now();
    const k = 1 - Math.exp(-10 * dt);
    for (const [id, r] of this.peers) {
      if (now - r.lastRx > 8000 && r.name !== '???') { this.#removePeer(id); continue; }
      r.pos.lerp(r.target, k);
      let d = (r.targetYaw - r.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      r.yaw += d * k;
      if (r.speed01 > 0.1 && !r.airborne) r.walkPhase += dt * (4 + r.speed01 * 5);
      r.mesh.root.position.copy(r.pos);
      r.mesh.root.rotation.y = r.yaw;
      applyHumanPose(r.mesh, {
        walkPhase: r.walkPhase, speed01: r.speed01, airborne: r.airborne,
        reachL: (r.grab & 1) ? 1 : 0, reachR: (r.grab & 2) ? 1 : 0,
        lookPitch: r.lookPitch, taunt: false,
      }, dt, ctx.clock.elapsed);
    }
    // 리모트 프롭 보간
    const world = ctx.get('world');
    for (const p of world.props) {
      if (p.remote && p.syncTarget) {
        p.pos.lerp(p.syncTarget, 1 - Math.exp(-12 * dt));
        p.mesh.position.copy(p.pos);
      }
    }
  }
}
const _pv = new THREE.Vector3();
