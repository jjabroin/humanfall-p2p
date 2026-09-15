import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { EV } from '../core/events.js';

// 떠있는 섬 레벨 + 잡기/밀기 가능한 프롭 + 골인 링.
// 물리는 커스텀 경량 물리 (stickfight처럼 외부 물리엔진 없음).
export class WorldSystem {
  solids = [];     // { x0,x1,z0,z1,top,bottom,mover|null,mesh }
  props = [];      // { id, mesh, pos, vel, half, grabbedBy:{player,side}|null, owner, remote }
  climbWalls = []; // { x0,x1,z0,z1,y0,y1 }
  pads = [];       // 점프대 { x,y,z,r,power,mesh }
  checkpoints = []; // { x,y,z,r,mesh }
  spawnPoint = { x: 0, y: 0, z: -4, yaw: Math.PI };
  goal = new THREE.Vector3(0, 8.4, 105);

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
    this.#island(scene, 0, 50.5, 9, 8, 1.4);      // CP1 휴식 단상 (높이 1.4)
    this.#island(scene, -11, 24, 5, 5, 0.8);      // 옆 숨은 섬

    // ---- 지옥 점프맵 ----
    this.#beam(scene, 0, 58.75, 1.0, 8.5, 1.4);   // 외나무 다리
    this.#island(scene, 0, 65, 4, 4, 1.4);        // CP2 섬
    this.#mover(scene, 0, 70.5, 0);               // 무빙 발판 x3
    this.#mover(scene, 0, 74.5, 2.1);
    this.#mover(scene, 0, 78.5, 4.2);
    this.#island(scene, 0, 83.5, 5, 5, 1.4);      // 점프대 섬
    this.#pad(scene, 0, 1.4, 83.5, 18);           // 하늘로 발사
    this.#island(scene, 0, 89.5, 6, 6, 7.4);      // 하늘 섬 + CP3
    this.#pillar(scene, -2, 94.5, 7.4);           // 정밀 발판 x3
    this.#pillar(scene, 2, 97.5, 7.4);
    this.#pillar(scene, -2, 100.5, 7.4);
    this.#island(scene, 0, 105, 8, 8, 7.4);       // 최종 골인 섬

