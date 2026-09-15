import * as THREE from 'three';
import { joinRoom, selfId } from '@trystero-p2p/torrent';
import { EV } from '../core/events.js';
import { Config } from '../core/Config.js';
import { RelayTransport } from './RelayTransport.js';
import { createHumanMesh, applyHumanPose } from '../human/HumanFactory.js';

// 중계 폴백용 릴레이 (연결 확인된 곳만)
const RELAY_URLS = ['wss://nos.lol', 'wss://relay.mostr.pub', 'wss://yabu.me/v2'];

// 서버 없는 P2P 멀티플레이 (Trystero torrent 전략 = 공개 WebTorrent 트래커 경유 WebRTC 시그널링).
// 방 코드 6자리 → 같은 코드끼리 full-mesh 연결. 대칭형 NAT 통과율을 위해 무료 TURN 병행.
// - 15Hz 플레이어 상태, 10Hz 잡은/소유 프롭 상태, 이벤트(골인/참가)
const PALETTE = ['#ff8c42', '#3f6fe0', '#22b573', '#e05260', '#a855f7', '#14b8a6'];

export class NetSystem {
  mode = 'offline';
  roomCode = null;
  joinedAt = 0;
  selfKey = 'local';
  myName = '말랑이';
  myColor = PALETTE[0];
  peers = new Map(); // peerId -> { name, color, pos, yaw, speed01, airborne, grab, walkPhase, lookPitch, mesh, lastRx, connectedAt }

  #room = null;
  #sendState = null;
  #sendProp = null;
  #sendEvt = null;
  #acc = 0; #propAcc = 0; #relayAcc = 0;
  #relay = null;
  #relayOn = false;

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

