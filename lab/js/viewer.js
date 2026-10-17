// viewer.js: 親機に集まった動画から、全カメラを同じ時刻でそろえて並べて見る部品。試作用。
// - 録画の方式A(普通の動画ファイル)も、方式B(自前の区切りファイル)も同じ操作で見られる
// - 時刻は親機の時計(ミリ秒)。区切りの先頭の時刻(t0)から、各カメラの映像の位置を決める
// - 飛ぶ・コマ送りにかかった時間と、カメラ間の再生側のずれを測って出す

import { parseContainer, B_MIME } from './recorder-b.js';

const OVERLAP_PICK_MS = 0;

function fromBase64(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// その時刻を含む区切りのうち、いちばん後に始まったもの(重なっている所は新しい方を使う)
function pickSegment(segs, t) {
  let best = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t0 - OVERLAP_PICK_MS <= t && t < s.t0 + s.durMs && (best < 0 || s.t0 > segs[best].t0)) best = i;
  }
  return best;
}

// ---- 方式A: video 要素で再生 ----
class TrackA {
  constructor(cam, label, segs) {
    this.cam = cam; this.label = label; this.segs = segs;
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto';
    this.idx = -1; this.url = '';
    this.err = 0; // 直近の合わせ誤差(ミリ秒)
    this.playing = false;
  }

  async _load(idx) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(this.segs[idx].blob);
    this.idx = idx;
    const v = this.video;
    v.src = this.url;
    await new Promise((resolve) => {
      const done = () => resolve();
      v.addEventListener('loadedmetadata', done, { once: true });
      v.addEventListener('error', done, { once: true });
    });
    // MediaRecorder の webm は長さを持たないことがある。末尾まで飛ばして長さを確定させる
    if (v.duration === Infinity) {
      await new Promise((resolve) => {
        v.addEventListener('timeupdate', function onTime() {
          if (v.duration !== Infinity) { v.removeEventListener('timeupdate', onTime); resolve(); }
        });
        v.currentTime = 1e101;
        setTimeout(resolve, 1500);
      });
    }
  }

  async seek(t) {
    const idx = pickSegment(this.segs, t);
    this.has = idx >= 0;
    if (idx < 0) { this.video.pause(); return; }
    if (idx !== this.idx) await this._load(idx);
    const v = this.video;
    const want = Math.max(0, (t - this.segs[idx].t0) / 1000);
    await new Promise((resolve) => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; v.removeEventListener('seeked', done); resolve(); };
      v.addEventListener('seeked', done);
      v.currentTime = want;
      setTimeout(done, 1500);
    });
    this.err = Math.round(v.currentTime * 1000 - want * 1000);
  }

  play() { if (this.has && this.video.paused) this.video.play().catch(() => {}); this.playing = true; }
  pause() { this.video.pause(); this.playing = false; }

  // 再生中の1コマごとの合わせ直し。ずれが大きいとき、または区切りが切れたときだけ飛ばす
  async tick(t) {
    const idx = pickSegment(this.segs, t);
    this.has = idx >= 0;
    if (idx < 0) { this.video.pause(); return; }
    if (idx !== this.idx) { await this.seek(t); if (this.playing) this.play(); return; }
    const want = (t - this.segs[idx].t0) / 1000;
    const diff = this.video.currentTime - want;
    this.err = Math.round(diff * 1000);
    if (Math.abs(diff) > 0.25) { await this.seek(t); if (this.playing) this.play(); }
  }

  drawable() { return this.has && this.video.readyState >= 2 ? this.video : null; }
  size() { return [this.video.videoWidth, this.video.videoHeight]; }
  close() { this.video.pause(); if (this.url) URL.revokeObjectURL(this.url); this.video.removeAttribute('src'); }
}

// ---- 方式B: 自前で復号して描く ----
class TrackB {
  constructor(cam, label, segs) {
    this.cam = cam; this.label = label; this.segs = segs;
    this.idx = -1; this.parsed = null; this.decoder = null;
    this.frames = []; this.fed = 0; this.nextChunk = 0; this.cur = null; this.err = 0; this.playing = false;
    this.w = 0; this.h = 0;
  }

