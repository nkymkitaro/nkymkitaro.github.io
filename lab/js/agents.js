// agents.js: 親機・子機それぞれの「裏で動画を録り続ける」係。試作用。
// - LocalCapture: 自分のカメラ1台を録画して、1分ごとの区切りとして保存する(方式AとBの切り替え、止まったときの検知、容量の見張り)
// - ChildAgent: 子機。親機の合図で録画を始め/終え、区切りを親機へ送る(つながらない間は溜め、つながったら送り直す)
// - ParentAgent: 親機。録画の開始・終了を決め、子機の様子を集め、区切りを受け取る
// 通信は子機が親機へ張る専用の1本(conn)だけを使う。conn は PeerJS の DataConnection と同じ形(send / on('data') / open)

import { RecorderA, probeA } from './recorder-a.js';
import { RecorderB, probeB } from './recorder-b.js';
import { SegmentSender, SegmentReceiver } from './transfer.js';

export const DEFAULTS = { segSec: 60, maxSec: 600, minFreeMB: 200 };
const STATUS_EVERY_MS = 2000;
const PING_EVERY_MS = 10000;
const FLUSH_EVERY_MS = 3000;
const STORAGE_EVERY_MS = 10000;

export async function batteryPercent() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return Math.round(b.level * 100);
  } catch (err) { return null; }
}

export async function probeMethods() {
  return { A: probeA(), B: await probeB() };
}

// ---------------------------------------------------------------------------
export class LocalCapture {
  constructor({ camKey, label, store, getStream, offsetMs = () => 0, sentInit = 0, onSegment, onAlarm, onChange, now = () => Date.now() }) {
    this.camKey = camKey;
    this.label = label;
    this.store = store;
    this.getStream = getStream;
    this.offsetMs = offsetMs;
    this.sentInit = sentInit;
    this.onSegment = onSegment || (() => {});
    this.onAlarm = onAlarm || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.recorder = null;
    this._watch = null;
    this._autoStop = null;
    this.status = this._blank();
  }

  _blank() {
    return {
      recording: false, take: '', method: '', requested: '', fellBack: false, segSec: 0, segs: 0, bytes: 0,
      startedAt: 0, lastSegAt: 0, maxGapMs: 0, maxSegMs: 0, errors: [], dropped: 0, alarm: '', stoppedAt: 0,
    };
  }

  get recording() { return this.status.recording; }

  async start({ take, method = 'A', segSec = DEFAULTS.segSec, maxSec = DEFAULTS.maxSec }) {
    if (this.status.recording) return true;
    const stream = this.getStream();
    if (!stream || !stream.getVideoTracks().length) { this._alarm('カメラの映像がありません。録画を始められませんでした'); return false; }
    this.status = this._blank();
    Object.assign(this.status, { take, requested: method, segSec });
    let useB = method === 'B';
    if (useB) {
      const p = await probeB();
      if (!p.ok) { useB = false; this.status.fellBack = true; this.status.errors.push(`方式Bが使えないため方式Aで録画(${p.reason})`); }
    }
    const common = {
      segMs: segSec * 1000,
      now: this.now,
      onSegment: (seg) => this._onSegment(seg),
      onError: (msg) => this._error(msg),
    };
    try {
      this.recorder = useB ? new RecorderB(stream, common) : new RecorderA(stream, common);
      await this.recorder.start();
    } catch (err) {
      this.recorder = null;
      this._alarm(`録画を始められませんでした(${err && err.message ? err.message : err})`);
      return false;
    }
    this.status.method = useB ? 'B' : 'A';
    this.status.recording = true;
    this.status.startedAt = this.now();
    this._trackEnded = () => { if (this.status.recording && !this.status.alarm) this._alarm('カメラの映像が止まりました。録画が止まっています'); };
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', this._trackEnded));
    this._stream = stream;
    // 区切りが予定より大きく遅れたら、止まっているとみなす
    this._watch = setInterval(() => {
      if (!this.status.recording || this.status.alarm) return; // 警報は1回だけ(鳴り続けない)
      const last = Math.max(this.status.startedAt, this.status.lastSegAt);
      if (this.now() - last > segSec * 1000 * 1.6 + 6000) this._alarm('録画が止まっているようです(区切りが保存されていません)');
    }, 2000);
    // 親機の「終わり」が届かなくても止まるように(想定の長さ+15秒)
    this._autoStop = setTimeout(() => { if (this.status.recording) { this._error(`最長${Math.round(maxSec / 60)}分に達したため録画を止めました`); this.stop(); } }, (maxSec + 15) * 1000);
    this.onChange();
    return true;
  }

