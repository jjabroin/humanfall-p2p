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
  #relayPropTick = 0;

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
      // 새로 온 피어에게 내 정보 인사 + 소유 프롭 재선언
      this.#safeSend(this.#sendEvt, { t: 'hello', name: this.myName, color: this.myColor });
      this.#reclaimOwned();
    };
    this.#room.onPeerLeave = (peerId) => this.#removePeer(peerId);

    // 핑 기반 타임아웃 대신 수신 타임아웃으로 정리
    this.joinedAt = performance.now();
    // 손대지 않은 프롭 소유권 가져오기 (주인 없는 프롭은 아무도 시뮬 안 함)
    for (const p of this.ctx.get('world').props) {
      if (p.owner !== this.selfKey && p.holds.length === 0) {
        p.owner = this.selfKey; p.claimT = Date.now(); p.claimBy = this.selfKey;
        p.remote = false; p.syncTarget = null;
      }
    }
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
    const msg = {
      t: 'claim', id: prop.id,
      p: [prop.pos.x, prop.pos.y, prop.pos.z],
      v: [prop.vel.x, prop.vel.y, prop.vel.z],
      q: [prop.quat.x, prop.quat.y, prop.quat.z, prop.quat.w],
      ct: prop.claimT ?? 0, by: prop.claimBy ?? '',
      h: prop.holds.length > 0,
    };
    this.#safeSend(this.#sendProp, msg);
    if (this.#relayOn) this.#relay?.send({ k: 'claim', d: msg });
  }

  #ensurePeer(peerId) {
    let r = this.peers.get(peerId);
    if (!r) {
      const mesh = createHumanMesh({ suit: '#999999' });
      this.ctx.scene.add(mesh.root);
      r = {
        name: '???', color: '#999999', pos: new THREE.Vector3(0, -50, 0),
        target: new THREE.Vector3(0, -50, 0), vel: new THREE.Vector3(),
        rxT: 0, grabTarget: null,
        yaw: 0, targetYaw: 0,
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
    // 점프 감지: 타겟이 갑자기 멀리 뛰면(리스폰 등) 스냅, 아니면 보간
    if (!r.lastTgt) {
      r.pos.copy(r.target);
    } else if (r.lastTgt.distanceToSquared(r.target) > 64) {
      r.pos.copy(r.target);
      r.vel.set(0, 0, 0);
    }
    if (!r.lastTgt) r.lastTgt = new THREE.Vector3();
    r.lastTgt.copy(r.target);
    if (s.v) r.vel.set(s.v[0], s.v[1], s.v[2]);
    r.rxT = performance.now();
    r.grabTarget = s.t ?? null;   // 이 피어가 잡고 있는 플레이어 이름 (잡기 끌기용)
    r.targetYaw = s.y;
    r.speed01 = s.s; r.airborne = !!s.a; r.grab = s.r ?? 0;
    r.lookPitch = s.lp ?? 0;
    r.lastRx = performance.now();
  }

  // 소유권 선언 적용: (ct, by) 튜플이 기존보다 클 때만 → 동시 선언도 양쪽이 같은 결론에 수렴.
  // 내가 주인이라고 생각하는데 상대 선언/업데이트가 오면 충돌 → 새 타임스탬프로 재선언해 수렴 유도.
  #reassert(prop) {
    prop.claimT = Date.now(); prop.claimBy = this.selfKey;
    prop.owner = this.selfKey; prop.remote = false;
    this.claimProp(prop);
  }
  #applyClaim(prop, d, senderId) {
    if (prop.holds.length) return false; // 내가 잡는 중이면 무시 (핑퐁 방지)
    const nt = d.ct ?? 0, nb = d.by ?? senderId;
    const ot = prop.claimT ?? -1, ob = prop.claimBy ?? '';
    if (nt < ot || (nt === ot && nb <= ob)) {
      if (prop.owner === this.selfKey && senderId !== this.selfKey) this.#reassert(prop);
      return false;
    }
    prop.claimT = nt; prop.claimBy = nb;
    prop.owner = senderId;
    prop.remote = true;
    prop.heldByOther = !!d.h;
    if (d.q) {
      prop.quat.set(d.q[0], d.q[1], d.q[2], d.q[3]);
      if (!prop.targetQuat) prop.targetQuat = new THREE.Quaternion();
      prop.targetQuat.copy(prop.quat);
    }
    // 순간이동 금지: lerp 타겟만 갱신 (진짜 순간이동-리스폰 등-은 점프감지가 처리)
    if (!prop.syncTarget) prop.syncTarget = new THREE.Vector3();
    if (!prop.syncVel) prop.syncVel = new THREE.Vector3();
    _pv.set(d.p[0], d.p[1], d.p[2]);
    this.#routeSyncTarget(prop, _pv);
    if (d.v) prop.syncVel.set(d.v[0], d.v[1], d.v[2]);
    prop.syncT = performance.now();
    return true;
  }

  // 점프 감지: 타겟이 갑자기 멀리 뛰면(리스폰 등) 스냅, 아니면 경로 추적.
  // 마지막 타겟이 없으면 첫 수신 → 스냅.
  #routeSyncTarget(prop, target) {
    if (!prop.lastSync) {
      prop.pos.copy(target);
      prop.mesh.position.copy(prop.pos);
    } else if (prop.lastSync.distanceToSquared(target) > 64) {
      prop.pos.copy(target);
      prop.mesh.position.copy(prop.pos);
    }
    if (!prop.lastSync) prop.lastSync = new THREE.Vector3();
    prop.lastSync.copy(target);
    prop.syncTarget.copy(target);
    prop.syncT = performance.now();
  }
  #applyPropPos(prop, d, senderId) {
    if (prop.holds.length) return; // 내가 잡는 중이면 내 시뮬이 권위
    if (prop.owner === senderId) {
      prop.remote = true;
      if (!prop.syncTarget) prop.syncTarget = new THREE.Vector3();
      if (!prop.syncVel) prop.syncVel = new THREE.Vector3();
      if (!prop.targetQuat) prop.targetQuat = new THREE.Quaternion();
      if (!prop.syncAngVel) prop.syncAngVel = new THREE.Vector3();
      prop.syncTarget.set(d.p[0], d.p[1], d.p[2]);
      if (d.v) prop.syncVel.set(d.v[0], d.v[1], d.v[2]);
      if (d.q) prop.targetQuat.set(d.q[0], d.q[1], d.q[2], d.q[3]);
      if (d.w) prop.syncAngVel.set(d.w[0], d.w[1], d.w[2]);
      prop.syncT = performance.now();
    } else if (prop.owner === this.selfKey && senderId !== this.selfKey) {
      this.#reassert(prop); // 상대도 주인 행세 → 재선언으로 합의
    }
  }

  #onProp(p, peerId) {
    if (!peerId || !p) return;
    const world = this.ctx.get('world');
    const prop = world.props.find((x) => x.id === p.id);
    if (!prop) return;
    if (p.t === 'claim') {
      this.#applyClaim(prop, p, peerId);
    } else if (p.t === 'pos') {
      this.#applyPropPos(prop, p, peerId);
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
      if (p.owner === peerId) { p.owner = this.selfKey; p.remote = false; p.heldByOther = false; p.syncTarget = null; }
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
  // 새 피어가 생기면 내가 가진 프롭 소유권을 새 타임스탬프로 다시 알림 (최신 선언 승리로 수렴)
  #reclaimOwned() {
    const world = this.ctx.get('world');
    for (const p of world.props) {
      if (p.owner === this.selfKey && p.holds.length === 0) {
        p.claimT = Date.now(); p.claimBy = this.selfKey;
        this.claimProp(p);
      }
    }
  }
  #onRelayData(pk, msg) {
    if (!pk || !msg || typeof msg !== 'object') return;
    const rid = 'r' + String(pk).slice(0, 10);
    if (msg.k === 'st' && msg.d) this.#onState({ ...msg.d }, rid);
    else if (msg.k === 'ev' && msg.d?.t === 'goal') {
      this.ctx.events.emit(EV.GOAL, { name: msg.d.name ?? '???', self: false });
    } else if (msg.d?.id) {
      // 중계 프롭 동기화 (WebRTC #onProp와 동일 규칙)
      const world = this.ctx.get('world');
      const prop = world.props.find((x) => x.id === msg.d.id);
      if (!prop) return;
      if (msg.k === 'claim') {
        this.#applyClaim(prop, msg.d, rid);
      } else if (msg.k === 'pr') {
        this.#applyPropPos(prop, msg.d, rid);
      }
    }
  }

  #maybeEnableRelay() {
    if (this.#relayOn || this.peers.size > 0) return;
    if (performance.now() - this.joinedAt < 20000) return;
    this.#relayOn = true;
    this.#relay = new RelayTransport(`humanfall-v1:${this.roomCode}`);
    this.#relay.connect(RELAY_URLS, (pk, msg) => this.#onRelayData(pk, msg));
    this.#reclaimOwned();
    this.ctx.get('ui')?.toast('📡 직접 연결이 안 돼 중계 모드로 시도합니다...');
  }

  remotes() { return this.peers.values(); }
  playerCount() { return this.peers.size + 1; }
  relayStatus() {
    return { on: this.#relayOn, open: this.#relay?.openCount ?? 0, selfKey: String(this.selfKey).slice(0, 8) };
  }

  fixedUpdate(dt, ctx) {
    if (!this.online) return;
    const human = ctx.get('human');
    this.#maybeEnableRelay();
    if (this.#relayOn) {
      this.#relayAcc += dt;
      if (this.#relayAcc >= 1 / 10) {
        this.#relayAcc = 0;
        const s = human.snapshot();
        this.#relay?.send({ k: 'st', d: { ...s, n: this.myName, c: this.myColor } });
        // 소유 프롭도 중계 (5Hz: 두 틱에 한 번)
        this.#relayPropTick++;
        if (this.#relayPropTick % 2 === 0) {
          const world = ctx.get('world');
          for (const p of world.props) {
            if (p.owner === this.selfKey && !p.remote) {
              this.#relay?.send({ k: 'pr', d: { id: p.id, p: [p.pos.x, p.pos.y, p.pos.z], v: [p.vel.x, p.vel.y, p.vel.z], q: [p.quat.x, p.quat.y, p.quat.z, p.quat.w], w: [p.angVel.x, p.angVel.y, p.angVel.z] } });
            }
          }
        }
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
          this.#safeSend(this.#sendProp, { t: 'pos', id: p.id, p: [p.pos.x, p.pos.y, p.pos.z], v: [p.vel.x, p.vel.y, p.vel.z], q: [p.quat.x, p.quat.y, p.quat.z, p.quat.w], w: [p.angVel.x, p.angVel.y, p.angVel.z] });
        }
      }
    }
  }

  update(dt, ctx) {
    const now = performance.now();
    const k = 1 - Math.exp(-12 * dt);
    const world = ctx.get('world');
    for (const [id, r] of this.peers) {
      if (now - r.lastRx > 8000 && r.name !== '???') { this.#removePeer(id); continue; }
      // 데드레코닝: 마지막 속도로 예측한 지점으로 보간 (지연 체감 감소)
      // 데드레코닝 + 보간. 순간이동(리스폰 등)은 수신 시 점프감지로 스냅했으므로 여기선 스냅 없음.
      const age = Math.min(0.5, (now - r.rxT) / 1000);
      const py0 = r.pos.y;
      _pv.copy(r.target).addScaledVector(r.vel, age);
      r.pos.lerp(_pv, k);
      // 리모트 아바타도 벽/바닥 충돌 (벽 통과 잔상 방지)
      world.collidePlayer(r.pos, r.vel, dt, py0);
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
        lookPitch: r.lookPitch, taunt: false, load: 0, overhead: 0, pull: 0,
      }, dt, ctx.clock.elapsed);
    }
    // 리모트 프롭: 경로 추적 (초당 최대 10m씩 목표를 향해, 벽 충돌 포함)
    // 직선 보간은 모서리를 뚫고 지나가지만, 경로 추적은 벽에 걸림.
    // 순간이동(리스폰 등)은 수신 시 점프감지로 스냅했으므로 여기선 스냅 없음.
    for (const p of world.props) {
      if (p.remote && p.syncTarget) {
        const age = Math.min(0.5, (now - (p.syncT ?? now)) / 1000);
        _pv.copy(p.syncTarget);
        if (p.syncVel) _pv.addScaledVector(p.syncVel, age);
        const d2 = p.pos.distanceToSquared(_pv);
        if (d2 > 0.000001) {
          _nv.copy(p.pos); // prev (스윕트 충돌용)
          _nv2.copy(_pv).sub(p.pos);
          const d = Math.sqrt(d2);
          const step = Math.min(d, 10 * dt);
          p.pos.addScaledVector(_nv2, step / d);
          world.collideProp(p, _nv);
        }
        // 리모트 회전: 각속도로 적분 후 목표 자세로 slerp
        if (p.syncAngVel) {
          const w = p.syncAngVel.length();
          if (w > 0.01) {
            _naxis.copy(p.syncAngVel).multiplyScalar(1 / w);
            _nq.setFromAxisAngle(_naxis, w * dt);
            p.quat.premultiply(_nq).normalize();
          }
        }
        if (p.targetQuat) p.quat.slerp(p.targetQuat, 1 - Math.exp(-8 * dt));
        world.updateExtents(p);
        p.mesh.position.copy(p.pos);
        p.mesh.quaternion.copy(p.quat);
      }
    }
  }
}
const _pv = new THREE.Vector3();
const _nv = new THREE.Vector3();
const _nv2 = new THREE.Vector3();
const _naxis = new THREE.Vector3();
const _nq = new THREE.Quaternion();