  async _open(idx) {
    this.idx = idx;
    this.parsed = await parseContainer(this.segs[idx].blob);
    const cfg = this.parsed.meta.config;
    this.w = cfg.codedWidth; this.h = cfg.codedHeight;
  }

  _newDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (e) { /* 無視 */ } }
    this.frames.forEach((f) => f.close());
    this.frames = []; this.fed = 0; this.outCount = 0;
    const cfg = this.parsed.meta.config;
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this.outCount++; },
      error: () => {},
    });
    const conf = { codec: cfg.codec, codedWidth: cfg.codedWidth, codedHeight: cfg.codedHeight, optimizeForLatency: true };
    if (cfg.description) conf.description = fromBase64(cfg.description);
    this.decoder.configure(conf);
  }

  _feed(i) {
    const c = this.parsed.chunks[i];
    this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, duration: c.dur, data: c.data }));
    this.fed++; this.nextChunk = i + 1;
  }

  async _waitOut(n) {
    const until = performance.now() + 2500;
    while (this.outCount < n && performance.now() < until) await new Promise((r) => setTimeout(r, 4));
  }

  _targetTs(t) { return (t - this.segs[this.idx].t0) * 1000 + this.parsed.meta.firstTs; }

  _pickFrame(targetTs) {
    let pick = null;
    for (const f of this.frames) if (f.timestamp <= targetTs && (!pick || f.timestamp > pick.timestamp)) pick = f;
    if (!pick && this.frames.length) pick = this.frames[0];
    if (pick) {
      this.frames = this.frames.filter((f) => {
        if (f === pick) return true;
        if (f.timestamp < pick.timestamp) { f.close(); return false; }
        return true;
      });
      this.cur = pick;
      this.err = Math.round((pick.timestamp - targetTs) / 1000);
    }
  }

  async seek(t) {
    const idx = pickSegment(this.segs, t);
    this.has = idx >= 0;
    if (idx < 0) { this.cur = null; return; }
    if (idx !== this.idx || !this.parsed) await this._open(idx);
    this._newDecoder();
    const target = this._targetTs(t);
    const chunks = this.parsed.chunks;
    let k = 0;
    for (let i = 0; i < chunks.length; i++) { if (chunks[i].type === 'key' && chunks[i].ts <= target) k = i; if (chunks[i].ts > target) break; }
    let last = k;
    for (let i = k; i < chunks.length; i++) { this._feed(i); last = i; if (chunks[i].ts >= target) break; }
    await this._waitOut(this.fed);
    this.nextChunk = last + 1;
    this._pickFrame(target);
  }

  play() { this.playing = true; }
  pause() { this.playing = false; }

  async tick(t) {
    const idx = pickSegment(this.segs, t);
    this.has = idx >= 0;
    if (idx < 0) { this.cur = null; return; }
    if (idx !== this.idx) { await this.seek(t); return; }
    const target = this._targetTs(t);
    const chunks = this.parsed.chunks;
    if (this.cur && Math.abs(this.cur.timestamp - target) > 400000) { await this.seek(t); return; }
    const before = this.fed;
    while (this.nextChunk < chunks.length && chunks[this.nextChunk].ts <= target + 100000 && this.fed - before < 12) this._feed(this.nextChunk);
    this._pickFrame(target);
  }

  drawable() { return this.has && this.cur ? this.cur : null; }
  size() { return [this.w, this.h]; }
  close() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (e) { /* 無視 */ } }
    this.frames.forEach((f) => f.close()); this.frames = []; this.cur = null;
  }
}