  async _onSegment(seg) {
    this._pending = (this._pending || 0) + 1;
    try { await this._saveSegment(seg); } finally { this._pending--; }
  }

  async _saveSegment(seg) {
    const st = this.status;
    const t0 = seg.t0 + this.offsetMs();
    const prevEnd = st._prevEnd;
    if (prevEnd != null) st.maxGapMs = Math.max(st.maxGapMs, Math.round(t0 - prevEnd));
    st._prevEnd = t0 + seg.durMs;
    const rec = {
      key: `${st.take}|${this.camKey}|${seg.seq}`, take: st.take, cam: this.camKey, label: this.label, seq: seg.seq,
      method: st.method, mime: seg.mime, t0: Math.round(t0), t0Local: seg.t0, durMs: seg.durMs, fps: seg.fps,
      size: seg.blob.size, meta: seg.meta || null, sent: this.sentInit, origin: 'own', blob: seg.blob,
    };
    try {
      await this.store.put(rec);
    } catch (err) {
      this._alarm(`保存できませんでした(${err && err.message ? err.message : err})。空き容量を確認してください`);
      return;
    }
    st.segs++;
    st.bytes += rec.size;
    st.lastSegAt = this.now();
    st.maxSegMs = Math.max(st.maxSegMs, seg.durMs);
    if (this.recorder && this.recorder.dropped != null) st.dropped = this.recorder.dropped;
    this.onSegment(rec);
    this.onChange();
  }

  _error(msg) { this.status.errors.push(msg); this.onChange(); }

  _alarm(msg) {
    this.status.alarm = msg;
    this.status.errors.push(msg);
    this.onAlarm(msg);
    this.onChange();
  }

  async stop() {
    clearInterval(this._watch);
    clearTimeout(this._autoStop);
    if (this._stream && this._trackEnded) this._stream.getVideoTracks().forEach((t) => t.removeEventListener('ended', this._trackEnded));
    const rec = this.recorder;
    this.recorder = null;
    if (rec) await rec.stop();
    // 最後の区切りの保存が終わるのを待つ
    if (this.status.recording) {
      for (let i = 0; i < 50 && this._pendingWrites(); i++) await new Promise((r) => setTimeout(r, 40));
    }
    this.status.recording = false;
    this.status.stoppedAt = this.now();
    this.onChange();
  }

  _pendingWrites() { return (this._pending || 0) > 0; }
}

// ---------------------------------------------------------------------------
export class ChildAgent {
  constructor({ camKey, label, store, getStream, getConn, log = () => {}, onAlarm, onChange, now = () => Date.now() }) {
    this.camKey = camKey;
    this.label = label;
    this.store = store;
    this.getConn = getConn;
    this.log = log;
    this.onAlarm = onAlarm || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.offset = 0; // 親機の時計 − 自分の時計(ミリ秒)
    this.rtt = null;
    this.bestRtt = Infinity;
    this.offsetSamples = 0;
    this.free = null;
    this.sender = new SegmentSender({ store, getConn: () => this._conn(), onProgress: () => this.onChange(), log });
    this.capture = new LocalCapture({
      camKey, label, store, getStream, now, sentInit: 0,
      offsetMs: () => this.offset,
      onSegment: () => this.sender.flush(),
      onAlarm: (msg) => { this._send({ op: 'ALARM', cam: this.camKey, msg }); this.onAlarm(msg); },
      onChange: () => this.onChange(),
    });
    this._lastStatus = 0; this._lastPing = 0; this._lastFlush = 0; this._lastStorage = 0;
    this.takeInfo = null;
  }