    // v0.25 API: makeAction은 { send, onMessage } 객체 반환 (구 튜플 아님).
    // 수신 핸들러 시그니처: (payload, { peerId }) => void
    // rtcConfig: STUN으로 NAT 통과 (대칭형 NAT 환경은 TURN 필요, 추후 추가)
    this.#room = joinRoom({
      appId: 'humanfall-p2p-v1',
      rtcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    }, code);
    this.#sendState = this.#room.makeAction('st');
    this.#sendProp = this.#room.makeAction('pr');
    this.#sendEvt = this.#room.makeAction('ev');

    this.#sendState.onMessage = (data, meta) => this.#onState(data, meta?.peerId);
    this.#sendProp.onMessage = (data, meta) => this.#onProp(data, meta?.peerId);
    this.#sendEvt.onMessage = (data, meta) => this.#onEvent(data, meta?.peerId);

    // v0.25 API: onPeerJoin/onPeerLeave는 setter 프로퍼티 (메서드 아님)
    this.#room.onPeerJoin = (peerId) => {
      // 새로 온 피어에게 내 정보 인사
      this.#safeSend(this.#sendEvt, { t: 'hello', name: this.myName, color: this.myColor });
    };
    this.#room.onPeerLeave = (peerId) => this.#removePeer(peerId);

    // 핑 기반 타임아웃 대신 수신 타임아웃으로 정리
    this.joinedAt = performance.now();
    return true;
  }

  leave() {
    if (this.#room) { try { this.#room.leave(); } catch { /* noop */ } }
    this.#room = null;
    if (this.#relay) { try { this.#relay.close(); } catch { /* noop */ } }
    this.#relay = null;
    this.#relayOn = false;
    this.#relayAcc = 0;
    for (const id of [...this.peers.keys()]) this.#removePeer(id);
    this.mode = 'offline';
    this.roomCode = null;
  }

  #safeSend(action, data) {
    try { action?.send(data)?.catch?.(() => {}); } catch { /* noop */ }
  }

  sendEvent(e) { this.#safeSend(this.#sendEvt, e); if (this.#relayOn) this.#relay?.send({ k: 'ev', d: e }); }

  claimProp(prop) {
    if (!this.online) return;
    this.#safeSend(this.#sendProp, {
      t: 'claim', id: prop.id,
      p: [prop.pos.x, prop.pos.y, prop.pos.z],
      v: [prop.vel.x, prop.vel.y, prop.vel.z],
    });
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
    if (!peerId || !s) return;
    const r = this.#ensurePeer(peerId);
    if (s.n && r.name === '???') {
      r.name = String(s.n).slice(0, 12);
      r.color = s.c ?? '#999999';
      r.mesh.suitMat.color.set(r.color);
      r.mesh.setName(r.name);
      this.ctx.events.emit(EV.PEER_JOIN, { id: peerId, name: r.name });
      // WebRTC 직결 성공 시 중계로 들어온 중복 아바타 제거 (직결 우선)
      if (!peerId.startsWith('r')) {
        for (const [id, o] of this.peers) {
          if (id !== peerId && id.startsWith('r') && o.name === r.name) this.#removePeer(id, true);
        }
      }
    }
    r.target.set(s.p[0], s.p[1], s.p[2]);
    r.targetYaw = s.y;
    r.speed01 = s.s; r.airborne = !!s.a; r.grab = s.r ?? 0;
    r.lookPitch = s.lp ?? 0;
    r.lastRx = performance.now();
  }

  #onProp(p, peerId) {
    if (!peerId || !p) return;
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
    if (!peerId || !e) return;
    if (e.t === 'hello') {
      const r = this.#ensurePeer(peerId);
      r.name = String(e.name ?? '???').slice(0, 12);
      r.color = e.color ?? '#999999';
      r.mesh.suitMat.color.set(r.color);
      r.mesh.setName(r.name);
      this.ctx.events.emit(EV.PEER_JOIN, { id: peerId, name: r.name });
      // 나도 인사 반환
      this.#safeSend(this.#sendEvt, { t: 'helloBack', name: this.myName, color: this.myColor });
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

  #removePeer(peerId, silent = false) {
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
    if (!silent) this.ctx.events.emit(EV.PEER_LEAVE, { id: peerId, name: r.name });
    this.peers.delete(peerId);
  }

  // ---- 중계 폴백 ----
  #onRelayData(pk, msg) {
    if (!pk || !msg || typeof msg !== 'object') return;
    const rid = 'r' + String(pk).slice(0, 10);
    if (msg.k === 'st' && msg.d) this.#onState({ ...msg.d }, rid);
    else if (msg.k === 'ev' && msg.d?.t === 'goal') {
      this.ctx.events.emit(EV.GOAL, { name: msg.d.name ?? '???', self: false });
    }
  }

  #maybeEnableRelay() {
    if (this.#relayOn || this.peers.size > 0) return;
    if (performance.now() - this.joinedAt < 20000) return;
    this.#relayOn = true;
    this.#relay = new RelayTransport(`humanfall-v1:${this.roomCode}`);
    this.#relay.connect(RELAY_URLS, (pk, msg) => this.#onRelayData(pk, msg));
    this.ctx.get('ui')?.toast('📡 직접 연결이 안 돼 중계 모드로 시도합니다...');
  }

  remotes() { return this.peers.values(); }
  playerCount() { return this.peers.size + 1; }

  fixedUpdate(dt, ctx) {
    if (!this.online) return;
    const human = ctx.get('human');
    this.#maybeEnableRelay();
    if (this.#relayOn) {
      this.#relayAcc += dt;
      if (this.#relayAcc >= 1 / 8) {
        this.#relayAcc = 0;
        const s = human.snapshot();
        this.#relay?.send({ k: 'st', d: { ...s, n: this.myName, c: this.myColor } });
      }
    }
    this.#acc += dt;
    if (this.#acc >= 1 / Config.netHz) {
      this.#acc = 0;
      const s = human.snapshot();
      this.#safeSend(this.#sendState, { ...s, n: this.myName, c: this.myColor });
    }
    this.#propAcc += dt;
    if (this.#propAcc >= 1 / Config.propHz) {
      this.#propAcc = 0;
      const world = ctx.get('world');
      for (const p of world.props) {
        if (p.owner === this.selfKey && !p.remote) {
          this.#safeSend(this.#sendProp, { t: 'pos', id: p.id, p: [p.pos.x, p.pos.y, p.pos.z] });
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