// ---------------------------------------------------------------------------
export class LabViewer {
  constructor({ store, canvas, onChange }) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.tracks = [];
    this.t = 0; this.tMin = 0; this.tMax = 0;
    this.playing = false;
    this.metrics = { seekMs: null, stepMs: null, maxErrMs: null, fps: 30, jumpMs: null, spreadMs: null };
    this._raf = 0;
  }

  async open(takeId) {
    this.close();
    const all = await this.store.listByTake(takeId);
    const byCam = new Map();
    all.forEach((s) => { if (!byCam.has(s.cam)) byCam.set(s.cam, []); byCam.get(s.cam).push(s); });
    const cams = [...byCam.entries()].sort((a, b) => String(a[1][0].label).localeCompare(String(b[1][0].label), 'ja'));
    this.tracks = cams.map(([cam, segs]) => {
      segs.sort((a, b) => a.t0 - b.t0);
      const useB = segs[0].mime === B_MIME;
      return useB ? new TrackB(cam, segs[0].label, segs) : new TrackA(cam, segs[0].label, segs);
    });
    this.tMin = Math.min(...all.map((s) => s.t0));
    this.tMax = Math.max(...all.map((s) => s.t0 + s.durMs));
    this.metrics.fps = Math.round(all[0].fps) || 30;
    // 最初は、全カメラの録画がそろっている時刻から見せる(カメラによって始まりが少し違う)
    this.t = Math.max(...this.tracks.map((tr) => tr.segs[0].t0));
    await this.seek(this.t);
    return { cams: this.tracks.length, durationMs: this.tMax - this.tMin };
  }

  get durationMs() { return this.tMax - this.tMin; }

  _spread() {
    const errs = this.tracks.filter((tr) => tr.has).map((tr) => tr.err);
    if (errs.length > 1) this.metrics.spreadMs = Math.max(...errs) - Math.min(...errs);
    this.metrics.maxErrMs = errs.length ? Math.max(...errs.map(Math.abs)) : null;
  }

  async seek(t) {
    const started = performance.now();
    const before = this.t;
    this.t = Math.min(Math.max(t, this.tMin), this.tMax);
    await Promise.all(this.tracks.map((tr) => tr.seek(this.t)));
    this._spread();
    this.draw();
    this.metrics.seekMs = Math.round(performance.now() - started);
    if (Math.abs(this.t - before) >= 5000) this.metrics.jumpMs = this.metrics.seekMs; // 離れた場面(5秒以上)へ移るのにかかった時間
    this.onChange();
    return this.metrics.seekMs;
  }

  async step(dir) {
    const started = performance.now();
    this.pause();
    await this.seek(this.t + dir * (1000 / this.metrics.fps));
    this.metrics.stepMs = Math.round(performance.now() - started);
    this.onChange();
    return this.metrics.stepMs;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.tracks.forEach((tr) => tr.play());
    let last = performance.now();
    const loop = async () => {
      if (!this.playing) return;
      const now = performance.now();
      this.t += now - last; last = now;
      if (this.t >= this.tMax) { this.pause(); this.t = this.tMax; this.draw(); this.onChange(); return; }
      await Promise.all(this.tracks.map((tr) => tr.tick(this.t)));
      this._spread();
      this.draw();
      this.onChange();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this.tracks.forEach((tr) => tr.pause());
  }

  draw() {
    const cv = this.canvas;
    const w = cv.clientWidth || 640;
    const h = cv.clientHeight || 360;
    if (cv.width !== w * 2 || cv.height !== h * 2) { cv.width = w * 2; cv.height = h * 2; }
    const g = this.ctx;
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const n = this.tracks.length;
    if (!n) return;
    const cols = n === 1 ? 1 : 2;
    const rows = Math.ceil(n / cols);
    const tw = w / cols;
    const th = h / rows;
    this.tracks.forEach((tr, i) => {
      const x0 = (i % cols) * tw;
      const y0 = Math.floor(i / cols) * th;
      const d = tr.drawable();
      if (d) {
        const [sw, sh] = tr.size();
        if (sw && sh) {
          const s = Math.min(tw / sw, th / sh);
          g.drawImage(d, x0 + (tw - sw * s) / 2, y0 + (th - sh * s) / 2, sw * s, sh * s);
        }
      } else {
        g.fillStyle = '#888';
        g.font = '14px sans-serif';
        g.fillText('この時刻の録画はありません', x0 + 12, y0 + th / 2);
      }
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x0 + 4, y0 + 4, 150, 22);
      g.fillStyle = '#fff';
      g.font = 'bold 14px sans-serif';
      g.fillText(`${tr.label}${tr.has ? ` (${tr.err >= 0 ? '+' : ''}${tr.err}ms)` : ''}`, x0 + 10, y0 + 20);
    });
  }

  close() {
    this.pause();
    this.tracks.forEach((tr) => tr.close());
    this.tracks = [];
  }
}
