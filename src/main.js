import { Engine } from './core/Engine.js';
import { WorldSystem } from './world/WorldSystem.js';
import { HumanSystem } from './human/HumanSystem.js';
import { NetSystem } from './net/NetSystem.js';
import { CameraSystem } from './camera/CameraSystem.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { UISystem } from './ui/UISystem.js';

// stickfight식 시스템 등록: 순서 무관, Engine이 고정 순서로 실행.
const canvas = document.getElementById('game');
const engine = new Engine(canvas);

engine
  .use('world', new WorldSystem())
  .use('human', new HumanSystem())
  .use('net', new NetSystem())
  .use('camera', new CameraSystem())
  .use('audio', new AudioSystem())
  .use('ui', new UISystem());

await engine.init();
engine.start();

if (new URLSearchParams(location.search).has('debug')) {
  globalThis.game = engine;
  console.info('[debug] engine exposed as window.game');
}
