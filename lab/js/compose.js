// compose.js: 全カメラを並べた「まとめ」の動画(MP4)を作る。試作用。
// - 作り方1(WebCodecs): 各カメラの動画を1コマずつ読み出して1枚の絵に並べ、もう一度圧縮する。録画より速く終わることが多い
//   音は、選んだ1台(既定はカメラ1)の圧縮済みの音を、そのまま時刻を合わせて入れる(混ぜない・作り直さない)
// - 作り方2(再生しながら録り直す): WebCodecs が使えない端末向け。並べた画面を再生しながらブラウザ標準の録画で録る。録った長さと同じ時間がかかる
// - 並べ方・カメラ名の見た目は、見る画面(viewer.js)と同じ。時刻は各カメラの区切りの先頭の時刻(親機の時計に合わせてある)でそろえる。始まっていないカメラの枠は黒
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';
import { parseContainer, B_MIME } from './recorder-b.js';
import { chooseGrid } from './grid.js';
import { LabViewer } from './viewer.js';

// 画質(どちらも仮の値。実機の結果で調整する)
export const QUALITY = {
  low: { label: '低', boxW: 960, boxH: 540, fps: 15, bitrate: 1000000 },
  std: { label: '標準', boxW: 1280, boxH: 720, fps: 30, bitrate: 3000000 },
};

const VIDEO_CANDIDATES = [
  { codec: 'avc1.42001f', avc: { format: 'avc' } },
  { codec: 'avc1.420028', avc: { format: 'avc' } },
  { codec: 'vp09.00.10.08' },
];

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const tick = () => new Promise((r) => setTimeout(r, 0));
const cancelled = () => Object.assign(new Error('中止しました'), { cancelled: true });

// 計測(試験用の「数値をコピー」に出す。動きは変えない。動画処理コーダー、2026-10-20)
// 時間の内訳(ミリ秒の合計)と、待ち行列の長さ(平均・最大)を、まとめ1回ぶん集める
function newDiag() {
  const d = { t: { read: 0, readWait: 0, draw: 0, encWait: 0 }, q: {}, hiddenMs: 0 };
  d.add = (k, ms) => { d.t[k] += ms; };
  d.qs = (k, v) => { const s = d.q[k] || (d.q[k] = { n: 0, sum: 0, max: 0 }); s.n++; s.sum += v; if (v > s.max) s.max = v; };
  return d;
}

// 選んだ圧縮の設定が、端末の回路(ハードウェア)で動くか。prefer-hardware で通らなければ、ソフトウェアで動いている見込みが高い
async function probeHardware(cfg) {
  const out = {};
  for (const hw of ['prefer-hardware', 'prefer-software']) {
    try { const r = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw }); out[hw] = !!(r && r.supported); }
    catch (err) { out[hw] = null; }
  }
  return out;
}

function fromBase64(b64) {
  if (!b64) return undefined;
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function pickEncoder(width, height, bitrate, fps) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const cand of VIDEO_CANDIDATES) {
    const cfg = { ...cand, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return { ...cfg, ...(r.config || {}) };
    } catch (err) { /* 次へ */ }
  }
  return null;
}

// その時刻を含む区切りのうち、いちばん後に始まったもの
function pickSegment(segs, t) {
  let best = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t0 <= t && t < s.t0 + s.durMs && (best < 0 || s.t0 > segs[best].t0)) best = i;
  }
  return best;
}

// 先読みするコマ数: いま必要なコマの先まで、動画の読み出し(デコーダー)に渡しておく数。
// 1コマ渡しては出てくるのを待つ作りだと、端末の専用処理部の待ち時間がそのまま積み上がるため(実機の計測で、まとめの時間の84%が待ちだった)。
// 多いほど速いが、出てきたコマを持ち続ける分、端末の専用処理部のバッファとメモリを使う。URL に ?ahead=数 を付けると、端末で試せる
const AHEAD_DEFAULT = 4;
const DECODE_QUEUE_MAX = 12;
export function aheadFrames() {
  try {
    const raw = new URLSearchParams(location.search).get('ahead');
    const v = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(v) && v >= 0 && v <= 30) return Math.floor(v);
  } catch (err) { /* 無視 */ }
  return AHEAD_DEFAULT;
}