  _conn() { const c = this.getConn(); return c && c.open ? c : null; }
  _send(msg) { const c = this._conn(); if (!c) return false; try { c.send({ k: 'LAB', ...msg }); return true; } catch (err) { return false; } }

  setLabel(label) { this.label = label; this.capture.label = label; }

  onConnOpen() {
    this._send({ op: 'HELLO', cam: this.camKey, label: this.label, recording: this.capture.recording, take: this.capture.status.take });
    this._lastPing = 0; this.pingBurst = 3;
    this.sender.flush();
  }

  async handleMessage(msg) {
    if (!msg || msg.k !== 'LAB') return;
    if (msg.op === 'REC-START') {
      if (this._starting || (this.capture.recording && this.capture.status.take === msg.take)) return;
      this.takeInfo = { take: msg.take, segSec: msg.segSec };
      this._starting = true;
      let ok;
      try { ok = await this.capture.start({ take: msg.take, method: msg.method, segSec: msg.segSec, maxSec: msg.maxSec }); } finally { this._starting = false; }
      this.bat0 = await batteryPercent();
      this.sendStatus();
      if (!ok) this._send({ op: 'ALARM', cam: this.camKey, msg: this.capture.status.alarm });
    } else if (msg.op === 'REC-STOP') {
      await this.stopRecording(msg.reason);
    } else if (msg.op === 'PONG') {
      const t2 = this.now();
      const rtt = t2 - msg.t1;
      this.rtt = rtt;
      if (rtt <= this.bestRtt + 5) { // 往復がいちばん短かった測定を採る(行きと帰りの差が小さいため)
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.offset = Math.round(msg.tp + rtt / 2 - t2);
      }
      this.offsetSamples++;
      this.onChange();
    } else if (msg.op === 'SEG-ACK' || msg.op === 'SEG-NAK') {
      this.sender.handleReply(msg);
    }
  }

  async stopRecording(reason) {
    const st = this.capture.status;
    await this.capture.stop();
    this._send({ op: 'STOPPED', cam: this.camKey, take: st.take, segs: st.segs, reason: reason || '' });
    this.sendStatus();
    this.sender.flush();
  }

  sendStatus() {
    const st = this.capture.status;
    this._lastStatus = this.now();
    this.sender.unsentCount().then((unsent) => {
      this._send({
        op: 'STATUS', cam: this.camKey, label: this.label,
        rec: { recording: st.recording, take: st.take, method: st.method, requested: st.requested, fellBack: st.fellBack, segs: st.segs, bytes: st.bytes, maxGapMs: st.maxGapMs, dropped: st.dropped, errors: st.errors.slice(-3), alarm: st.alarm },
        unsent, rtt: this.rtt, offset: this.offset, free: this.free, send: this.sender.stats,
      });
    });
  }

  // 1秒ごとに呼ぶ
  async tick() {
    const t = this.now();
    if (this._conn()) {
      if (t - this._lastPing > (this.pingBurst > 0 ? 700 : PING_EVERY_MS)) {
        this._lastPing = t;
        if (this.pingBurst > 0) this.pingBurst--;
        this._send({ op: 'PING', t1: t });
      }
      if (t - this._lastStatus > STATUS_EVERY_MS) this.sendStatus();
      if (t - this._lastFlush > FLUSH_EVERY_MS) { this._lastFlush = t; this.sender.flush(); }
    }
    if (t - this._lastStorage > STORAGE_EVERY_MS) {
      this._lastStorage = t;
      const u = await this.store.usage();
      this.free = u ? Math.round(u.freeMB) : null;
      if (u && this.capture.recording && u.freeMB < DEFAULTS.minFreeMB) {
        const msg = `空き容量が少ないため(あと約${Math.round(u.freeMB)}MB)、録画を止めました`;
        this.onAlarm(msg);
        this._send({ op: 'ALARM', cam: this.camKey, msg });
        await this.stopRecording('low-storage');
      }
      this.onChange();
    }
  }
}

