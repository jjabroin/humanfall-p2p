import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { EV } from '../core/events.js';

// 떠있는 섬 레벨 + 잡기/밀기 가능한 프롭 + 골인 링.
// 물리는 커스텀 경량 물리 (stickfight처럼 외부 물리엔진 없음).
export class WorldSystem {
  solids = [];     // { x0,x1,z0,z1,top,bottom }
  props = [];      // { id, mesh, pos, vel, half, grabbedBy:{player,side}|null, owner, remote }
  climbWalls = []; // { x0,x1,z0,z1,y0,y1 }
  spawnPoint = { x: 0, y: 0, z: -4, yaw: Math.PI };
  goal = new THREE.Vector3(0, 1.6, 51);

  async init(ctx) {
    this.ctx = ctx;
    const scene = ctx.scene;
    scene.fog = new THREE.Fog('#bcd8f0', 45, 150);

    // 그라데이션 스카이돔
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 16, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          top: { value: new THREE.Color('#3d7ac8') },
          bottom: { value: new THREE.Color('#d8ecff') },
        },
        vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = normalize(vP).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottom, top, smoothstep(0.45, 0.75, h)), 1.0); }',
      })
    );
    scene.add(sky);

    const hemi = new THREE.HemisphereLight('#cfe8ff', '#5a6b4a', 0.9);
    const sun = new THREE.DirectionalLight('#fff4e0', 2.0);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    const shadowSize = ctx.mobile ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -20;
    sun.shadow.camera.far = 100;
    scene.add(hemi, sun);

    this.#island(scene, 0, -2, 18, 18, 0);        // 스폰 섬
    this.#island(scene, 0, 12, 2.6, 7, 0);        // 다리
    this.#island(scene, 0, 21, 13, 12, 0);        // 박스 섬
    this.#island(scene, 0, 30.5, 3.2, 5, 0);      // 점프 발판 (틈 2m)
    this.#island(scene, 0, 39, 11, 12, 0);        // 타워 섬
    this.#island(scene, 0, 50.5, 9, 8, 1.4);      // 골인 단상 (높이 1.4)
    this.#island(scene, -11, 24, 5, 5, 0.8);      // 옆 숨은 섬

    // 클라임 벽: 타워섬->단상으로 올라가는 벽 (z=46.5면)
    this.#climbWall(scene, -2.5, 2.5, 46.4, 46.6, 0, 2.6);
    // 옆섬 오르는 작은 벽
    this.#climbWall(scene, -8.6, -8.4, 21.5, 26.5, 0, 1.9);

    // 프롭: 크레이트 3 + 공 1 + 옆섬 크레이트 1
    this.#crate(scene, -2.5, 0.45, 20);
    this.#crate(scene, 2.5, 0.45, 22);
    this.#crate(scene, 0.5, 0.45, 19, 0.7);
    this.#ball(scene, -1.5, 0.6, 23);
    this.#crate(scene, -11, 1.25, 24);

    // 골인 링
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.4, 0.18, 14, 40),
      new THREE.MeshStandardMaterial({ color: '#ffd75e', emissive: '#ff9d00', emissiveIntensity: 1.2, roughness: 0.4 })
    );
    ring.position.copy(this.goal);
    scene.add(ring);
    this.ring = ring;
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 0.12, 28),
      new THREE.MeshStandardMaterial({ color: '#ffd75e', emissive: '#ff9d00', emissiveIntensity: 0.5 })
    );
    pad.position.set(this.goal.x, 1.46, this.goal.z);
    scene.add(pad);

    // 골인 빔 기둥
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.4, 26, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffd75e', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false })
    );
    beam.position.set(this.goal.x, this.goal.y + 11, this.goal.z);
    scene.add(beam);
    this.beam = beam;

    // 구름
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
    const cloudGeo = new THREE.SphereGeometry(1, 12, 10);
    const rng = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < 14; i++) {
      const c = new THREE.Group();
      for (let j = 0; j < 3; j++) {
        const s = new THREE.Mesh(cloudGeo, cloudMat);
        s.position.set(j * rng(1, 1.8), rng(-0.3, 0.3), rng(-0.5, 0.5));
        s.scale.setScalar(rng(1, 2.2));
        c.add(s);
      }
      c.position.set(rng(-45, 45), rng(12, 26), rng(-20, 70));
      scene.add(c);
    }
    // 아래 낙하 표시용 바다
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: '#2e6f9e', roughness: 0.6 })
    );
    sea.rotation.x = -Math.PI / 2; sea.position.y = -16;
    scene.add(sea);

    // 파티클 풀 (컨페티 + 착지 더스트 공용, 96개)
    this.pool = [];
    const pGeo = new THREE.BoxGeometry(0.14, 0.14, 0.02);
    for (let i = 0; i < 96; i++) {
      const m = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0 }));
      m.visible = false;
      scene.add(m);
      this.pool.push({ mesh: m, vel: new THREE.Vector3(), life: 0, max: 1, grav: 9, spin: new THREE.Vector3() });
    }
    ctx.events.on(EV.GOAL, () => {
      this.burst(this.goal, { count: 60, colors: ['#ffd75e', '#ffffff', '#4f7cff', '#e05260'], speed: 7, up: 6, life: 1.8, grav: 8 });
    });
    ctx.events.on(EV.LAND, () => {
      const h = ctx.get('human');
      _v1.set(h.pos.x, h.pos.y + 0.1, h.pos.z);
      this.burst(_v1, { count: 8, colors: ['#ffffff'], speed: 2.2, up: 1.5, life: 0.5, grav: 4 });
    });
  }

  burst(pos, { count = 20, colors = ['#ffffff'], speed = 5, up = 4, life = 1.2, grav = 9 } = {}) {
    let n = 0;
    for (const p of this.pool) {
      if (p.life > 0) continue;
      p.life = p.max = life * (0.7 + Math.random() * 0.6);
      p.grav = grav;
      p.mesh.visible = true;
      p.mesh.material.color.set(colors[(Math.random() * colors.length) | 0]);
      p.mesh.material.opacity = 1;
      p.mesh.position.copy(pos);
      p.mesh.scale.setScalar(0.7 + Math.random() * 0.8);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      p.vel.set(Math.cos(a) * s, up * (0.5 + Math.random()), Math.sin(a) * s);
      p.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
      if (++n >= count) break;
    }
  }

  // ---- 지형 생성 ----
  #island(scene, cx, cz, w, d, top) {
    const h = 3;
    const g = new THREE.Group();
    const grass = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.5, d),
      new THREE.MeshStandardMaterial({ color: '#6fbf5a', roughness: 0.9 })
    );
    grass.position.set(cx, top - 0.25, cz);
    const dirt = new THREE.Mesh(
      new THREE.ConeGeometry(Math.min(w, d) * 0.48, h, 4),
      new THREE.MeshStandardMaterial({ color: '#8a6b4f', roughness: 1 })
    );
    dirt.position.set(cx, top - 0.5 - h / 2, cz);
    dirt.rotation.y = Math.PI / 4;
    dirt.scale.set(w / Math.min(w, d), 1, d / Math.min(w, d));
    grass.receiveShadow = true;
    g.add(grass, dirt);
    scene.add(g);
    this.solids.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, top, bottom: top - 0.5 });
  }

  #climbWall(scene, x0, x1, z0, z1, y0, y1) {
    const w = Math.max(x1 - x0, 0.4), d = Math.max(z1 - z0, 0.4);
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w, y1 - y0, d),
      new THREE.MeshStandardMaterial({ color: '#b08968', roughness: 0.95 })
    );
    wall.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    wall.castShadow = wall.receiveShadow = true;
    scene.add(wall);
    // 홀드(손잡이) 점들
    const holdGeo = new THREE.SphereGeometry(0.12, 10, 8);
    const holdMat = new THREE.MeshStandardMaterial({ color: '#4f7cff', roughness: 0.6 });
    for (let y = y0 + 0.5; y < y1; y += 0.7) {
      for (let t = 0.15; t < 0.9; t += 0.35) {
        const hx = x0 + (x1 - x0) * t + ((y * 10) % 2 ? 0.15 : -0.15);
        const hold = new THREE.Mesh(holdGeo, holdMat);
        const facing = (z1 - z0) < (x1 - x0) ? 1 : 0;
        hold.position.set(hx, y, facing ? (z0 < 45 ? z0 - 0.15 : z1 + 0.15) : (z0 + z1) / 2);
        if (!facing) hold.position.x = x0 < -8 ? x0 - 0.15 : x1 + 0.15;
        scene.add(hold);
      }
    }
    this.climbWalls.push({ x0, x1, z0, z1, y0, y1 });
  }

  #crate(scene, x, y, z, s = 0.9) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s),
      new THREE.MeshStandardMaterial({ color: '#c98f4e', roughness: 0.9 })
    );
    mesh.castShadow = mesh.receiveShadow = true;
    // 테두리
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: '#6b4a26' })
    );
    mesh.add(edge);
    scene.add(mesh);
    this.props.push({
      id: `crate${this.props.length}`, mesh,
      pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(),
      half: s / 2, grabbedBy: null, owner: 'local', remote: false,
    });
  }

  #ball(scene, x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 20, 16),
      new THREE.MeshStandardMaterial({ color: '#e05260', roughness: 0.55 })
    );
    mesh.castShadow = true;
    scene.add(mesh);
    this.props.push({
      id: 'ball', mesh, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(),
      half: 0.6, round: true, grabbedBy: null, owner: 'local', remote: false,
    });
  }

  // ---- 충돌 ----
  groundAt(x, z, feetY) {
    let g = null;
    for (const s of this.solids) {
      if (x > s.x0 - 0.2 && x < s.x1 + 0.2 && z > s.z0 - 0.2 && z < s.z1 + 0.2) {
        if (s.top <= feetY + Config.stepHeight && (g === null || s.top > g)) g = s.top;
      }
    }
    return g;
  }

  collidePlayer(pos, vel, dt) {
    const C = Config, r = C.playerRadius;
    let grounded = false;
    // 수평 벽 밀어내기 (발보다 높은 면)
    for (const s of this.solids) {
      const inX = pos.x > s.x0 - r && pos.x < s.x1 + r;
      const inZ = pos.z > s.z0 - r && pos.z < s.z1 + r;
      if (inX && inZ && pos.y < s.top - C.stepHeight && pos.y + 1.6 > s.bottom) {
        const dxl = pos.x - (s.x0 - r), dxr = (s.x1 + r) - pos.x;
        const dzl = pos.z - (s.z0 - r), dzr = (s.z1 + r) - pos.z;
        const m = Math.min(dxl, dxr, dzl, dzr);
        if (m === dxl) { pos.x = s.x0 - r; vel.x = Math.min(0, vel.x); }
        else if (m === dxr) { pos.x = s.x1 + r; vel.x = Math.max(0, vel.x); }
        else if (m === dzl) { pos.z = s.z0 - r; vel.z = Math.min(0, vel.z); }
        else { pos.z = s.z1 + r; vel.z = Math.max(0, vel.z); }
      }
    }
    // 착지
    const g = this.groundAt(pos.x, pos.z, pos.y + 0.3);
    if (g !== null && pos.y <= g + 0.02 && vel.y <= 0.01) {
      pos.y = g; vel.y = 0; grounded = true;
    } else if (g !== null && pos.y < g) {
      pos.y = g; vel.y = 0; grounded = true;
    }
    return { grounded };
  }

  nearClimbWall(p, dist) {
    for (const w of this.climbWalls) {
      const cx = THREE.MathUtils.clamp(p.x, w.x0, w.x1);
      const cz = THREE.MathUtils.clamp(p.z, w.z0, w.z1);
      const cy = THREE.MathUtils.clamp(p.y, w.y0, w.y1);
      const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
      if (d < dist) return w;
    }
    return null;
  }

  checkGoal(pos) {
    return pos.distanceToSquared(this.goal) < 1.44 && Math.abs(pos.y + 1.2 - this.goal.y) < 2.4;
  }

  // ---- 잡기 ----
  setGrab(prop, player, side) {
    prop.grabbedBy = { player, side };
    prop.owner = this.ctx.get('net').selfKey;
    this.ctx.get('net')?.claimProp(prop);
    prop.vel.set(0, 0, 0);
  }
  releaseGrab(prop, player) {
    if (prop.grabbedBy?.player !== player) return;
    // 놓을 때 손 속도를 물려줘서 던지기 가능
    prop.vel.copy(player.vel);
    prop.vel.y += 2.0;
    const f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
    const hs = Math.hypot(player.vel.x, player.vel.z);
    prop.vel.addScaledVector(f, Math.min(hs * 0.6, 3) + Config.throwBoost * 0.5);
    prop.grabbedBy = null;
    this.ctx.get('net')?.claimProp(prop);
  }

  fixedUpdate(dt, ctx) {
    const net = ctx.get('net');
    const human = ctx.get('human');
    for (const p of this.props) {
      if (p.remote) continue; // 리모트 프롭은 net이 보간
      if (p.grabbedBy) {
        // 잡은 손 위치로 스프링 추종
        const holder = p.grabbedBy.player;
        holder.handPos(p.grabbedBy.side, _v1);
        _v2.copy(_v1).add(p.grabbedBy.offset ?? _zero);
        _v3.copy(_v2).sub(p.pos);
        p.vel.copy(_v3.multiplyScalar(10));
        // 너무 늘어나면 감속
        if (p.vel.lengthSq() > 200) p.vel.setLength(Math.sqrt(200));
        p.pos.addScaledVector(p.vel, dt);
        p.owner = net.selfKey;
      } else if (p.owner === net.selfKey) {
        p.vel.y -= Config.gravity * dt;
        p.pos.addScaledVector(p.vel, dt);
        // 플레이어에게 밀림
        this.#pushBy(human, p);
        for (const r of net.remotes()) this.#pushByRemote(r, p);
        // 바닥
        const g = this.groundAt(p.pos.x, p.pos.z, p.pos.y);
        const restY = (g ?? -100) + p.half;
        if (p.pos.y <= restY && p.vel.y <= 0) {
          p.pos.y = restY; p.vel.y = 0;
          p.vel.x *= (1 - 6 * dt); p.vel.z *= (1 - 6 * dt);
        }
        if (p.pos.y < Config.killY) { // 떨어진 프롭 리스폰
          p.pos.set(-2.5, 2, 20); p.vel.set(0, 0, 0);
        }
      }
      p.mesh.position.copy(p.pos);
    }
  }

  #pushBy(human, p) {
    _v1.set(p.pos.x - human.pos.x, 0, p.pos.z - human.pos.z);
    const d = _v1.length(), minD = p.half + Config.playerRadius;
    const overlapY = (p.pos.y - p.half) < (human.pos.y + 1.5) && (p.pos.y + p.half) > human.pos.y;
    if (d < minD && d > 0.001 && overlapY) {
      _v1.normalize();
      const push = (minD - d) * 8;
      p.pos.addScaledVector(_v1, push * 0.016);
      p.vel.addScaledVector(_v1, push * 0.35);
      p.vel.addScaledVector(human.vel, 0.06);
      if (p.owner !== this.ctx.get('net').selfKey) {
        p.owner = this.ctx.get('net').selfKey;
        this.ctx.get('net')?.claimProp(p);
      }
    }
  }

  #pushByRemote(r, p) {
    _v1.set(p.pos.x - r.pos.x, 0, p.pos.z - r.pos.z);
    const d = _v1.length(), minD = p.half + Config.playerRadius;
    if (d < minD && d > 0.001) {
      _v1.normalize();
      p.pos.addScaledVector(_v1, (minD - d) * 4 * 0.016);
    }
  }

  update(dt, ctx) {
    if (this.ring) this.ring.rotation.z += dt * 0.8;
    if (this.beam) {
      const t = ctx.clock.elapsed;
      this.beam.material.opacity = 0.2 + Math.sin(t * 2.4) * 0.08;
      this.beam.rotation.y += dt * 0.4;
    }
    // 파티클
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.vel.y -= p.grav * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.material.opacity = Math.min(1, p.life / (p.max * 0.5));
    }
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _zero = new THREE.Vector3();