// 交互にやる: 出力の何コマぶんを、まとめて「読み出して並べる」→まとめて「圧縮に渡す」にするか。0なら1コマずつ(従来)。
// 読み出しと圧縮が同時に端末の専用処理部を使うと取り合いになる疑いがあるため、時間をずらして試す。URL に ?batch=数 を付けると端末で試せる
export const BATCH_DEFAULT = 0;
export function batchFrames() {
  try {
    const raw = new URLSearchParams(location.search).get('batch');
    const v = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(v) && v >= 0 && v <= 64) return Math.floor(v);
  } catch (err) { /* 無視 */ }
  return BATCH_DEFAULT;
}

// 読み出し(デコーダー)をどこで動かすか。実機の計測で、読み出しと圧縮が同じ専用処理部を使って足し算になっていた疑いがあるため、
// 読み出しをCPUに回して並行させられるか試す。URL に ?dec=cpu(CPUで読み出す) / ?dec=hw(専用処理部で読み出す) / なし(端末まかせ・従来)
export function decodeHardware() {
  try {
    const v = new URLSearchParams(location.search).get('dec');
    if (v === 'cpu') return 'prefer-software';
    if (v === 'hw') return 'prefer-hardware';
  } catch (err) { /* 無視 */ }
  return null;
}

// 絵を描く場所。実機の計測で、読み出し・圧縮のどちらを変えても時間が変わらず、画像用メモリ(GPU)の往復が共通の詰まりと疑われるため、
// 描く場所をCPU側のメモリにできるか試す。URL に ?cv=cpu(CPU側で描く) / なし(従来)
export function canvasOnCpu() {
  try { return new URLSearchParams(location.search).get('cv') === 'cpu'; } catch (err) { return false; }
}

// 前から順に読み出すだけの、書き出し用の読み取り役(見る画面の TrackB より単純。飛ぶ動きはない)
// 必要なコマが出てくるまでだけ待ち、その先 aheadFrames() コマは待たずに読み出しへ渡しておく
class ExportTrack {
  constructor(cam, label, segs) {
    this.cam = cam; this.label = label; this.segs = segs;
    this.idx = -1; this.parsed = null; this.decoder = null;
    this.frames = []; this.fed = 0; this.outCount = 0; this.next = 0; this.need = 0; this.cur = null; this.error = null;
    this.w = 0; this.h = 0;
    this.ahead = aheadFrames();
    this._wait = null; this._room = null;
  }

  _dropFrames() { this.frames.forEach((f) => f.close()); this.frames = []; this.cur = null; }

  _wakeAll() {
    const w = this._wait;
    if (w && (this.outCount >= w.n || this.error || !this.decoder)) { this._wait = null; clearTimeout(w.timer); w.resolve(); }
    const r = this._room;
    if (r) { this._room = null; clearTimeout(r.timer); r.resolve(); }
  }

