// viewer.js: 親機に集まった動画から、全カメラを同じ時刻でそろえて並べて見る部品。試作用。
// - 録画の方式A(普通の動画ファイル)も、方式B(自前の区切りファイル)も同じ操作で見られる
// - 時刻は親機の時計(ミリ秒)。区切りの先頭の時刻(t0)から、各カメラの映像の位置を決める
// - 飛ぶ・コマ送りにかかった時間と、カメラ間の再生側のずれを測って出す

import { parseContainer, B_MIME } from './recorder-b.js';
import { chooseGrid } from './grid.js';

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

  get hasAudio() { return true; }
  setSound(on) { this.video.muted = !on; }
  play() { if (this.has && this.video.paused) this.video.play().catch(() => {}); this.playing = true; }
  pause() { this.video.pause(); this.playing = false; this.video.muted = true; }

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

// 区切りの音(圧縮されたもの)を復号して、1本の AudioBuffer にする
function fromB64(b64) { return fromBase64(b64); }
async function decodeSegmentAudio(parsed, ctx) {
  const ac = parsed.meta.audio;
  if (!ac || !ac.config || !parsed.audioChunks.length) return null;
  const cfg = ac.config;
  const ch = cfg.numberOfChannels || 1;
  const sr = cfg.sampleRate;
  const out = [];
  const dec = new AudioDecoder({
    output: (d) => {
      const planes = [];
      for (let c = 0; c < ch; c++) { const a = new Float32Array(d.numberOfFrames); d.copyTo(a, { planeIndex: c, format: 'f32-planar' }); planes.push(a); }
      out.push({ n: d.numberOfFrames, planes });
      d.close();
    },
    error: () => {},
  });
  dec.configure({ codec: cfg.codec, sampleRate: sr, numberOfChannels: ch, ...(cfg.description ? { description: fromB64(cfg.description) } : {}) });
  for (const c of parsed.audioChunks) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.ts, duration: c.dur, data: c.data }));
  await dec.flush();
  dec.close();
  const total = out.reduce((a, o) => a + o.n, 0);
  if (!total) return null;
  const buf = ctx.createBuffer(ch, total, sr);
  let pos = 0;
  for (const o of out) { for (let c = 0; c < ch; c++) buf.getChannelData(c).set(o.planes[c], pos); pos += o.n; }
  return { buf, startTs: parsed.audioChunks[0].ts };
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

  // この時刻の区切りの音を、再生できる形(AudioBuffer)にして返す。区切りごとに1回だけ作って控える
  async audioAt(ctx, t) {
    const idx = pickSegment(this.segs, t);
    if (idx < 0 || typeof AudioDecoder === 'undefined') return null;
    this._aCache = this._aCache || new Map();
    if (!this._aCache.has(idx)) {
      const seg = this.segs[idx];
      const parsed = idx === this.idx && this.parsed ? this.parsed : await parseContainer(seg.blob);
      let got = null;
      try { got = await decodeSegmentAudio(parsed, ctx); } catch (err) { got = null; }
      this._aCache.set(idx, got ? { idx, buf: got.buf, wallStart: seg.t0 + (got.startTs - parsed.meta.firstTs) / 1000 } : { idx, buf: null });
      while (this._aCache.size > 3) this._aCache.delete(this._aCache.keys().next().value);
    }
    const r = this._aCache.get(idx);
    return r.buf ? r : null;
  }
  get hasAudio() { return this.segs.some((sg) => sg.meta && sg.meta.audio); }
  setSound() {}

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
    this.focus = null; // 1つずつ見ているカメラ(null なら全カメラを並べる)
    this.audioCamSetting = 'auto'; // 音を出すカメラ。auto は 並べて見る形ではカメラ1、1つずつ見る形ではそのカメラ
    this.debug = false; // true のとき、各映像に合わせ誤差(ms)も出す
    this.audioCam = null; // 今、音を出しているカメラ(動作の確認用)
    this.metrics = { seekMs: null, stepMs: null, maxErrMs: null, fps: 30, jumpMs: null, spreadMs: null };
    this._raf = 0;
    this._layout = null;
    this._aTok = 0;
    this._aSrc = null;
    this._aSeg = -1;
    this._actx = null;
  }

  async open(takeId) {
    this.close();
    const all = (await this.store.listByTake(takeId)).filter((s) => s.blob);
    if (!all.length) throw new Error('この録画には映像がありません');
    const byCam = new Map();
    all.forEach((s) => { if (!byCam.has(s.cam)) byCam.set(s.cam, []); byCam.get(s.cam).push(s); });
    const cams = [...byCam.entries()].sort((a, b) => String(a[1][0].label).localeCompare(String(b[1][0].label), 'ja'));
    this.tracks = cams.map(([cam, segs]) => {
      segs.sort((a, b) => a.t0 - b.t0);
      const useB = segs[0].mime === B_MIME;
      return useB ? new TrackB(cam, segs[0].label, segs) : new TrackA(cam, segs[0].label, segs);
    });
    this.focus = null;
    this.tMin = Math.min(...all.map((s) => s.t0));
    this.tMax = Math.max(...all.map((s) => s.t0 + s.durMs));
    this.metrics.fps = Math.round(all[0].fps) || 30;
    // 最初は、全カメラの録画がそろっている時刻から見せる(カメラによって始まりが少し違う)
    this.t = Math.max(...this.tracks.map((tr) => tr.segs[0].t0));
    await this.seek(this.t);
    return { cams: this.tracks.length, durationMs: this.tMax - this.tMin };
  }

  get durationMs() { return this.tMax - this.tMin; }
  get camCount() { return this.tracks.length; }

  // ---- 1つずつ見る / 並べて見る ----
  setFocus(cam) {
    this.focus = cam && this.tracks.some((tr) => tr.cam === cam) ? cam : null;
    this.draw();
    if (this.playing) this._audioSync();
    this.onChange();
  }

  // タップした場所のカメラ(並べて見ているときだけ)
  camAt(x, y) {
    const L = this._layout;
    if (this.focus || !L) return null;
    const col = Math.floor(x / L.tw);
    const row = Math.floor(y / L.th);
    if (col < 0 || row < 0 || col >= L.cols || row >= L.rows) return null;
    const tr = this.tracks[row * L.cols + col];
    return tr ? tr.cam : null;
  }

  // 音を出すカメラ: 設定があればそれ。なければ、1つずつ見ているときはそのカメラ、並べて見ているときはカメラ1
  _audioTrack() {
    if (!this.tracks.length) return null;
    const pick = (cam) => this.tracks.find((tr) => tr.cam === cam);
    if (this.audioCamSetting !== 'auto') { const x = pick(this.audioCamSetting); if (x) return x; }
    if (this.focus) return pick(this.focus);
    return this.tracks.find((tr) => /^カメラ1$/.test(String(tr.label))) || this.tracks[0];
  }

  get hasAudio() { const tr = this._audioTrack(); return !!(tr && tr.hasAudio); }

  _audioStopSrc() {
    if (this._aSrc) { try { this._aSrc.onended = null; this._aSrc.stop(); } catch (err) { /* 無視 */ } try { this._aSrc.disconnect(); } catch (err) { /* 無視 */ } this._aSrc = null; }
    this._aSeg = -1;
  }

  // 音を出し直す(再生を始めたとき、区切りが変わったとき、音のカメラが変わったとき)。コマ送り・止めている間は出さない
  async _audioSync() {
    const tok = ++this._aTok;
    this._audioStopSrc();
    this.tracks.forEach((tr) => tr.setSound(false));
    this.audioCam = null;
    if (!this.playing) return;
    const tr = this._audioTrack();
    if (!tr) return;
    if (tr instanceof TrackA) { tr.setSound(true); this.audioCam = tr.cam; return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._actx = this._actx || new Ctx();
      if (this._actx.state === 'suspended') await this._actx.resume().catch(() => {});
      const got = await tr.audioAt(this._actx, this.t);
      if (tok !== this._aTok || !this.playing || !got) return;
      const off = (this.t - got.wallStart) / 1000;
      const src = this._actx.createBufferSource();
      src.buffer = got.buf;
      src.connect(this._actx.destination);
      if (off >= 0) { if (off >= got.buf.duration) return; src.start(0, off); } else src.start(this._actx.currentTime - off, 0);
      this._aSrc = src; this._aSeg = got.idx; this.audioCam = tr.cam;
    } catch (err) { /* 音が出せなくても映像は見られる */ }
  }

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
    this.pause(); // コマ送りの間は音を出さない
    await this.seek(this.t + dir * (1000 / this.metrics.fps));
    this.metrics.stepMs = Math.round(performance.now() - started);
    this.onChange();
    return this.metrics.stepMs;
  }

  play() {
    if (this.playing) return;
    if (this.t >= this.tMax - 50) this.t = this.tMin;
    this.playing = true;
    this.tracks.forEach((tr) => tr.play());
    this._audioSync();
    let last = performance.now();
    const loop = async () => {
      if (!this.playing) return;
      const now = performance.now();
      this.t += now - last; last = now;
      if (this.t >= this.tMax) { this.pause(); this.t = this.tMax; this.draw(); this.onChange(); return; }
      await Promise.all(this.tracks.map((tr) => tr.tick(this.t)));
      if (!this.playing) return;
      // 音を出している区切りが終わったら、次の区切りの音に替える
      const atr = this._audioTrack();
      if (atr instanceof TrackB && this._aSeg >= 0 && pickSegment(atr.segs, this.t) !== this._aSeg && !this._aBusy) {
        this._aBusy = true;
        this._audioSync().finally(() => { this._aBusy = false; });
      }
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
    this._aTok++;
    this._audioStopSrc();
    this.tracks.forEach((tr) => tr.pause());
    this.audioCam = null;
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
    const shown = this.focus ? this.tracks.filter((tr) => tr.cam === this.focus) : this.tracks;
    const n = shown.length;
    if (!n) { this._layout = null; return; }
    // 1つの枠の大きさは、映像の一番大きいものに合わせる(縦向きと横向きのカメラが混ざっても、引き伸ばさない)
    let nw = 0; let nh = 0;
    shown.forEach((tr) => { const [sw, sh] = tr.size(); nw = Math.max(nw, sw || 0); nh = Math.max(nh, sh || 0); });
    if (!nw || !nh) { nw = 640; nh = 480; }
    const lay = chooseGrid(n, nw, nh, w, h);
    const tw = w / lay.cols;
    const th = h / lay.rows;
    this._layout = { cols: lay.cols, rows: lay.rows, tw, th };
    const fontPx = 15;
    shown.forEach((tr, i) => {
      const x0 = (i % lay.cols) * tw;
      const y0 = Math.floor(i / lay.cols) * th;
      const d = tr.drawable();
      if (d) {
        const [sw, sh] = tr.size();
        if (sw && sh) {
          const s = Math.min(tw / sw, th / sh);
          g.drawImage(d, x0 + (tw - sw * s) / 2, y0 + (th - sh * s) / 2, sw * s, sh * s);
        }
      } else {
        g.fillStyle = '#8e8e93';
        g.font = `800 ${fontPx}px Murecho, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('この時間は映像なし', x0 + tw / 2, y0 + th / 2);
      }
      // カメラ名(左上)。暗い地に白い文字で、明るい映像の上でも読めるようにする
      const label = this.debug && tr.has ? `${tr.label} (${tr.err >= 0 ? '+' : ''}${tr.err}ms)` : String(tr.label);
      g.font = `900 ${fontPx}px Murecho, sans-serif`;
      g.textAlign = 'left'; g.textBaseline = 'middle';
      const bw = g.measureText(label).width + 18;
      g.fillStyle = 'rgba(28, 28, 30, 0.82)';
      g.fillRect(x0, y0, bw, 28);
      g.fillStyle = '#fff';
      g.fillText(label, x0 + 9, y0 + 14);
    });
  }

  close() {
    this.pause();
    this.tracks.forEach((tr) => tr.close());
    this.tracks = [];
    this.focus = null;
    this._layout = null;
    if (this._actx) { try { this._actx.close(); } catch (err) { /* 無視 */ } this._actx = null; }
  }
}
