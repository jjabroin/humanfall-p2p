import { EV } from '../core/events.js';

// DOM 오버레이: 메뉴(닉네임/방코드) + HUD(방코드/플레이어/토스트).
export class UISystem {
  async init(ctx) {
    this.ctx = ctx;
    const $ = (id) => document.getElementById(id);
    this.menu = $('menu'); this.hud = $('hud');
    this.roomCode = $('roomCode'); this.players = $('players');
    this.toastBox = $('toast'); this.grabTip = $('grabTip');
    this.lockTip = $('lockTip');

    const nick = $('nick'), code = $('code');
    nick.value = localStorage.getItem('hfall_nick') ?? '';
    const savedCode = localStorage.getItem('hfall_code');
    if (savedCode) code.value = savedCode;

    $('btnCreate').onclick = () => {
      const c = genCode();
      this.#join(c, nick.value || '말랑이');
    };
    $('btnJoin').onclick = () => {
      const c = (code.value || '').trim().toUpperCase();
      if (c.length < 4) { this.toast('방 코드를 4~6자로 입력하세요!'); return; }
      this.#join(c, nick.value || '말랑이');
    };
    $('btnSolo').onclick = () => {
      const human = ctx.get('human');
      human.setIdentity(nick.value || '말랑이', '#ff8c42');
      localStorage.setItem('hfall_nick', human.nickname);
      this.#enter(null);
      this.toast('혼자 놀기 모드 — 방 만들기로 친구를 초대하세요!');
    };
    $('roomPill').onclick = () => {
      const net = ctx.get('net');
      if (!net.roomCode) return;
      navigator.clipboard?.writeText(net.roomCode).then(
        () => this.toast(`방 코드 ${net.roomCode} 복사됨!`),
        () => this.toast(`방 코드: ${net.roomCode}`)
      );
    };
    this.lockTip.onclick = () => ctx.canvas.requestPointerLock?.();

    ctx.events.on(EV.GOAL, ({ name, self }) => {
      this.toast(self ? `🏆 ${name} 골인!! 다시 시작 지점으로~` : `🏆 ${name}님이 골인!`);
    });
    ctx.events.on(EV.PEER_JOIN, ({ name }) => this.toast(`👋 ${name} 참가!`));
    ctx.events.on(EV.PEER_LEAVE, ({ name }) => this.toast(`🚪 ${name} 퇴장`));
    ctx.events.on('input:pointerlock', (locked) => {
      this.lockTip.style.display = (!locked && this.inGame) ? 'flex' : 'none';
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.inGame) {
        // 포인터락 해제는 브라우저가 처리, 메뉴는 다시 열지 않음
      }
    });
  }

  #join(code, name) {
    const net = this.ctx.get('net');
    localStorage.setItem('hfall_nick', name);
    localStorage.setItem('hfall_code', code);
    try {
      net.connect(code, name);
      this.#enter(code);
      this.toast(`방 ${code} 연결 중... 같은 코드를 친구에게 알려주세요!`);
    } catch (err) {
      console.error(err);
      this.toast('연결 실패 😢 혼자 놀기로 시작합니다');
      this.#enter(null);
    }
  }

  #enter(code) {
    this.inGame = true;
    this.menu.classList.add('hidden');
    this.hud.classList.add('visible');
    this.roomCode.textContent = code ?? 'SOLO';
    this.ctx.canvas.requestPointerLock?.();
  }

  toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    this.toastBox.appendChild(el);
    while (this.toastBox.children.length > 3) this.toastBox.firstChild.remove();
    setTimeout(() => el.remove(), 4200);
  }

  #acc = 0;
  update(dt, ctx) {
    if (!this.inGame) return;
    const net = ctx.get('net'), human = ctx.get('human');
    this.grabTip.style.display = (human.grabL || human.grabR) ? 'block' : 'none';
    this.#acc += dt;
    if (this.#acc > 1) {
      this.#acc = 0;
      const rows = [`🙂 <b>${escapeHtml(human.nickname)}</b> (나) 🏆${human.wins}`];
      for (const r of net.remotes()) rows.push(`🙂 ${escapeHtml(r.name)}`);
      this.players.innerHTML = `👥 ${net.playerCount()}명<br/>` + rows.join('<br/>');
    }
  }
}

function genCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