// ---------------------------------------------------------------------------
export class ParentAgent {
  constructor({ store, capture, log = () => {}, onAlarm, onChange, now = () => Date.now() }) {
    this.store = store;
    this.capture = capture; // 親機自身のカメラ
    this.log = log;
    this.onAlarm = onAlarm || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.children = new Map(); // camKey -> { conn, label, connected, status, recv, expected, ... }
    this.take = null; // { id, startedAt, stoppedAt, method, segSec, maxSec, collectedAt }
    this.receiver = new SegmentReceiver({ store, log, onReceived: (rec) => this._onReceived(rec) });
    this._lastStorage = 0;
  }

  _child(camKey) {
    if (!this.children.has(camKey)) {
      this.children.set(camKey, { camKey, conn: null, label: camKey, connected: false, status: null, recv: 0, recvBytes: 0, lastRecvAt: 0, expected: null, alarms: [], stopped: false });
    }
    return this.children.get(camKey);
  }

  // 子機が張ってきた通信路を受け入れる
  attachConn(conn) {
    conn.on('data', (msg) => this.handleMessage(conn, msg));
    conn.on('close', () => {
      for (const c of this.children.values()) if (c.conn === conn) { c.connected = false; c.conn = null; }
      this.onChange();
    });
  }

  async handleMessage(conn, msg) {
    if (!msg || msg.k !== 'LAB') return;
    if (msg.op === 'HELLO') {
      const c = this._child(msg.cam);
      c.conn = conn; c.connected = true; c.label = msg.label || c.label; c.lastSeen = this.now();
      this._syncChild(c, msg.recording, msg.take);
    } else if (msg.op === 'PING') {
      try { conn.send({ k: 'LAB', op: 'PONG', t1: msg.t1, tp: this.now() }); } catch (err) { /* 次回 */ }
    } else if (msg.op === 'STATUS') {
      const c = this._child(msg.cam);
      c.conn = conn; c.connected = true; c.label = msg.label || c.label; c.status = msg; c.lastSeen = this.now();
      this._syncChild(c, msg.rec.recording, msg.rec.take);
    } else if (msg.op === 'ALARM') {
      const c = this._child(msg.cam);
      c.alarms.push(msg.msg);
      this.onAlarm(`${c.label}: ${msg.msg}`);
    } else if (msg.op === 'STOPPED') {
      const c = this._child(msg.cam);
      if (this.take && msg.take === this.take.id) { c.expected = msg.segs; c.stopped = true; this._checkCollected(); }
    } else if (String(msg.op).startsWith('SEG-')) {
      const c = [...this.children.values()].find((x) => x.conn === conn);
      if (c) c.conn = conn;
      await this.receiver.handle(conn, msg);
    }
    this.onChange();
  }

  // 録画中なのに子機が録画していない(あとから参加した・つなぎ直した)ときは、合図を送り直す
  _syncChild(c, recording, take) {
    if (!this.take || this.take.stoppedAt) return;
    if (!recording || take !== this.take.id) this._sendStart(c);
  }

  _sendStart(c) {
    if (!c.conn || !this.take) return;
    try { c.conn.send({ k: 'LAB', op: 'REC-START', take: this.take.id, method: this.take.method, segSec: this.take.segSec, maxSec: this.take.maxSec }); } catch (err) { /* 次回 */ }
  }

  _onReceived(rec) {
    const c = this._child(rec.cam);
    c.recv++; c.recvBytes += rec.size; c.lastRecvAt = this.now();
    this._checkCollected();
    this.onChange();
  }

  async startTake({ method = 'A', segSec = DEFAULTS.segSec, maxSec = DEFAULTS.maxSec } = {}) {
    if (this.take && !this.take.stoppedAt) return false;
    const id = String(this.now());
    this.take = { id, startedAt: this.now(), stoppedAt: 0, method, segSec, maxSec, collectedAt: 0, bat0: await batteryPercent(), bat1: null };
    for (const c of this.children.values()) { c.recv = 0; c.recvBytes = 0; c.expected = null; c.stopped = false; c.lastRecvAt = 0; c.alarms = []; this._sendStart(c); }
    const ok = await this.capture.start({ take: id, method, segSec, maxSec });
    await this._saveTake();
    this.onChange();
    return ok;
  }

