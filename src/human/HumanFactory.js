import * as THREE from 'three';

// 휴먼 폴 플랫식 블롭 휴먼: 목 없는 일체형 둥글 몸통 + 밋밋한 얼굴 + 짧은 팔다리.
// 외부 에셋 없음, 코드로 생성. root 원점 = 발바닥, 정면 = -Z (yaw 0).
// ref 이름은 기존과 동일하게 유지 (HumanSystem/NetSystem 수정 불필요).
export function createHumanMesh({ suit = '#f2f3f5' } = {}) {
  const root = new THREE.Group();
  const mat = (c, extra = {}) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0, ...extra });
  const suitMat = mat(suit);
  const darkMat = mat('#20242e', { roughness: 0.5 });

  // 다리: 짧고 통통 (고관절 피벗)
  const legGeo = new THREE.CapsuleGeometry(0.115, 0.28, 6, 12);
  const mkLeg = (x) => {
    const g = new THREE.Group();
    g.position.set(x, 0.56, 0);
    const m = new THREE.Mesh(legGeo, suitMat);
    m.position.y = -0.2; m.castShadow = true;
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), suitMat);
    foot.position.set(0, -0.4, -0.05); foot.scale.set(1, 0.75, 1.35);
    g.add(m, foot); root.add(g);
    return g;
  };
  const legL = mkLeg(-0.15), legR = mkLeg(0.15);

  // 몸통: 하나의 큰 둥글 캡슐 (머리+몸 일체형)
  const torso = new THREE.Group();
  torso.position.y = 0.56;
  root.add(torso);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.66, 10, 20), suitMat);
  body.position.y = 0.56; body.castShadow = true;   // 절대 높이 ~1.12 중심, 꼭대기 ~1.72
  torso.add(body);
  // 엉덩이/배 볼륨감 (살짝 납작한 구)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 14), suitMat);
  belly.position.y = 0.32; belly.scale.set(1, 0.85, 0.95);
  torso.add(belly);

  // 얼굴: 몸통 앞면에 직접 (눈 2개만, HFF식)
  const headG = new THREE.Group();
  headG.position.set(0, 0.88, -0.24);
  torso.add(headG);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), darkMat);
    eye.position.set(sx * 0.12, 0.02, -0.09);
    eye.scale.z = 0.6;
    headG.add(eye);
  }

  // 팔: 짧고 굵음 (어깨 피벗), 손은 몸통과 같은 색 미튼
  const armGeo = new THREE.CapsuleGeometry(0.095, 0.26, 6, 12);
  const mkArm = (x) => {
    const g = new THREE.Group();
    g.position.set(x, 0.68, 0);
    const m = new THREE.Mesh(armGeo, suitMat);
    m.position.y = -0.2; m.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), suitMat);
    hand.position.y = -0.42; hand.castShadow = true;
    g.add(m, hand); torso.add(g);
    return { shoulder: g, hand };
  };
  const armL = mkArm(-0.4), armR = mkArm(0.4);

  // 이름표 스프라이트
  const label = makeLabel('');
  label.sprite.position.y = 2.0;
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

// 매 프레임 포즈 적용. s: { walkPhase, speed01, airborne, reachL/R, lookPitch, taunt }
export function applyHumanPose(r, s, dt, time) {
  const sp = s.speed01, wp = s.walkPhase;
  // 블롭 특유의 좌우 출렁임 + 앞으로 기울기
  r.torso.rotation.x = sp * 0.18 + (s.airborne ? -0.1 : 0);
  r.torso.rotation.z = Math.sin(wp) * 0.09 * Math.min(1, sp + 0.25) + (s.taunt ? Math.sin(time * 7) * 0.16 : 0);
  r.torso.position.y = 0.56 + Math.abs(Math.sin(wp)) * 0.04 * sp;
  r.torso.rotation.y = Math.sin(wp * 0.5) * 0.05 * sp;
  // 얼굴은 시선을 따라 살짝
  r.headG.rotation.x = -s.lookPitch * 0.3;
  // 짧은 다리 파닥파닥, 공중이면 허우적
  const swing = s.airborne ? 0.7 : Math.min(1, sp) * 0.9;
  r.legL.rotation.x = Math.sin(wp) * swing;
  r.legR.rotation.x = -Math.sin(wp) * swing;
  poseArm(r.armL, -Math.sin(wp) * 0.7 * sp, s.reachL, s.lookPitch, time);
  poseArm(r.armR, Math.sin(wp) * 0.7 * sp, s.reachR, s.lookPitch, time);
}

function poseArm(arm, swing, reach, pitch, time) {
  const wob = Math.sin(time * 3.1) * 0.04;
  arm.shoulder.rotation.x = swing * (1 - reach) + (-1.3 + pitch * 0.6) * reach + wob;
  arm.shoulder.rotation.z = (1 - reach) * 0.15 + wob;
}

export function handWorld(arm, out) {
  arm.hand.getWorldPosition(out);
  return out;
}
