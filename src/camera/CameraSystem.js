import * as THREE from 'three';

// 3인칭 추적 카메라. yaw/pitch는 Input.look이 누적, 움직임 기준각 제공.
export class CameraSystem {
  yaw = Math.PI;
  pitch = 0.25;
  dist = 4.6;

  async init(ctx) { this.ctx = ctx; }

  fixedUpdate(dt, ctx) {
    const input = ctx.input;
    this.yaw += input.look.x;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.look.y, -0.9, 1.1);
    this.dist = THREE.MathUtils.clamp(this.dist + input.zoom * 0.6, 2.4, 9);
  }

  update(dt, ctx) {
    const human = ctx.get('human');
    const world = ctx.get('world');
    _t.set(human.pos.x, human.pos.y + 1.55, human.pos.z);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _o.set(
      _t.x + Math.sin(this.yaw) * cp * this.dist,
      _t.y + sp * this.dist,
      _t.z + Math.cos(this.yaw) * cp * this.dist
    );
    // 카메라가 땅에 묻히지 않게
    const g = world.groundAt(_o.x, _o.z, _o.y);
    if (g !== null && _o.y < g + 0.4) _o.y = g + 0.4;
    ctx.camera.position.lerp(_o, 1 - Math.exp(-14 * dt));
    ctx.camera.lookAt(_t);
  }
}
const _t = new THREE.Vector3(), _o = new THREE.Vector3();
