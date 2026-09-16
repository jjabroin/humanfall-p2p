import { EV } from '../core/events.js';

// DOM 오버레이: 메뉴(닉네임/방코드) + HUD(방코드/플레이어/토스트).
export class UISystem {
  async init(ctx) {
    this.ctx = ctx;
    const $ = (id) => document.getElementById(id);
    this.menu = $('menu'); this.hud = $('hud');
    this.roomCode = $('roomCode'); this.players = $('players');
    this.toastBox = $('toast'); this.grabTip = $('grabTip');
    this.lockTip = $('lockTip'); this.goalPill = $('goalPill');
    this.handsBox = $('hands');

    const nick = $('nick'), code = $('code');
    nick.value = localStorage.getItem('hfall_nick') ?? '';
    const savedCode = localStorage.getItem('hfall_code');
    if (savedCode) code.value = savedCode;

    // 카톡/인스타 등 인앱브라우저는 WebRTC가 막혀 P2P 불가 → 경고
    const ua = navigator.userAgent;
    if (/KAKAOTALK|Instagram|FBAN|FBAV|Line\/|NAVER|wv\)|; wv/.test(ua)) {
      $('inappWarn').style.display = 'block';
    }

    $('btnCreate').onclick = () => {
      this.#join(genCode(), nick.value || '말랑이', true);
    };
    $('btnJoin').onclick = () => {
      const c = (code.value || '').trim().toUpperCase();
      if (c.length < 4) { this.toast('방 코드를 4~6자로 입력하세요!'); return; }
      this.#join(c, nick.value || '말랑이', false);
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
    ctx.events.on(EV.CHECKPOINT, ({ index }) => {
      this.toast(`🚩 체크포인트 ${index + 1}! 여기서 부활합니다`);
    });
    ctx.events.on(EV.GRABBED, ({ by }) => {
      this.toast(`🤏 ${by}에게 붙잡혔다! 흔들어 뿌리치세요!`);
    });
    ctx.events.on(EV.PEER_JOIN, ({ name }) => this.toast(`👋 ${name} 참가! 연결됨 ✅`));
    ctx.events.on(EV.PEER_LEAVE, ({ name }) => this.toast(`🚪 ${name} 퇴장`));
    ctx.events.on('input:pointerlock', (locked) => {
      this.lockTip.style.display = (!locked && this.inGame && !ctx.input.isTouch) ? 'flex' : 'none';
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.inGame) {
        // 포인터락 해제는 브라우저가 처리, 메뉴는 다시 열지 않음
      }
    });
  }

  #join(code, name, isCreate) {
    const net = this.ctx.get('net');
    localStorage.setItem('hfall_nick', name);
    localStorage.setItem('hfall_code', code);
    try {
      net.connect(code, name);
      this.#enter(code);
      this.toast(isCreate
        ? `🎉 방 ${code} 생성! 친구에게 코드를 공유하세요 📤`
        : `🚪 방 ${code} 입장! 친구를 기다리는 중...`);
    } catch (err) {
      console.error(err);
      this.toast('이 브라우저는 P2P를 지원하지 않아 혼자 놀기로 시작합니다 😢');
      this.#enter(null);
    }
  }

  #enter(code) {
    this.inGame = true;
    this.menu.classList.add('hidden');
    this.hud.classList.add('visible');
    this.roomCode.textContent = code ?? 'SOLO';
    if (this.ctx.input.isTouch) {
      document.getElementById('hint').textContent = '왼쪽 스틱 이동(끝까지=달리기) · 오른쪽 드래그 시점 · 🤏 잡기 · ⬆️ 점프';
    } else {
      this.ctx.canvas.requestPointerLock?.();
    }
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
  #goalAcc = 0;
  #diagShown = false;
  #handAcc = 0;
  update(dt, ctx) {
    if (!this.inGame) return;
    const net = ctx.get('net'), human = ctx.get('human');
    this.grabTip.style.display = (human.grabL || human.grabR) ? 'block' : 'none';
    this.#acc += dt;
    if (this.#acc > 1) {
      this.#acc = 0;
      const rows = [`🙂 <b>${escapeHtml(human.nickname)}</b> (나) 🏆${human.wins}`];
      for (const r of net.remotes()) rows.push(`🙂 ${escapeHtml(r.name)}`);
      const waiting = net.online && net.peers.size === 0 ? '<br/>📡 친구 접속 대기 중...' : '';
      this.players.innerHTML = `👥 ${net.playerCount()}명<br/>` + rows.join('<br/>') + waiting;
    }
    this.#goalAcc = (this.#goalAcc ?? 0) + dt;
    if (this.#goalAcc > 0.25) {
      this.#goalAcc = 0;
      const d = human.pos.distanceTo(ctx.get('world').goal);
      this.goalPill.textContent = d < 3 ? '🥅 거의 다 왔다!' : `🥅 ${Math.round(d)}m`;
    }
    // 잡은 손 표시 (토글 상태가 보이게)
    this.#handAcc += dt;
    if (this.#handAcc > 0.2 && this.handsBox) {
      this.#handAcc = 0;
      const handName = (g) => !g ? '–' : g.kind === 'prop' ? '📦' : g.kind === 'player' ? '🙂' : '🧗';
      const lOn = human.grabL ? 'on' : '', rOn = human.grabR ? 'on' : '';
      this.handsBox.innerHTML =
        `<span class="${lOn}">🤏L ${handName(human.grabL)}</span> ` +
        `<span class="${rOn}">R🤏 ${handName(human.grabR)}</span>`;
    }
    // 30초 넘게 혼자면 연결 진단 힌트 (1회)
    if (!this.#diagShown && net.online && net.peers.size === 0 && performance.now() - net.joinedAt > 30000) {
      this.#diagShown = true;
      this.toast('연결이 안 되면: ① 방 코드 확인 ② 카톡 인앱 말고 Safari/Chrome ③ 같은 와이파이 권장');
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