  _closeDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (err) { /* 無視 */ } }
    this.decoder = null;
    this._wakeAll();
  }

  async _open(idx) {
    this._closeDecoder();
    this._dropFrames();
    this.idx = idx;
    this.parsed = await parseContainer(this.segs[idx].blob);
    const cfg = this.parsed.meta.config;
    this.w = cfg.codedWidth; this.h = cfg.codedHeight;
    this.fed = 0; this.outCount = 0; this.next = 0; this.need = 0;
    const dec = new VideoDecoder({
      output: (f) => { if (this.decoder !== dec) { f.close(); return; } this.frames.push(f); this.outCount++; this._wakeAll(); },
      error: (e) => { this.error = e; this._wakeAll(); },
    });
    this.decoder = dec;
    dec.ondequeue = () => this._wakeAll();
    const conf = { codec: cfg.codec, codedWidth: cfg.codedWidth, codedHeight: cfg.codedHeight };
    if (cfg.description) conf.description = fromBase64(cfg.description);
    const hwPref = decodeHardware();
    if (hwPref) {
      try { const r = await VideoDecoder.isConfigSupported({ ...conf, hardwareAcceleration: hwPref }); if (r && r.supported) conf.hardwareAcceleration = hwPref; } catch (err) { /* 端末まかせ */ }
    }
    this.decHw = conf.hardwareAcceleration || 'default';
    dec.configure(conf);
  }

  // 出てきたコマが n 個になるまで待つ(出たらすぐ進む。5秒たっても出ないときは先へ進む)
  _waitOut(n) {
    if (this.outCount >= n || this.error || !this.decoder) return Promise.resolve();
    return new Promise((resolve) => { this._wait = { n, resolve, timer: setTimeout(() => { this._wait = null; resolve(); }, 5000) }; });
  }

  // 読み出しの待ち行列に空きができるまで待つ(dequeue が来なくても、5ミリ秒で見に戻る)
  _waitRoom() {
    return new Promise((resolve) => { this._room = { resolve, timer: setTimeout(() => { this._room = null; resolve(); }, 5) }; });
  }

  // その時刻の1コマ(なければ null)。時刻は前へ進む順に呼ぶ
  async frameAt(t) {
    const idx = pickSegment(this.segs, t);
    if (idx < 0) { this._closeDecoder(); this._dropFrames(); this.idx = -1; return null; }
    if (idx !== this.idx || !this.decoder) await this._open(idx);
    const seg = this.segs[idx];
    const target = (t - seg.t0) * 1000 + this.parsed.meta.firstTs;
    const chunks = this.parsed.chunks;
    // この時刻までに出ているべきコマの数(最低1)と、読み出しへ渡しておく数
    while (this.need < chunks.length && chunks[this.need].ts <= target) this.need++;
    const need = Math.max(1, this.need);
    const goal = Math.min(chunks.length, need + this.ahead);
    while (this.next < goal) {
      const c = chunks[this.next++];
      this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, duration: c.dur, data: c.data }));
      this.fed++;
      while (this.decoder.decodeQueueSize > DECODE_QUEUE_MAX && !this.error) await this._waitRoom();
    }
    if (this.diag) this.diag.qs('decode', this.decoder.decodeQueueSize);
    const w0 = performance.now();
    await this._waitOut(need);
    if (this.diag) this.diag.add('readWait', performance.now() - w0);
    if (this.error) throw this.error;
    let pick = null;
    for (const f of this.frames) if (f.timestamp <= target && (!pick || f.timestamp > pick.timestamp)) pick = f;
    if (!pick && this.frames.length) pick = this.frames[0];
    if (pick) {
      this.frames = this.frames.filter((f) => { if (f === pick || f.timestamp > pick.timestamp) return true; f.close(); return false; });
      this.cur = pick;
    }
    return this.cur;
  }

  close() { this._closeDecoder(); this._dropFrames(); }
}

// 録画1本の区切りを、カメラごとにまとめる
async function groupTake(store, takeId) {
  const all = (await store.listByTake(takeId)).filter((s) => s.blob);
  if (!all.length) throw new Error('保存できる映像がありません');
  const byCam = new Map();
  all.forEach((s) => { if (!byCam.has(s.cam)) byCam.set(s.cam, []); byCam.get(s.cam).push(s); });
  const cams = [...byCam.values()].map((l) => l.sort((a, b) => a.t0 - b.t0))
    .sort((a, b) => String(a[0].label).localeCompare(String(b[0].label), 'ja'));
  return { all, cams };
}

// 音を入れるカメラ: 設定があればそれ。なければ「カメラ1」、なければ先頭
function pickAudioCam(cams, setting) {
  if (setting && setting !== 'auto') { const x = cams.find((l) => l[0].cam === setting); if (x) return x; }
  return cams.find((l) => /^カメラ1$/.test(String(l[0].label))) || cams[0];
}

export function canComposeFast() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

export function canComposeByReplay() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

