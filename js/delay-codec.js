// delay-codec.js: 「遅れて映す」(ディレイ)用の、端末の動画専用の部品(WebCodecs)で圧縮・戻す仕組み。
// 2026-11-03、中山さんの案。写真(JPEG)を1コマずつ作る方式は、「最大」で重く・熱くなるため、ディレイだけこちらにする。
// - 各カメラの映像を、H.264で圧縮して、新しい順に持つ(1秒ごとに全体を保存するコマを入れる)
// - 見せるときは、いちばん古い全体コマから順に戻して、「いま − N秒」のコマを出す(ディレイは前にしか進まないので、順に戻せば足りる)
// - 使えない端末・途中で失敗したときは、player 側が今までの写真方式に戻る(failed が true になる)
// - VARは使わない(VARは写真方式のまま)。ディレイ中は写真をためないので、CPUと熱が減る
import { diagSet, diagAdd, diagTime } from './diag.js';

const CODECS = ['avc1.42001f', 'avc1.420028', 'avc1.42002a', 'vp09.00.10.08']; // 小さい映像から大きい映像の順
const FPS = 30;
const KEY_MS = 1000;     // 全体を保存するコマの間隔
const FEED_AHEAD_MS = 150;
const MAX_ENC_QUEUE = 4; // 圧縮が追いつかないときは、このコマを飛ばす

export function delayCodecSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof VideoFrame !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const bitrateFor = (w, h) => Math.max(500000, Math.round(w * h * FPS * 0.08));

async function pickCodec(w, h) {
  for (const codec of CODECS) {
    const cfg = { codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: FPS, latencyMode: 'realtime' };
    if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return codec;
    } catch (err) { /* 次へ */ }
  }
  return null;
}

class Channel {
  constructor(owner) {
    this.owner = owner;
    this.chunks = [];     // [{ seq, ts(ms), key, chunk }]
    this.baseSeq = 0;
    this.nextSeq = 0;     // 次に戻す(デコードする)チャンクの番号
    this.enc = null;
    this.dec = null;
    this.decCfg = null;
    this.out = [];        // 戻したコマ(VideoFrame)。ts 順
    this.lastKey = -1e9;
    this.lastVT = -1;
    this.src = null;      // 取り込み元の大きさ "WxH"
    this.lastGood = performance.now();
  }

  capture(video, now) {
    if (!video || !video.videoWidth || video.readyState < 2) return;
    if (video.currentTime === this.lastVT) return; // 新しいコマが来ていない
    this.lastVT = video.currentTime;
    const srcKey = `${video.videoWidth}x${video.videoHeight}`;
    if (this.src !== srcKey) this._initEncoder(video, srcKey);
    if (!this.enc || this.enc.state !== 'configured') return;
    if (this.enc.encodeQueueSize > MAX_ENC_QUEUE) { diagAdd('ディレイの圧縮を飛ばした回数'); return; }
    const key = now - this.lastKey >= KEY_MS;
    if (key) this.lastKey = now;
    const vf = new VideoFrame(video, { timestamp: Math.round(now * 1000) });
    try { this.enc.encode(vf, key ? { keyFrame: true } : undefined); } finally { vf.close(); }
  }

