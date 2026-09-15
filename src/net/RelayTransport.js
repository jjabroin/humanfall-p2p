import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

// WebRTC가 안 터지는 네트워크(대칭형 NAT 등)용 폴백: 공개 Nostr 릴레이를
// 게임 상태 중계기로 직접 사용. 8Hz 상태 + 골인 이벤트만 주고받는다.
// (서명 필수 — 릴레이가 무서명 이벤트를 거부하므로 noble로 schnorr 서명)
const KIND = 27911;
const TAG = 'r';

export class RelayTransport {
  peerKey = null;   // 내 공개키 앞 12자리 (중계 피어 ID 재료)
  #sk = null;
  #pk = null;
  #sockets = new Map(); // url -> { ws, open }
  #roomTag = '';
  #subId = '';
  #onData = null;
  #closed = false;
  #outbox = []; // 소켓 열리기 전 메시지 보관 (소유권 선언 유실 방지)

  constructor(roomTag) {
    this.#roomTag = roomTag;
    this.#sk = generateSecretKey();
    this.#pk = getPublicKey(this.#sk);
    this.peerKey = this.#pk.slice(0, 12);
    this.#subId = 'hf' + Math.random().toString(36).slice(2, 10);
  }

  get openCount() {
    let n = 0;
    for (const s of this.#sockets.values()) if (s.open) n++;
    return n;
  }

  connect(urls, onData) {
    this.#onData = onData;
    for (const url of urls) this.#dial(url);
  }

  #dial(url) {
    if (this.#closed) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return this.#retry(url); }
    const rec = { ws, open: false };
    this.#sockets.set(url, rec);
    ws.onopen = () => {
      rec.open = true;
      ws.send(JSON.stringify(['REQ', this.#subId, {
        kinds: [KIND],
        [`#${TAG}`]: [this.#roomTag],
        since: Math.floor(Date.now() / 1000) - 5,
      }]));
      this.#flush();
    };
    ws.onmessage = (e) => this.#handle(String(e.data));
    ws.onclose = () => { rec.open = false; this.#retry(url); };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  #retry(url) {
    if (this.#closed) return;
    setTimeout(() => this.#dial(url), 4000);
  }

  #handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
    const ev = msg[2];
    if (!ev || ev.kind !== KIND || ev.pubkey === this.#pk) return;
    const tag = ev.tags?.find?.((t) => t[0] === TAG)?.[1];
    if (tag !== this.#roomTag) return;
    try { this.#onData?.(ev.pubkey, JSON.parse(ev.content)); } catch { /* noop */ }
  }

  async send(obj) {
    if (this.#closed) return;
    const ev = await this.#sign(JSON.stringify(obj));
    if (!ev || this.#closed) return;
    const wire = JSON.stringify(['EVENT', ev]);
    let sent = false;
    for (const s of this.#sockets.values()) {
      if (s.open) { try { s.ws.send(wire); sent = true; } catch { /* noop */ } }
    }
    // 열린 소켓이 없으면 보관 후 첫 연결 시 발송 (낡은 상태 메시지는 버림)
    if (!sent) {
      this.#outbox.push({ wire, t: Date.now(), k: obj.k });
      if (this.#outbox.length > 30) this.#outbox.shift();
    }
  }

  #flush() {
    if (this.#outbox.length === 0) return;
    const now = Date.now();
    for (const m of this.#outbox) {
      if (m.k === 'st' && now - m.t > 2000) continue;
      for (const s of this.#sockets.values()) {
        if (s.open) { try { s.ws.send(m.wire); } catch { /* noop */ } break;
        }
      }
    }
    this.#outbox.length = 0;
  }

  async #sign(content) {
    try {
      return finalizeEvent({
        kind: KIND,
        tags: [[TAG, this.#roomTag]],
        content,
        created_at: Math.floor(Date.now() / 1000),
      }, this.#sk);
    } catch { return null; }
  }

  close() {
    this.#closed = true;
    for (const s of this.#sockets.values()) { try { s.ws.close(); } catch { /* noop */ } }
    this.#sockets.clear();
  }
}