    this.#checkpoint(scene, 0, 1.4, 50.5);        // CP1
    this.#checkpoint(scene, 0, 1.4, 65);          // CP2
    this.#checkpoint(scene, 0, 7.4, 89.5);        // CP3

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
    pad.position.set(this.goal.x, this.goal.y - 0.94, this.goal.z);
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
    this.solids.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, top, bottom: top - 0.5, mover: null, mesh: grass });
  }

  // 외나무 다리 (좁은 박스)
  #beam(scene, cx, cz, w, d, top) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.4, d),
      new THREE.MeshStandardMaterial({ color: '#a4713d', roughness: 0.9 })
    );
    mesh.position.set(cx, top - 0.2, cz);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    this.solids.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, top, bottom: top - 0.4, mover: null, mesh });
  }

  // 무빙 발판 (좌우로 왕복)
  #mover(scene, cx, cz, phase) {
    const s = 2.4, top = 1.4;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s, 0.5, s),
      new THREE.MeshStandardMaterial({ color: '#d9a03d', roughness: 0.7 })
    );
    mesh.position.set(cx, top - 0.25, cz);
    mesh.castShadow = mesh.receiveShadow = true;
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: '#7a5210' })
    );
    mesh.add(edge);
    scene.add(mesh);
    this.solids.push({
      x0: cx - s / 2, x1: cx + s / 2, z0: cz - s / 2, z1: cz + s / 2,
      top, bottom: top - 0.5, mesh,
      mover: { cx, cz, ax: 3.2, az: 0, speed: 0.7, phase, dx: 0, dz: 0 },
    });
  }

  // 정밀 점프 기둥
  #pillar(scene, cx, cz, top) {
    const s = 1.3;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s, 3, s),
      new THREE.MeshStandardMaterial({ color: '#8a6b4f', roughness: 0.95 })
    );
    mesh.position.set(cx, top - 1.5, cz);
    mesh.castShadow = mesh.receiveShadow = true;
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(s + 0.1, 0.15, s + 0.1),
      new THREE.MeshStandardMaterial({ color: '#6fbf5a', roughness: 0.9 })
    );
    cap.position.set(cx, top - 0.07, cz);
    scene.add(mesh, cap);
    this.solids.push({ x0: cx - s / 2, x1: cx + s / 2, z0: cz - s / 2, z1: cz + s / 2, top, bottom: top - 3, mover: null, mesh });
  }

  // 점프대 (밟으면 위로 발사)
  #pad(scene, x, topY, z, power) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.0, 0.25, 20),
      new THREE.MeshStandardMaterial({ color: '#22d3ee', emissive: '#0e7490', emissiveIntensity: 0.9, roughness: 0.4 })
    );
    mesh.position.set(x, topY + 0.12, z);
    scene.add(mesh);
    this.pads.push({ x, y: topY, z, r: 1.0, power, mesh });
  }

  // 체크포인트 깃발
  #checkpoint(scene, x, topY, z) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 2.2, 10),
      new THREE.MeshStandardMaterial({ color: '#e5e7eb', roughness: 0.5 })
    );
    pole.position.y = 1.1;
    const flag = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.55, 0.06),
      new THREE.MeshStandardMaterial({ color: '#22b573', emissive: '#22b573', emissiveIntensity: 0.7 })
    );
    flag.position.set(0.48, 1.8, 0);
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 10),
      new THREE.MeshStandardMaterial({ color: '#22b573', emissive: '#22b573', emissiveIntensity: 1.4 })
    );
    orb.position.y = 2.3;
    g.add(pole, flag, orb);
    g.position.set(x, topY, z);
    scene.add(g);
    this.checkpoints.push({ x, y: topY, z, r: 1.8, mesh: g, orb });
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
  solidAt(x, z, feetY) {
    let best = null;
    for (const s of this.solids) {
      if (x > s.x0 - 0.2 && x < s.x1 + 0.2 && z > s.z0 - 0.2 && z < s.z1 + 0.2) {
        if (s.top <= feetY + Config.stepHeight && (best === null || s.top > best.top)) best = s;
      }
    }
    return best;
  }
  groundAt(x, z, feetY) {
    return this.solidAt(x, z, feetY)?.top ?? null;
  }

  padAt(pos) {
    for (const p of this.pads) {
      const dx = pos.x - p.x, dz = pos.z - p.z;
      if (dx * dx + dz * dz < p.r * p.r && pos.y <= p.y + 0.4 && pos.y > p.y - 1.6) return p;
    }
    return null;
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
    const hit = this.solidAt(pos.x, pos.z, pos.y + 0.3);
    const g = hit?.top ?? null;
    if (g !== null && pos.y <= g + 0.02 && vel.y <= 0.01) {
      pos.y = g; vel.y = 0; grounded = true;
    } else if (g !== null && pos.y < g) {
      pos.y = g; vel.y = 0; grounded = true;
    }
    return { grounded, ride: grounded && hit?.mover ? hit.mover : null };
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
    return pos.distanceToSquared(this.goal) < 2.56 && Math.abs(pos.y + 1.2 - this.goal.y) < 2.4;
  }

  // ---- 잡기 ----
  // 소유권은 (timestamp, owner) 전순서로 수렴: 최신 선언이 항상 승리 → 양쪽이 같은 주인으로 합의
  #takeOwnership(prop) {
    const net = this.ctx.get('net');
    prop.owner = net.selfKey;
    prop.claimT = Date.now();
    prop.claimBy = net.selfKey;
    prop.remote = false;
    prop.syncTarget = null;
  }
  setGrab(prop, player, side) {
    prop.grabbedBy = { player, side };
    this.#takeOwnership(prop);
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
    this.#takeOwnership(prop);
    this.ctx.get('net')?.claimProp(prop);
  }

  fixedUpdate(dt, ctx) {
    const net = ctx.get('net');
    const human = ctx.get('human');
    // 무빙 발판 이동 (전후 델타 저장 → 올라탄 플레이어가 같이 이동)
    const t = ctx.clock.elapsed;
    for (const s of this.solids) {
      const m = s.mover;
      if (!m) continue;
      const nx = m.cx + Math.sin(t * m.speed + m.phase) * m.ax;
      const nz = m.cz + Math.cos(t * m.speed * 0.7 + m.phase) * m.az;
      m.dx = nx - (s.x0 + s.x1) / 2;
      m.dz = nz - (s.z0 + s.z1) / 2;
      const w = s.x1 - s.x0, d = s.z1 - s.z0;
      s.x0 = nx - w / 2; s.x1 = nx + w / 2;
      s.z0 = nz - d / 2; s.z1 = nz + d / 2;
      if (s.mesh) s.mesh.position.set(nx, s.top - 0.25, nz);
    }
    for (const p of this.props) {
      if (p.remote) {
        // 리모트 프롭도 접촉은 감지 (소유권 탈환용), 시뮬은 주인이
        this.#seizeCheck(p, human, net);
        continue;
      }
      if (p.grabbedBy) {
        // 잡은 손 위치로 스프링 추종 (강성+감쇠로 흔들림 없이)
        const holder = p.grabbedBy.player;
        holder.handPos(p.grabbedBy.side, _v1);
        _v2.copy(_v1).add(p.grabbedBy.offset ?? _zero);
        _v3.copy(_v2).sub(p.pos);
        p.vel.addScaledVector(_v3, 90 * dt);
        p.vel.multiplyScalar(Math.max(0, 1 - 12 * dt));
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
        this.#takeOwnership(p);
        this.ctx.get('net')?.claimProp(p);
      }
    }
  }

  // 남의 프롭에 닿으면 소유권 탈환 (접촉 엣지에서 1회, 상대가 잡는 중이면 제외)
  #seizeCheck(p, human, net) {
    _v1.set(p.pos.x - human.pos.x, 0, p.pos.z - human.pos.z);
    const d = _v1.length();
    const overlapY = (p.pos.y - p.half) < (human.pos.y + 1.5) && (p.pos.y + p.half) > human.pos.y;
    const touching = d < p.half + Config.playerRadius + 0.15 && overlapY;
    if (touching && !p.touching && !p.grabbedBy && !p.heldByOther && p.owner !== net.selfKey) {
      this.#takeOwnership(p);
      net.claimProp(p);
    }
    p.touching = touching;
  }

  #pushByRemote(r, p) {    _v1.set(p.pos.x - r.pos.x, 0, p.pos.z - r.pos.z);
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
    for (const c of this.checkpoints) {
      if (c.orb) c.orb.position.y = 2.3 + Math.sin(ctx.clock.elapsed * 3 + c.x) * 0.12;
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
