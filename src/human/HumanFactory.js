import * as THREE from 'three';

// 절차적 말랑 휴먼. 외부 에셋 없음 (stickfight처럼 코드로 생성).
// root 원점 = 발바닥, 정면 = -Z (yaw 0).
export function createHumanMesh({ suit = '#ff8c42', skin = '#ffd9b3' } = {}) {
  const root = new THREE.Group();
  const mat = (c, extra = {}) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0, ...extra });

  const suitMat = mat(suit);
  const skinMat = mat(skin);

  // 다리 (고관절 피벗)
  const legGeo = new THREE.CapsuleGeometry(0.11, 0.52, 6, 12);
  const mkLeg = (x) => {
    const g = new THREE.Group();
    g.position.set(x, 0.78, 0);
    const m = new THREE.Mesh(legGeo, suitMat);
    m.position.y = -0.34; m.castShadow = true;
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), mat('#3a3f4d'));
    shoe.position.set(0, -0.66, -0.05); shoe.scale.set(1, 0.7, 1.3);
    g.add(m, shoe); root.add(g);
    return g;
  };
  const legL = mkLeg(-0.15), legR = mkLeg(0.15);

  // 몸통 그룹 (흔들림용)
  const torso = new THREE.Group();
  torso.position.y = 0.78;
  root.add(torso);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.5, 8, 16), suitMat);
  body.position.y = 0.42; body.castShadow = true;
  torso.add(body);
  // 배낭 스트랩 장식
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.56), mat('#5b6270'));
  strap.position.y = 0.42; torso.add(strap);

  // 머리
  const headG = new THREE.Group();
  headG.position.y = 1.02;
  torso.add(headG);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 20, 16), skinMat);
  head.position.y = 0.18; head.castShadow = true;
  headG.add(head);
  const eyeMat = mat('#20242e', { roughness: 0.4 });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), eyeMat);
    eye.position.set(sx * 0.09, 0.2, -0.19);
    headG.add(eye);
  }
  // 비니
  const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.235, 20, 12, 0, Math.PI * 2, 0, 1.25), mat('#3f6fe0'));
  beanie.position.y = 0.21;
  headG.add(beanie);

  // 팔 (어깨 피벗, 아래로 뻗음)
  const armGeo = new THREE.CapsuleGeometry(0.085, 0.42, 6, 12);
  const mkArm = (x) => {
    const g = new THREE.Group();
    g.position.set(x, 0.72, 0);
    const m = new THREE.Mesh(armGeo, suitMat);
    m.position.y = -0.28; m.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), skinMat);
    hand.position.y = -0.56; hand.castShadow = true;
    g.add(m, hand); torso.add(g);
    return { shoulder: g, hand };
  };
  const armL = mkArm(-0.36), armR = mkArm(0.36);

  // 이름표 스프라이트
  const label = makeLabel('');
  label.sprite.position.y = 2.05;
  root.add(label.sprite);
  const setName = (t) => { label.set(t); };

  return { root, torso, headG, legL, legR, armL, armR, setName, suitMat };
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1.5, 0.375, 1);
  const set = (t) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    if (!t) { tex.needsUpdate = true; return; }
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.75)';
    g.strokeText(t, 128, 32); g.fillStyle = '#fff'; g.fillText(t, 128, 32);
    tex.needsUpdate = true;
  };
  set(text);
  return { sprite, set };
}

// 매 프레임 포즈 적용. s: { walkPhase, speed01, airborne, grabL, grabR,
//   reachL(0..1), reachR, lookPitch, taunt, wobble }
const _v = new THREE.Vector3();
export function applyHumanPose(r, s, dt, time) {
  const sp = s.speed01, wp = s.walkPhase;
  // 몸통: 앞으로 기울기 + 좌우 흔들림 + 점프시 뒤로 젖힘
  r.torso.rotation.x = sp * 0.22 + (s.airborne ? -0.12 : 0) + (s.taunt ? Math.sin(time * 10) * 0.06 : 0);
  r.torso.rotation.z = Math.sin(wp) * 0.07 * Math.min(1, sp + 0.2) + (s.taunt ? Math.sin(time * 7) * 0.15 : 0);
  r.torso.position.y = 0.78 + Math.abs(Math.sin(wp)) * 0.045 * sp - (s.airborne ? 0.02 : 0);
  r.headG.rotation.z = -Math.sin(wp) * 0.09 * sp;
  r.headG.rotation.x = -s.lookPitch * 0.35;
  // 다리: 엇갈리게 흔들, 공중이면 허우적
  const swing = s.airborne ? 0.55 : Math.min(1, sp) * 0.75;
  r.legL.rotation.x = Math.sin(wp) * swing;
  r.legR.rotation.x = -Math.sin(wp) * swing;
  // 팔: 걷기 스윙 vs 잡기 뻗기 블렌드
  poseArm(r.armL, -Math.sin(wp) * 0.6 * sp, s.reachL, s.lookPitch, time);
  poseArm(r.armR, Math.sin(wp) * 0.6 * sp, s.reachR, s.lookPitch, time);
}

function poseArm(arm, swing, reach, pitch, time) {
  // reach 0 = 축 늘어짐+흔들, 1 = 앞으로 쭉 뻗음
  const wob = Math.sin(time * 3.1) * 0.03;
  arm.shoulder.rotation.x = swing * (1 - reach) + (-1.35 + pitch * 0.6) * reach + wob;
  arm.shoulder.rotation.z = (arm === undefined ? 0 : 0) + (1 - reach) * 0.12 + wob;
}

export function handWorld(arm, out) {
  arm.hand.getWorldPosition(out);
  return out;
}
