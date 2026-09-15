import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { EV } from '../core/events.js';

// 떠있는 섬 레벨 + 잡기/밀기 가능한 프롭 + 골인 링.
// 물리는 커스텀 경량 물리 (stickfight처럼 외부 물리엔진 없음).
// 잡기는 힘 기반: 손 스프링(힘 상한) vs 무게. 가벼우면 들리고, 무거우면 못 들고 끌려감.
const HAND_FMAX = 360;   // 손 하나가 낼 수 있는 최대 힘 (공 한 손 432에는 못 미침)
const GRAB_K = 1000;      // 잡기 스프링 강성 (가벼운 건 손 높이에서도 들리게)
const PLAYER_MASS = 70;
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
    this.#island(scene, 0, 39.75, 11, 13.5, 0);   // 타워 섬 (클라임벽 밑 틈새 메움)
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

    // 프롭: 크레이트 3 + 공 1 + 옆섬 크레이트 1 + 무거운 큰 크레이트 1
    this.#crate(scene, -2.5, 0.45, 20, 0.9, 10);
    this.#crate(scene, 2.5, 0.45, 22, 0.9, 10);
    this.#crate(scene, 0.5, 0.35, 19, 0.7, 8);
    this.#ball(scene, -1.5, 0.6, 23);
    this.#crate(scene, -11, 1.25, 24, 0.9, 10);
    this.#crate(scene, 3.2, 0.65, 19.5, 1.3, 60);

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

  #crate(scene, x, y, z, s = 0.9, mass = 8) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s),
      new THREE.MeshStandardMaterial({ color: s > 1 ? '#8f5a2b' : '#c98f4e', roughness: 0.9 })
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
      half: s / 2, mass, holds: [], grabbedBy: null, owner: 'local', remote: false,
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
      half: 0.6, round: true, mass: 18, holds: [], grabbedBy: null, owner: 'local', remote: false,
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

  // 설 수 있는 최고면 (지형+프롭). ride는 무빙 발판에서만.
  // 프롭은 스텝 허용이 작음 (옆에서 부딪히면 위로 순간이동하지 않음)
  standAt(x, z, feetY, ignoreProp = null) {
    const hit = this.solidAt(x, z, feetY);
    let top = hit?.top ?? null;
    let ride = null;
    if (hit) ride = hit.mover ?? null;
    for (const p of this.props) {
      if (p === ignoreProp) continue;
      if (Math.abs(p.vel.y) > 4) continue;
      const t = p.pos.y + p.half;
      if (Math.abs(x - p.pos.x) < p.half + 0.15 && Math.abs(z - p.pos.z) < p.half + 0.15) {
        if (t <= feetY + 0.3 && (top === null || t > top)) { top = t; ride = null; }
      }
    }
    return top === null ? null : { top, ride };
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
    // 착지 (지형 + 프롭 위)
    const hit = this.standAt(pos.x, pos.z, pos.y + 0.3);
    const g = hit?.top ?? null;
    if (g !== null && pos.y <= g + 0.02 && vel.y <= 0.01) {
      pos.y = g; vel.y = 0; grounded = true;
    } else if (g !== null && pos.y < g) {
      pos.y = g; vel.y = 0; grounded = true;
    }
    return { grounded, ride: grounded ? hit?.ride ?? null : null };
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

  // 잡을 수 있는 표면점: 클라임벽 전체 + 지형의 옆면/윗모서리/밑면
  // (윗면 한가운데는 제외 — 바닥을 잡는 건 무의미). 무빙 발판은 제외.
  grabSurface(hand, maxDist) {
    let bx = 0, by = 0, bz = 0, bestD = maxDist;
    let found = false;
    const considerBox = (x0, x1, y0, y1, z0, z1) => {
      const px = THREE.MathUtils.clamp(hand.x, x0, x1);
      const py = THREE.MathUtils.clamp(hand.y, y0, y1);
      const pz = THREE.MathUtils.clamp(hand.z, z0, z1);
      const topInner = Math.abs(py - y1) < 0.12
        && px > x0 + 0.35 && px < x1 - 0.35 && pz > z0 + 0.35 && pz < z1 - 0.35;
      if (topInner) return;
      const d = Math.hypot(hand.x - px, hand.y - py, hand.z - pz);
      if (d < bestD) { bestD = d; bx = px; by = py; bz = pz; found = true; }
    };
    for (const w of this.climbWalls) considerBox(w.x0, w.x1, w.y0, w.y1, w.z0, w.z1);
    for (const s of this.solids) {
      if (s.mover) continue;
      considerBox(s.x0, s.x1, s.bottom, s.top, s.z0, s.z1);
    }
    return found ? { x: bx, y: by, z: bz } : null;
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
  setGrab(prop, player, side, offset) {
    prop.holds.push({ player, side, offset: offset ? offset.clone() : new THREE.Vector3(), age: 0, lastF: 0 });
    this.#takeOwnership(prop);
    this.ctx.get('net')?.claimProp(prop);
  }
  releaseGrab(prop, player, side) {
    const i = prop.holds.findIndex((h) => h.player === player && h.side === side);
    if (i < 0) return;
    prop.holds.splice(i, 1);
    if (prop.holds.length > 0) return; // 다른 손이 아직 잡음
    // 놓을 때 손 속도를 물려줘서 던지기 가능
    prop.vel.copy(player.vel);
    prop.vel.y += 2.0;
    const f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
    const hs = Math.hypot(player.vel.x, player.vel.z);
    prop.vel.addScaledVector(f, Math.min(hs * 0.6, 3) + Config.throwBoost * 0.5);
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
      if (p.holds.length > 0) {
        // HFF식 잡기: 손은 물체 표면에 붙고(렌더는 IK), 절차적 손 목표점과의
        // 차이만큼 힘을 줌. 위를 볼수록 수직 힘 허용(들어올림), 평소엔 끌기.
        // 몸도 반작용으로 당겨져서 함께 느리게 움직임.
        _f.set(0, 0, 0);
        const dampC = Math.sqrt(GRAB_K * p.mass);
        const pitch = ctx.get('camera').pitch;
        const gate = THREE.MathUtils.clamp((-pitch - 0.05) / 0.35, 0.12, 1);
        for (const h of p.holds) {
          h.age = (h.age ?? 0) + dt;
          const grip = Math.min(1, h.age / 0.25); // 잡은 직후 0.25초간 서서히 (낚아채기 방지)
          h.player.desiredHand(h.side, _v1, pitch);
          // 앵커 속도 (상대 감쇠용: 함께 움직이면 감쇠 없음)
          let avx = 0, avy = 0, avz = 0;
          if (h.ax !== undefined) {
            avx = (_v1.x - h.ax) / dt; avy = (_v1.y - h.ay) / dt; avz = (_v1.z - h.az) / dt;
          }
          h.ax = _v1.x; h.ay = _v1.y; h.az = _v1.z;
          _v2.copy(p.pos).add(h.offset);   // 붙은 표면점
          _v3.copy(_v1).sub(_v2);          // 표면점 → 목표점
          const dist = _v3.length();
          const fmax = HAND_FMAX * (h.player.lifting ? 1.5 : 1) * grip;
          if (dist > 0.02 && fmax > 1) {
            _v3.multiplyScalar(Math.min(fmax, dist * GRAB_K) / dist);
            _v3.x -= (p.vel.x - avx) * dampC;
            _v3.y -= (p.vel.y - avy) * dampC;
            _v3.z -= (p.vel.z - avz) * dampC;
            if (_v3.y > 0) _v3.y = Math.min(_v3.y, fmax * gate); // 들어올리기 게이트
            if (_v3.length() > fmax) _v3.setLength(fmax);
            h.lastF = _v3.length();
            _f.add(_v3);
            h.player.vel.addScaledVector(_v3, -dt / PLAYER_MASS);
          } else {
            h.lastF = 0;
          }
        }
        p.vel.addScaledVector(_f, dt / p.mass);
        p.vel.y -= Config.gravity * dt;
        // 하나 되기: 무거울수록 몸 속도가 물체 속도에 끌려감 (같이 느려지고 같이 떨어짐)
        for (const h of p.holds) {
          const couple = (p.mass / (p.mass + PLAYER_MASS)) * Math.min(1, 8 * dt);
          h.player.vel.x += (p.vel.x - h.player.vel.x) * couple;
          h.player.vel.y += (p.vel.y - h.player.vel.y) * couple;
          h.player.vel.z += (p.vel.z - h.player.vel.z) * couple;
        }
        this.#stepProp(p, dt);
        // 든 물건은 몸 밖으로 (관통 금지): 홀더 몸통을 고체로 취급
        for (const h of p.holds) {
          const hx = p.pos.x - h.player.pos.x, hz = p.pos.z - h.player.pos.z;
          const dy = p.pos.y - (h.player.pos.y + 0.9);
          const hd = Math.hypot(hx, hz), hmin = p.half + 0.34;
          if (hd < hmin && hd > 0.001 && Math.abs(dy) < 1.2) {
            const push = hmin - hd;
            p.pos.x += (hx / hd) * push;
            p.pos.z += (hz / hd) * push;
          }
        }
        this.#groundProp(p, dt, true);
        p.owner = net.selfKey;
      } else if (p.owner === net.selfKey) {
        p.vel.y -= Config.gravity * dt;
        // 플레이어에게 밀림
        this.#pushBy(human, p);
        for (const r of net.remotes()) this.#pushByRemote(r, p);
        // 벽 + 바닥 (서브스텝 적분 포함)
        this.#stepProp(p, dt);
        this.#groundProp(p, dt, false);
      }
    }
    // 물체끼리 충돌 (2회 완화): 쌓기/밀기. 위로는 절대 튀지 않음.
    // 페어 해소 전 위치를 저장 → 해소 후 벽 충돌 (벽 속으로 밀려 들어감 방지)
    for (const p of this.props) {
      if (p.remote) continue;
      p._px = p.pos.x; p._py = p.pos.y; p._pz = p.pos.z;
    }
    this.#solvePropPairs();
    for (const p of this.props) {
      if (p.remote) continue;
      _sweepPrev.set(p._px, p._py, p._pz);
      this.collideProp(p, _sweepPrev);
      p.mesh.position.copy(p.pos);
    }
  }

  #solvePropPairs() {
    const ps = this.props;
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        if (a.remote) continue;
        for (let j = i + 1; j < ps.length; j++) {
          const b = ps[j];
          if (b.remote) continue;
          const ox = (a.half + b.half) - Math.abs(a.pos.x - b.pos.x);
          const oz = (a.half + b.half) - Math.abs(a.pos.z - b.pos.z);
          if (ox <= 0 || oz <= 0) continue;
          const oy = Math.min(a.pos.y + a.half, b.pos.y + b.half) - Math.max(a.pos.y - a.half, b.pos.y - b.half);
          if (oy <= 0) continue;
          const ma = a.mass ?? 10, mb = b.mass ?? 10, tot = ma + mb;
          if (oy < Math.min(ox, oz) * 0.6) {
            // 위아래로 포개짐: 위를 받침 (y 고정 + 수직속도 동기 + 수평 마찰)
            const top = a.pos.y > b.pos.y ? a : b;
            const bot = top === a ? b : a;
            top.pos.y = bot.pos.y + bot.half + top.half;
            if (top.vel.y < bot.vel.y) top.vel.y = bot.vel.y;
            top.vel.x += (bot.vel.x - top.vel.x) * 0.2;
            top.vel.z += (bot.vel.z - top.vel.z) * 0.2;
          } else {
            // 옆으로: 질량 분할 + 반발 (탄성 0.1)
            let nx = 0, nz = 0, pen = 0;
            if (ox < oz) { pen = ox; nx = Math.sign(a.pos.x - b.pos.x) || 1; }
            else { pen = oz; nz = Math.sign(a.pos.z - b.pos.z) || 1; }
            a.pos.x += nx * pen * (mb / tot); a.pos.z += nz * pen * (mb / tot);
            b.pos.x -= nx * pen * (ma / tot); b.pos.z -= nz * pen * (ma / tot);
            const rvx = a.vel.x - b.vel.x, rvz = a.vel.z - b.vel.z;
            const vn = rvx * nx + rvz * nz;
            if (vn < 0) {
              const jimp = -(1 + 0.1) * vn / (1 / ma + 1 / mb);
              a.vel.x += nx * jimp / ma; a.vel.z += nz * jimp / ma;
              b.vel.x -= nx * jimp / mb; b.vel.z -= nz * jimp / mb;
            }
          }
        }
      }
    }
  }

  // 특정 플레이어가 잡기로 가하는 힘 비율 (0~1, 몸 감속/기울기용)
  strainOf(player) {
    let f = 0, n = 0;
    for (const p of this.props) {
      for (const h of p.holds) {
        if (h.player === player) { f = Math.max(f, h.lastF ?? 0); n++; }
      }
    }
    if (!n) return 0;
    return THREE.MathUtils.clamp(f / HAND_FMAX, 0, 1);
  }

  // 빠른 물체는 나눠서 적분+충돌 (얇은 벽 터널링 방지)
  #stepProp(p, dt) {
    const travel = p.vel.length() * dt;
    const steps = travel > p.half ? 4 : travel > p.half * 0.5 ? 2 : 1;
    for (let i = 0; i < steps; i++) {
      _sweepPrev.copy(p.pos);
      p.pos.addScaledVector(p.vel, dt / steps);
      this.collideProp(p, _sweepPrev);
    }
  }

  #groundProp(p, dt, held) {
    const g = this.standAt(p.pos.x, p.pos.z, p.pos.y, p)?.top ?? null;
    const restY = (g ?? -100) + p.half;
    if (p.pos.y <= restY && p.vel.y <= 0) {
      p.pos.y = restY; p.vel.y = 0;
      p.vel.x *= (1 - 6 * dt); p.vel.z *= (1 - 6 * dt);
    }
    if (!held && p.pos.y < Config.killY) { // 떨어진 프롭 리스폰 (잡은 건 4m 자동해제로 처리)
      p.pos.set(-2.5, 2, 20); p.vel.set(0, 0, 0);
    }
  }

  // 프롭 vs 지형 벽밀어내기 (잡고 벽에 박아도 통과 안 함). 리모트 복사본에도 적용.
  collideProp(p, prev) {
    for (const s of this.solids) {
      this.#pushPropOut(p, prev, s.x0, s.x1, s.z0, s.z1, s.top, s.bottom);
    }
    for (const w of this.climbWalls) {
      this.#pushPropOut(p, prev, w.x0, w.x1, w.z0, w.z1, w.y1, w.y0);
    }
  }
  // 스윕트 판정: prev(이전 위치)가 밖에 있었으면 들어온 면으로,
  // 이미 안에 있었으면 침투 최소축으로 밀어냄. 얇은 벽 터널링 방지.
  #pushPropOut(p, prev, x0, x1, z0, z1, top, bottom) {
    if (p.pos.y - p.half >= top - 0.05 || p.pos.y + p.half <= bottom + 0.05) return;
    const px0 = x0 - p.half, px1 = x1 + p.half;
    const pz0 = z0 - p.half, pz1 = z1 + p.half;
    if (!(p.pos.x > px0 && p.pos.x < px1 && p.pos.z > pz0 && p.pos.z < pz1)) return;
    if (prev) {
      const wasOut =
        prev.x <= px0 || prev.x >= px1 || prev.z <= pz0 || prev.z >= pz1;
      if (wasOut) {
        // 들어온 면으로 되돌림 (prev가 밖에 있던 축 중 최소 이동)
        let best = Infinity, face = 0;
        const cands = [
          [Math.abs(p.pos.x - px0), 1], [Math.abs(px1 - p.pos.x), 2],
          [Math.abs(p.pos.z - pz0), 3], [Math.abs(pz1 - p.pos.z), 4],
        ];
        // prev가 밖에 있던 면만 후보
        const valid = (f) =>
          (f === 1 && prev.x <= px0) || (f === 2 && prev.x >= px1) ||
          (f === 3 && prev.z <= pz0) || (f === 4 && prev.z >= pz1);
        for (const [dd, f] of cands) {
          if (valid(f) && dd < best) { best = dd; face = f; }
        }
        if (face === 1) { p.pos.x = px0; if (p.vel.x > 0) p.vel.x = 0; return; }
        if (face === 2) { p.pos.x = px1; if (p.vel.x < 0) p.vel.x = 0; return; }
        if (face === 3) { p.pos.z = pz0; if (p.vel.z > 0) p.vel.z = 0; return; }
        if (face === 4) { p.pos.z = pz1; if (p.vel.z < 0) p.vel.z = 0; return; }
      }
    }
    const dxl = p.pos.x - px0, dxr = px1 - p.pos.x;
    const dzl = p.pos.z - pz0, dzr = pz1 - p.pos.z;
    const m = Math.min(dxl, dxr, dzl, dzr);
    if (m === dxl) { p.pos.x = px0; if (p.vel.x > 0) p.vel.x = 0; }
    else if (m === dxr) { p.pos.x = px1; if (p.vel.x < 0) p.vel.x = 0; }
    else if (m === dzl) { p.pos.z = pz0; if (p.vel.z > 0) p.vel.z = 0; }
    else { p.pos.z = pz1; if (p.vel.z < 0) p.vel.z = 0; }
  }

  #pushBy(human, p) {
    if (p.holds.some((h) => h.player === human)) return; // 내가 든 건 몸으로 밀어내지 않음
    if (human.pos.y > p.pos.y) return; // 위에 올라탄 건 밀어내지 않음 (밟기 허용)
    _v1.set(p.pos.x - human.pos.x, 0, p.pos.z - human.pos.z);
    const d = _v1.length(), minD = p.half + Config.playerRadius;
    const overlapY = (p.pos.y - p.half) < (human.pos.y + 1.5) && (p.pos.y + p.half) > human.pos.y;
    if (d >= minD || d <= 0.001 || !overlapY) return;
    _v1.normalize();
    // 질량 분할: 가벼우면 물체가 밀리고, 무거우면 몸이 밀려남 (몸 70kg 기준)
    // 접근 속도에 비례한 가벼운 쿵 (탄성 0.4, 상한 2.5) — 몸으로 툭 쳐도 가볍게 날아가지 않음
    const m = p.mass ?? 10, pm = PLAYER_MASS;
    const push = (minD - d) * 8;
    const relVx = human.vel.x - p.vel.x, relVz = human.vel.z - p.vel.z;
    const approach = Math.max(0, relVx * _v1.x + relVz * _v1.z);
    const kick = Math.min(approach * 0.4, 2.5) * (pm / (pm + m));
    _prePush.copy(p.pos);
    p.pos.addScaledVector(_v1, push * 0.016 * (pm / (pm + m)));
    p.vel.addScaledVector(_v1, kick);
    human.pos.addScaledVector(_v1, -push * 0.016 * (m / (pm + m)));
    // 물체가 못 움직였으면(벽에 낌) 몸이 밀려남 — 끼인 물체는 고체
    this.collideProp(p, _prePush);
    _v1.set(p.pos.x - human.pos.x, 0, human.pos.z - human.pos.z);
    const d2 = _v1.length();
    if (d2 < minD && d2 > 0.001) {
      _v1.normalize();
      human.pos.addScaledVector(_v1, -(minD - d2));
    }
    if (p.owner !== this.ctx.get('net').selfKey) {
      this.#takeOwnership(p);
      this.ctx.get('net')?.claimProp(p);
    }
  }

  // 남의 프롭에 닿으면 소유권 탈환 (접촉 엣지에서 1회, 상대가 잡는 중이면 제외)
  #seizeCheck(p, human, net) {
    _v1.set(p.pos.x - human.pos.x, 0, p.pos.z - human.pos.z);
    const d = _v1.length();
    const overlapY = (p.pos.y - p.half) < (human.pos.y + 1.5) && (p.pos.y + p.half) > human.pos.y;
    const touching = d < p.half + Config.playerRadius + 0.15 && overlapY;
    if (touching && !p.touching && p.holds.length === 0 && !p.heldByOther && p.owner !== net.selfKey) {
      this.#takeOwnership(p);
      net.claimProp(p);
    }
    p.touching = touching;
  }

  // 로컬 플레이어 vs 리모트 프롭: 플레이어만 밀어냄 (리모트는 주인이 시뮬). Y는 건드리지 않음.
  pushPlayerFromRemoteProps(human) {
    for (const p of this.props) {
      if (!p.remote) continue;
      _v1.set(human.pos.x - p.pos.x, 0, human.pos.z - p.pos.z);
      const d = _v1.length(), minD = p.half + Config.playerRadius;
      const overlapY = (p.pos.y - p.half) < (human.pos.y + 1.5) && (p.pos.y + p.half) > human.pos.y;
      if (d < minD && d > 0.001 && overlapY) {
        _v1.normalize();
        human.pos.addScaledVector(_v1, (minD - d) * 0.5);
      }
    }
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
const _f = new THREE.Vector3();
const _sweepPrev = new THREE.Vector3();
const _prePush = new THREE.Vector3();
const _zero = new THREE.Vector3();