// 録画1本を、まとめの動画にする。戻り値: { blob, mime, ext, mode, hasAudio, videoCodec, width, height, fps, frames, ms }
// onProgress({ fraction, remainMs })、shouldCancel() が true なら中止する(例外 .cancelled)
export async function composeTake(store, take, { quality = 'low', audioCam = 'auto', onProgress = () => {}, shouldCancel = () => false, forceReplay = false } = {}) {
  const q = QUALITY[quality] || QUALITY.low;
  const { all, cams } = await groupTake(store, take.id);
  if (cams.length < 2) throw Object.assign(new Error('カメラが1台のため、まとめは作りません'), { single: true });
  const allB = all.every((s) => s.mime === B_MIME);
  if (typeof window !== 'undefined' && window.__labForceReplay) forceReplay = true; // 試験用: 再生しながら録り直す方法を使う
  if (allB && !forceReplay && canComposeFast()) return composeFast(cams, all, q, audioCam, { onProgress, shouldCancel });
  if (canComposeByReplay()) return composeByReplay(store, take, cams, q, audioCam, { onProgress, shouldCancel });
  throw Object.assign(new Error('この端末では、まとめ動画を作れません'), { unsupported: true });
}

async function composeFast(cams, all, q, audioCam, { onProgress, shouldCancel }) {
  const started = performance.now();
  const tMin = Math.min(...all.map((s) => s.t0));
  const tMax = Math.max(...all.map((s) => s.t0 + s.durMs));
  const tracks = cams.map((l) => new ExportTrack(l[0].cam, l[0].label, l));
  const diag = newDiag();
  tracks.forEach((tr) => { tr.diag = diag; });
  // まとめを作っている間に、画面が隠れていた時間(隠れている間はブラウザが処理を遅くするため、時間の見方に必要)
  let hiddenSince = typeof document !== 'undefined' && document.hidden ? performance.now() : 0;
  const onVis = () => {
    if (document.hidden) hiddenSince = performance.now();
    else if (hiddenSince) { diag.hiddenMs += performance.now() - hiddenSince; hiddenSince = 0; }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  const closeAll = () => tracks.forEach((tr) => tr.close());
  let encoder = null;
  try {
    // 1つの枠の大きさは、映像の一番大きいものに合わせる(見る画面と同じ)
    let tw = 0; let th = 0;
    for (const tr of tracks) {
      const p = await parseContainer(tr.segs[0].blob);
      tw = Math.max(tw, p.meta.config.codedWidth); th = Math.max(th, p.meta.config.codedHeight);
    }
    const lay = chooseGrid(tracks.length, tw, th, q.boxW, q.boxH);
    const cellW = even(tw * lay.scale); const cellH = even(th * lay.scale);
    const W = cellW * lay.cols; const H = cellH * lay.rows;
    const cfg = await pickEncoder(W, H, q.bitrate, q.fps);
    if (!cfg) throw new Error('まとめ動画に使える圧縮方式がありません');
    const vKind = cfg.codec.startsWith('avc') ? 'avc' : 'vp9';
    const hw = await probeHardware(cfg);

    // 音: 選んだ1台の、圧縮済みの音をそのまま入れる
    const aCam = pickAudioCam(cams, audioCam);
    const firstP = await parseContainer(aCam[0].blob);
    const aCfg = firstP.meta.audio && firstP.meta.audio.config ? firstP.meta.audio.config : null;
    const aKind = aCfg ? (aCfg.codec.startsWith('mp4a') ? 'aac' : aCfg.codec === 'opus' ? 'opus' : null) : null;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target, fastStart: 'in-memory', firstTimestampBehavior: 'cross-track-offset',
      video: { codec: vKind, width: W, height: H },
      ...(aKind ? { audio: { codec: aKind, numberOfChannels: aCfg.numberOfChannels || 1, sampleRate: aCfg.sampleRate } } : {}),
    });
    let encErr = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (err) { encErr = err; } },
      error: (e) => { encErr = e; },
    });
    encoder.configure(cfg);

    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctxOpt = canvasOnCpu() ? { willReadFrequently: true } : undefined;
    const g = cv.getContext('2d', ctxOpt);
    const total = Math.max(1, Math.floor(((tMax - tMin) / 1000) * q.fps));
    const frameUs = 1e6 / q.fps;
    const fontPx = 15;
    let drawn = 0;
    const B = Math.max(1, batchFrames());
    // 並べる先: 交互にやるときは B 枚、従来は1枚
    const surfaces = [{ cv, g }];
    for (let j = 1; j < B; j++) {
      const c2 = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      surfaces.push({ cv: c2, g: c2.getContext('2d', ctxOpt) });
    }
    const renderFrame = async (k, g2) => {
      const t = tMin + (k * 1000) / q.fps;
      g2.fillStyle = '#000';
      g2.fillRect(0, 0, W, H);
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        const r0 = performance.now();
        const f = await tr.frameAt(t + 500 / q.fps); // 出力のコマの真ん中の時刻に一番近い元のコマを使う(コマの間隔による遅れを半分にする)
        const d0 = performance.now();
        diag.add('read', d0 - r0);
        const x0 = (i % lay.cols) * cellW;
        const y0 = Math.floor(i / lay.cols) * cellH;
        if (f) {
          const sw = f.displayWidth; const sh = f.displayHeight;
          const s = Math.min(cellW / sw, cellH / sh);
          g2.drawImage(f, x0 + (cellW - sw * s) / 2, y0 + (cellH - sh * s) / 2, sw * s, sh * s);
        }
        // カメラ名(左上)。見る画面と同じ、暗い地に白い文字
        const label = String(tr.label);
        const fs = Math.max(fontPx, Math.round(cellH * 0.045));
        g2.font = `900 ${fs}px Murecho, sans-serif`;
        g2.textAlign = 'left'; g2.textBaseline = 'middle';
        const bw = g2.measureText(label).width + fs * 1.2;
        g2.fillStyle = 'rgba(28, 28, 30, 0.82)';
        g2.fillRect(x0, y0, bw, fs * 1.9);
        g2.fillStyle = '#fff';
        g2.fillText(label, x0 + fs * 0.6, y0 + fs * 0.95);
        diag.add('draw', performance.now() - d0);
      }
    };
    const pushFrame = async (k, src) => {
      const vf = new VideoFrame(src, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs) });
      encoder.encode(vf, { keyFrame: k % (q.fps * 2) === 0 });
      vf.close();
      drawn++;
      diag.qs('encode', encoder.encodeQueueSize);
    };
    const drainTo = async (limit) => {
      const e0 = performance.now();
      while (encoder.encodeQueueSize > limit && !encErr) await new Promise((r) => setTimeout(r, 1));
      diag.add('encWait', performance.now() - e0);
    };
    for (let k0 = 0; k0 < total; k0 += B) {
      if (shouldCancel()) throw cancelled();
      if (encErr) throw encErr;
      const n = Math.min(B, total - k0);
      if (B === 1) {
        await renderFrame(k0, g);
        await pushFrame(k0, cv);
        await drainTo(4);
      } else {
        for (let j = 0; j < n; j++) await renderFrame(k0 + j, surfaces[j].g); // 読み出して並べる(まとめて)
        await drainTo(0); // 前の圧縮が終わるのを待ってから(圧縮が空いている間に読み出しを進めたので、待ちは短いはず)
        for (let j = 0; j < n; j++) await pushFrame(k0 + j, surfaces[j].cv); // 圧縮に渡す(まとめて)
      }
      const k = k0 + n - 1;
      if (Math.floor(k0 / B) % Math.max(1, Math.ceil(5 / B)) === 0) {
        const el = performance.now() - started;
        onProgress({ fraction: Math.min(0.97, (k + 1) / total), remainMs: Math.max(0, (el / (k + 1)) * (total - k - 1)) });
        await tick();
      }
    }
    await encoder.flush();
    if (encErr) throw encErr;

    // 音
    let hasAudio = false; let audioChunks = 0;
    if (aKind) {
      let lastA = -1;
      for (const seg of aCam) {
        if (shouldCancel()) throw cancelled();
        const p = await parseContainer(seg.blob);
        for (const c of p.audioChunks) {
          const wall = seg.t0 + (c.ts - p.meta.firstTs) / 1000; // 親機の時計での時刻(ミリ秒)
          const ts = Math.round((wall - tMin) * 1000);
          if (ts < 0 || ts <= lastA || wall > tMax) continue;
          const m = audioChunks === 0 ? { decoderConfig: { codec: aCfg.codec, description: fromBase64(aCfg.description), sampleRate: aCfg.sampleRate, numberOfChannels: aCfg.numberOfChannels || 1 } } : undefined;
          muxer.addAudioChunkRaw(c.data, 'key', ts, c.dur, m);
          lastA = ts; audioChunks++;
        }
      }
      hasAudio = audioChunks > 0;
    }
    muxer.finalize();
    onProgress({ fraction: 1, remainMs: 0 });
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const ms = Math.round(performance.now() - started);
    if (hiddenSince) { diag.hiddenMs += performance.now() - hiddenSince; hiddenSince = 0; }
    const avg = (k) => (diag.q[k] ? +(diag.q[k].sum / diag.q[k].n).toFixed(1) : 0);
    const mx = (k) => (diag.q[k] ? diag.q[k].max : 0);
    const r = (v) => Math.round(v);
    // 試験用の数値に出す内訳。read は readWait を含む。残り(other)は、進み具合の表示・音・MP4の仕上げなど
    const diagOut = {
      hw, encCfg: `${cfg.codec} ${W}x${H} ${q.fps}コマ ${Math.round(q.bitrate / 1000)}kbps`,
      readMs: r(diag.t.read), readWaitMs: r(diag.t.readWait), drawMs: r(diag.t.draw), encWaitMs: r(diag.t.encWait),
      otherMs: r(ms - diag.t.read - diag.t.draw - diag.t.encWait),
      decodeQ: { avg: avg('decode'), max: mx('decode') }, encodeQ: { avg: avg('encode'), max: mx('encode') },
      outFps: +(drawn / (ms / 1000)).toFixed(1),
      ahead: tracks[0].ahead, batch: batchFrames(), cvCpu: canvasOnCpu(), dec: tracks.map((t) => t.decHw).join('/'), hiddenMs: r(diag.hiddenMs),
    };
    return { blob, mime: 'video/mp4', ext: 'mp4', mode: 'fast', hasAudio, audioCam: aCam[0].label, videoCodec: cfg.codec, audioCodec: aKind ? aCfg.codec : '', width: W, height: H, fps: q.fps, frames: drawn, ms, diag: diagOut };
  } finally {
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch (err) { /* 無視 */ } }
    closeAll();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  }
}

