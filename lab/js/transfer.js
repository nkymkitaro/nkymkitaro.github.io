// transfer.js: 区切り(セグメント)を、子機から親機へ送って受け取る部品。試作用。
// - 1つのセグメントを小分け(既定48KB)にして送り、親機が全部そろったと確かめてから「受け取った」を返す
// - 「受け取った」が返るまで、子機は送信済みにしない。つながっていない間は溜めておき、つながったら未送信分を古い順に送り直す
// - 回線の詰まり(backpressure)を見て送る速さを調整する
// 通信路(conn)は PeerJS の DataConnection と同じ形: send(obj) / on('data', fn) / open

export const CHUNK_BYTES = 48 * 1024;
const BUFFER_LIMIT = 1024 * 1024;
const ACK_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SegmentSender {
  // getConn: () => 開いている通信路 または null
  constructor({ store, getConn, onProgress, log = () => {} }) {
    this.store = store;
    this.getConn = getConn;
    this.onProgress = onProgress || (() => {});
    this.log = log;
    this.busy = false;
    this.paused = new Set(); // 送るのを止めている録画(見ている端末が受信を中止したもの)
    this._acks = new Map(); // id -> resolve
    this.stats = { sent: 0, failed: 0, lastSendMs: 0, maxSendMs: 0, totalBytes: 0 };
  }

  // 親機からの「受け取った/受け取れなかった」
  handleReply(msg) {
    const waiter = this._acks.get(msg.id);
    if (waiter) { this._acks.delete(msg.id); waiter(msg.op === 'SEG-ACK'); }
  }

  async unsentCount() { return (await this.store.listUnsent()).length; }

  // 未送信を古い順に送る。つながっていなければ何もしない(あとでまた呼ぶ)
  async flush() {
    if (this.busy) { this._again = true; return; } // 送っている間に新しい区切りができたら、終わりしだい続けて送る
    this.busy = true;
    try {
      const list = (await this.store.listUnsent()).filter((r) => !this.paused.has(r.take)).sort((a, b) => a.t0 - b.t0);
      for (const rec of list) {
        const conn = this.getConn();
        if (!conn || !conn.open) break;
        const ok = await this._sendOne(conn, rec);
        if (!ok) { this.stats.failed++; this.stats.reasons = this.stats.reasons || {}; this.stats.reasons[this.stats.lastFail] = (this.stats.reasons[this.stats.lastFail] || 0) + 1; break; }
        await this.store.markSent(rec.key);
        this.onProgress(rec);
      }
    } finally {
      this.busy = false;
    }
    if (this._again) { this._again = false; await this.flush(); }
  }

  async _sendOne(conn, rec) {
    const started = performance.now();
    const buf = await rec.blob.arrayBuffer();
    const id = rec.key;
    const total = Math.max(1, Math.ceil(buf.byteLength / CHUNK_BYTES));
    const head = {
      k: 'LAB', op: 'SEG-HEAD', id, take: rec.take, cam: rec.cam, label: rec.label, seq: rec.seq, method: rec.method,
      mime: rec.mime, t0: rec.t0, durMs: rec.durMs, fps: rec.fps, size: buf.byteLength, parts: total, meta: rec.meta || null,
    };
    let watch = null;
    const replied = new Promise((resolve) => {
      this._acks.set(id, (v) => { this.stats.lastFail = v ? '' : 'nak'; resolve(v); });
      const timeout = setTimeout(() => { if (this._acks.delete(id)) { this.stats.lastFail = 'timeout'; resolve(false); } }, ACK_TIMEOUT_MS);
      // 返事を待つ間に回線が切れたら、すぐ諦めて、つながり直したあとに送り直す
      watch = setInterval(() => {
        if (!conn.open && this._acks.delete(id)) { this.stats.lastFail = 'closed'; clearTimeout(timeout); resolve(false); }
      }, 200);
    });
    try {
      conn.send(head);
      for (let i = 0; i < total; i++) {
        while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_LIMIT) await sleep(20);
        if (!conn.open) { this._acks.delete(id); clearInterval(watch); this.stats.lastFail = 'closed'; return false; }
        conn.send({ k: 'LAB', op: 'SEG-PART', id, i, data: buf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
      }
      conn.send({ k: 'LAB', op: 'SEG-END', id });
    } catch (err) {
      this._acks.delete(id);
      clearInterval(watch);
      this.stats.lastFail = 'throw';
      return false;
    }
    const ok = await replied;
    clearInterval(watch);
    const ms = Math.round(performance.now() - started);
    if (ok) {
      this.stats.sent++;
      this.stats.lastSendMs = ms;
      this.stats.maxSendMs = Math.max(this.stats.maxSendMs, ms);
      this.stats.totalBytes += buf.byteLength;
    }
    return ok;
  }
}

// 親機側: 子機から来たセグメントを組み立てて保存し、「受け取った」を返す
export class SegmentReceiver {
  constructor({ store, onReceived, log = () => {} }) {
    this.store = store;
    this.onReceived = onReceived || (() => {});
    this.log = log;
    this._incoming = new Map(); // id -> { head, parts: [], got }
  }

  // 届いた順に1つずつ処理する(保存の確認で待つ間に、次の小分けが先に処理されないように)
  handle(conn, msg) {
    this._queue = (this._queue || Promise.resolve()).then(() => this._handle(conn, msg)).catch((err) => this.log(`受信でエラー: ${err && err.message ? err.message : err}`));
    return this._queue;
  }

  async _handle(conn, msg) {
    if (msg.op === 'SEG-HEAD') {
      if (await this.store.has(msg.id)) {
        // すでに持っている(再送)。中身は受け直さず、受け取ったことだけ返す
        this._incoming.set(msg.id, { head: msg, skip: true });
        return;
      }
      this._incoming.set(msg.id, { head: msg, parts: new Array(msg.parts), got: 0 });
    } else if (msg.op === 'SEG-PART') {
      const inc = this._incoming.get(msg.id);
      if (!inc || inc.skip) return;
      if (!inc.parts[msg.i]) { inc.parts[msg.i] = msg.data; inc.got++; }
    } else if (msg.op === 'SEG-END') {
      const inc = this._incoming.get(msg.id);
      this._incoming.delete(msg.id);
      if (!inc) { this._reply(conn, 'SEG-NAK', msg.id); return; }
      if (inc.skip) { this._reply(conn, 'SEG-ACK', msg.id); return; }
      const blob = new Blob(inc.parts.filter(Boolean), { type: inc.head.mime });
      if (inc.got !== inc.head.parts || blob.size !== inc.head.size) {
        this.log(`セグメントが欠けて届きました(${inc.got}/${inc.head.parts})`);
        this._reply(conn, 'SEG-NAK', msg.id);
        return;
      }
      const h = inc.head;
      const rec = {
        key: h.id, take: h.take, cam: h.cam, label: h.label, seq: h.seq, method: h.method, mime: h.mime,
        t0: h.t0, durMs: h.durMs, fps: h.fps, size: h.size, meta: h.meta, sent: 1, origin: 'recv', receivedAt: Date.now(), blob,
      };
      await this.store.put(rec);
      this._reply(conn, 'SEG-ACK', msg.id);
      this.onReceived(rec);
    }
  }

  _reply(conn, op, id) {
    try { conn.send({ k: 'LAB', op, id }); } catch (err) { this.log('返事を送れませんでした'); }
  }
}