  async stopTake(reason = '') {
    const take = this.take;
    if (!take || take.stoppedAt) return;
    take.stoppedAt = this.now();
    take.stopReason = reason;
    for (const c of this.children.values()) {
      if (c.conn) { try { c.conn.send({ k: 'LAB', op: 'REC-STOP', take: take.id, reason }); } catch (err) { /* 切れている */ } }
    }
    await this.capture.stop();
    take.bat1 = await batteryPercent();
    await this._saveTake();
    this._checkCollected();
    this.onChange();
  }

  // 「終わり」を押してから、全カメラの区切りがそろうまでの時間を測る
  _checkCollected() {
    const take = this.take;
    if (!take || !take.stoppedAt || take.collectedAt) return;
    const live = [...this.children.values()].filter((c) => c.connected || c.stopped);
    const allIn = live.every((c) => c.stopped && c.expected != null && c.recv >= c.expected);
    if (allIn && !this.capture.recording) {
      take.collectedAt = this.now();
      this._saveTake();
    }
  }

  async _saveTake() {
    const t = this.take;
    if (!t) return;
    const cams = {};
    cams[this.capture.camKey] = this.capture.label;
    for (const c of this.children.values()) cams[c.camKey] = c.label;
    await this.store.putTake({ ...t, cams, ownSegs: this.capture.status.segs });
  }

  // 親機の見張り(1秒ごと)
  async tick() {
    const t = this.now();
    if (this.take && !this.take.stoppedAt) {
      if (t - this.take.startedAt >= this.take.maxSec * 1000) { this.onAlarm(`最長${Math.round(this.take.maxSec / 60)}分に達したため、録画を終わりました`); await this.stopTake('max'); return; }
      if (!this.capture.recording && this.capture.status.alarm) { /* 親機自身の録画が止まった。知らせは出済み */ }
    }
    if (t - this._lastStorage > STORAGE_EVERY_MS) {
      this._lastStorage = t;
      const u = await this.store.usage();
      this.free = u ? Math.round(u.freeMB) : null;
      if (u && this.take && !this.take.stoppedAt && u.freeMB < DEFAULTS.minFreeMB) {
        this.onAlarm(`空き容量が少ないため(あと約${Math.round(u.freeMB)}MB)、録画を終わりました`);
        await this.stopTake('low-storage');
      }
      this.onChange();
    }
  }

  // 結果の一覧(画面に出す・数値をコピーするための材料)
  summary() {
    const take = this.take;
    const rows = [];
    const own = this.capture.status;
    rows.push({ cam: this.capture.camKey, label: this.capture.label, role: '親機', segs: own.segs, expected: own.segs, mb: own.bytes / 1048576, maxGapMs: own.maxGapMs, method: own.method, errors: own.errors, alarm: own.alarm, rtt: 0, offset: 0, dropped: own.dropped });
    for (const c of this.children.values()) {
      const s = c.status;
      rows.push({
        cam: c.camKey, label: c.label, role: '子機', connected: c.connected, segs: c.recv, expected: c.expected, mb: c.recvBytes / 1048576,
        maxGapMs: s ? s.rec.maxGapMs : null, method: s ? s.rec.method : '', errors: s ? s.rec.errors : [], alarm: (c.alarms.slice(-1)[0]) || (s && s.rec.alarm) || '',
        rtt: s ? s.rtt : null, offset: s ? s.offset : null, unsent: s ? s.unsent : null, dropped: s ? s.rec.dropped : null, sendMs: s ? s.send.lastSendMs : null, free: s ? s.free : null,
      });
    }
    return {
      take: take ? { ...take, collectMs: take.collectedAt && take.stoppedAt ? take.collectedAt - take.stoppedAt : null } : null,
      rows,
    };
  }
}