// ---- 再生しながら録り直す(WebCodecs が使えない端末向け) ----
async function composeByReplay(store, take, cams, q, audioCam, { onProgress, shouldCancel }) {
  const started = performance.now();
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${q.boxW}px;height:${q.boxH}px;pointer-events:none;`;
  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:100%;';
  holder.appendChild(cv);
  document.body.appendChild(holder);
  const viewer = new LabViewer({ store, canvas: cv, onChange: () => {} });
  viewer.audioCamSetting = audioCam;
  viewer.pixelRatio = 1;
  let rec = null;
  let actx = null;
  try {
    await viewer.open(take.id);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const dest = Ctx ? (() => { actx = new Ctx(); return actx.createMediaStreamDestination(); })() : null;
    if (dest) viewer.audioOut = { ctx: actx, node: dest };
    await viewer.seek(viewer.tMin);
    const stream = cv.captureStream(q.fps);
    if (dest) dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mimes = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: q.bitrate });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);
    viewer.play();
    const total = viewer.tMax - viewer.tMin;
    while (viewer.playing) {
      if (shouldCancel()) throw cancelled();
      const done = Math.min(1, (viewer.t - viewer.tMin) / total);
      onProgress({ fraction: Math.min(0.97, done), remainMs: Math.max(0, viewer.tMax - viewer.t), replay: true });
      await new Promise((r) => setTimeout(r, 250));
    }
    rec.stop();
    await stopped;
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    onProgress({ fraction: 1, remainMs: 0 });
    return { blob: new Blob(parts, { type }), mime: type, ext, mode: 'replay', hasAudio: !!dest, audioCam: '', videoCodec: rec.mimeType || '', audioCodec: '', width: q.boxW, height: q.boxH, fps: q.fps, frames: 0, ms: Math.round(performance.now() - started) };
  } finally {
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (err) { /* 無視 */ }
    viewer.close();
    if (actx) { try { actx.close(); } catch (err) { /* 無視 */ } }
    holder.remove();
  }
}