  _initEncoder(video, srcKey) {
    this._reset(); // 映像の大きさが変わった(カメラの切り替え・向き)。最初から
    const scale = Math.min(1, this.owner.edge / Math.max(video.videoWidth, video.videoHeight));
    const w = even(video.videoWidth * scale);
    const h = even(video.videoHeight * scale);
    this.src = srcKey;
    this.lastKey = -1e9;
    try {
      this.enc = new VideoEncoder({
        output: (chunk, meta) => this._onChunk(chunk, meta),
        error: (e) => this.owner.fail(e),
      });
      const cfg = { codec: this.owner.codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: FPS, latencyMode: 'realtime' };
      if (this.owner.codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
      this.enc.configure(cfg);
      diagSet('ディレイの映像', `${w}x${h} ${Math.round(cfg.bitrate / 1000)}kbps`);
    } catch (err) {
      this.owner.fail(err);
    }
  }

  _onChunk(chunk, meta) {
    if (meta && meta.decoderConfig) this.decCfg = meta.decoderConfig;
    this.chunks.push({ seq: this.baseSeq + this.chunks.length, ts: chunk.timestamp / 1000, key: chunk.type === 'key', chunk });
    // 古いぶんを捨てる。捨てる位置は「全体を保存したコマ」の手前まで(途中から戻せなくなるため)
    const cutoff = performance.now() - this.owner.keepSec * 1000;
    let k = -1;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].key && this.chunks[i].ts <= cutoff) k = i; else if (this.chunks[i].ts > cutoff) break;
    }
    if (k > 0) { this.chunks.splice(0, k); this.baseSeq += k; }
  }

  oldestTs() { return this.chunks.length ? this.chunks[0].ts : null; }

  // いま − N秒 のコマを返す(なければ null)。返したコマは、次にこの関数を呼ぶまで有効(同じ処理の中で描くこと)
  frameFor(targetMs) {
    if (!this.chunks.length || !this.decCfg) return null;
    const now = performance.now();
    if (!this.dec || this.dec.state !== 'configured' || this.nextSeq < this.baseSeq) this._restart(targetMs);
    if (!this.dec) return null;
    this.target = targetMs;
    const t0 = performance.now();
    while (this.dec.decodeQueueSize < 6) {
      const i = this.nextSeq - this.baseSeq;
      if (i < 0 || i >= this.chunks.length) break;
      const c = this.chunks[i];
      if (c.ts > targetMs + FEED_AHEAD_MS) break;
      try { this.dec.decode(c.chunk); } catch (err) { this.owner.fail(err); return null; }
      this.nextSeq++;
    }
    diagTime('ディレイの戻しms', performance.now() - t0);
    const cur = this._prune(targetMs);
    if (cur) this.lastGood = now;
    else if (now - this.lastGood > 1000) { this._restart(targetMs); this.lastGood = now; } // 戻しが進まないときは、やりなおす
    return cur;
  }

  // 「いま − N秒」以前でいちばん新しいコマを残し、それより古いコマは閉じる
  _prune(targetMs) {
    let idx = -1;
    for (let i = 0; i < this.out.length; i++) { if (this.out[i].timestamp / 1000 <= targetMs) idx = i; else break; }
    for (let i = 0; i < idx; i++) this.out[i].close();
    if (idx > 0) this.out.splice(0, idx);
    return idx >= 0 ? this.out[0] : null;
  }

  _restart(targetMs) {
    this._closeDecoder();
    if (!this.decCfg || !this.chunks.length) return;
    let idx = 0;
    for (let i = 0; i < this.chunks.length; i++) { if (this.chunks[i].key && this.chunks[i].ts <= targetMs) idx = i; }
    this.nextSeq = this.chunks[idx].seq;
    try {
      this.dec = new VideoDecoder({
        output: (f) => { this.out.push(f); if (this.target != null) this._prune(this.target); },
        error: (e) => this.owner.fail(e),
      });
      this.dec.configure(this.decCfg);
    } catch (err) { this.dec = null; this.owner.fail(err); }
  }

  _closeDecoder() {
    if (this.dec && this.dec.state !== 'closed') { try { this.dec.close(); } catch (err) { /* 閉じ済み */ } }
    this.dec = null;
    this.out.forEach((f) => { try { f.close(); } catch (err) { /* 閉じ済み */ } });
    this.out = [];
  }

  _reset() {
    this._closeDecoder();
    if (this.enc && this.enc.state !== 'closed') { try { this.enc.close(); } catch (err) { /* 閉じ済み */ } }
    this.enc = null;
    this.chunks = [];
    this.baseSeq = 0;
    this.nextSeq = 0;
    this.decCfg = null;
  }

  close() { this._reset(); }
}

export class DelayCodec {
  // 使えるときだけ作る(使えなければ null → 今までの写真方式)。edge は映像の長い辺の上限(px)
  static async create(recorder, edge) {
    if (!delayCodecSupported()) return null;
    const w = even(edge);
    const h = even(edge * 9 / 16);
    const codec = await pickCodec(w, h);
    return codec ? new DelayCodec(recorder, edge, codec) : null;
  }

  constructor(recorder, edge, codec) {
    this.recorder = recorder;
    this.edge = edge;
    this.codec = codec;
    this.keepSec = 15;
    this.channels = new Map();
    this.timer = null;
    this.failed = false;
  }

  start(delaySec) {
    this.keepSec = delaySec + 3;
    diagSet('ディレイ方式', `動画 ${this.codec}`);
    this.timer = setInterval(() => this._captureAll(), 1000 / FPS);
  }

  _captureAll() {
    if (this.failed) return;
    const now = performance.now();
    for (const [id, cam] of this.recorder.cams) {
      let ch = this.channels.get(id);
      if (!ch) { ch = new Channel(this); this.channels.set(id, ch); }
      if (cam.paused) continue;
      ch.capture(cam.getVideoEl(), now);
    }
    for (const [id, ch] of [...this.channels]) {
      if (!this.recorder.cams.has(id)) { ch.close(); this.channels.delete(id); }
    }
  }

  fail(err) {
    if (this.failed) return;
    this.failed = true;
    console.error('ディレイの動画方式が失敗。写真方式に戻します', err);
    diagSet('ディレイ方式', '写真(動画方式が失敗)');
  }

  // 映像のあるカメラ。カメラ1、カメラ2…の順
  ids() {
    const num = (id) => { const m = /(\d+)/.exec(this.recorder.getLabel(id) || ''); return m ? parseInt(m[1], 10) : 99; };
    return [...this.channels].filter(([, ch]) => ch.chunks.length > 0).map(([id]) => id).sort((a, b) => num(a) - num(b));
  }

  label(id) { return this.recorder.getLabel(id); }
  oldestTs(id) { const ch = this.channels.get(id); return ch ? ch.oldestTs() : null; }
  frameFor(id, targetMs) { const ch = this.channels.get(id); return ch ? ch.frameFor(targetMs) : null; }

  dispose() {
    const t0 = performance.now();
    clearInterval(this.timer);
    this.timer = null;
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
    diagTime('動画の部品を閉じるms', performance.now() - t0); // 終了の瞬間に固まる原因の切り分け用(2026-11-03)
  }
}
