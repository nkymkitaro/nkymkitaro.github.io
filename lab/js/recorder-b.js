// recorder-b.js: 映像を1コマずつ取り出して自分で圧縮(WebCodecs)し、0.5秒ごとのキーフレーム付きで区切りに残す。試作用。
// - 区切りの切れ目に重なりが無い(同じ流れの途中でキーフレームを強制して切る)
// - 各コマの時刻を持つので、見返すときに「任意の時刻」へ素早く飛べて、コマ送りもしやすい
// - 音も同じ時計(performance.now)で圧縮して、同じ区切りに入れる。保存のときに、区切りをつなぐだけでMP4にできる
//   (映像 H.264 と 音 AAC が使えない端末では、使える方式に落とす。使えるものが無ければ録画の方式Aに切り替える)
// - 区切りファイル(独自): [4バイト: 見出しの長さ][見出し(JSON)][映像のデータを順に並べたもの][音のデータを順に並べたもの]

export const B_MIME = 'application/x-kvar-b';

// MP4に入れられる圧縮方式だけを使う(VP8はMP4に入らないため使わない)
const VIDEO_CANDIDATES = [
  { codec: 'avc1.42001f', avc: { format: 'avc' } },
  { codec: 'avc1.420028', avc: { format: 'avc' } },
  { codec: 'vp09.00.10.08' },
];
const AUDIO_CANDIDATES = ['mp4a.40.2', 'opus'];

export async function pickConfigB(width = 640, height = 480, bitrate = 1000000, fps = 30) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const cand of VIDEO_CANDIDATES) {
    const cfg = { ...cand, width, height, bitrate, framerate: fps, latencyMode: 'realtime' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return { ...cfg, ...(r.config || {}) };
    } catch (err) { /* 次へ */ }
  }
  return null;
}

export async function pickAudioConfig(sampleRate = 48000, channels = 1, bitrate = 96000) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  for (const codec of AUDIO_CANDIDATES) {
    const cfg = { codec, sampleRate, numberOfChannels: channels, bitrate };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r && r.supported) return { ...cfg, ...(r.config || {}) };
    } catch (err) { /* 次へ */ }
  }
  return null;
}

export async function probeB() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return { ok: false, reason: 'この端末のブラウザには WebCodecs がありません' };
  const cfg = await pickConfigB();
  if (!cfg) return { ok: false, reason: 'MP4にできる圧縮方式(H.264など)が使えません' };
  const a = await pickAudioConfig();
  return { ok: true, codec: cfg.codec, audio: a ? a.codec : null };
}

// ---- 区切りファイルの組み立てと読み出し ----
export function buildContainer(meta, videoBytes, audioBytes = []) {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([len, head, ...videoBytes, ...audioBytes], { type: B_MIME });
}

export async function parseContainer(blob) {
  const lenBuf = await blob.slice(0, 4).arrayBuffer();
  const headLen = new DataView(lenBuf).getUint32(0, true);
  const headBuf = await blob.slice(4, 4 + headLen).arrayBuffer();
  const meta = JSON.parse(new TextDecoder().decode(headBuf));
  const body = await blob.slice(4 + headLen).arrayBuffer();
  let offset = 0;
  const chunks = meta.chunks.map((c) => {
    const data = new Uint8Array(body, offset, c.size);
    offset += c.size;
    return { ...c, data };
  });
  const audioChunks = ((meta.audio && meta.audio.chunks) || []).map((c) => {
    const data = new Uint8Array(body, offset, c.size);
    offset += c.size;
    return { ...c, data };
  });
  return { meta, chunks, audioChunks };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
const descToBase64 = (d) => (d ? toBase64(new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))) : null);

// マイクの音を一定の大きさのかたまりで受け取る(AudioWorklet。音量や形は変えない)
const WORKLET_SRC = `
class KvarPcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.t0 = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const ch = inp.length, len = inp[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += inp[c][i];
      if (this.n === 0) this.t0 = currentTime + i / sampleRate;
      this.buf[this.n++] = s / ch;
      if (this.n === this.buf.length) { this.port.postMessage({ pcm: this.buf.slice(0), t: this.t0 }); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('kvar-pcm', KvarPcm);`;

export class RecorderB {
  // onSegment({ seq, blob, mime, t0, durMs, fps, meta }), onError(message)
  // audioTrack: マイクの音のトラック(無ければ映像だけ)
  constructor(stream, { segMs = 60000, keyMs = 500, bitrate = 1000000, fps = 30, audioTrack = null, onSegment, onError, now = () => Date.now() } = {}) {
    this.stream = stream;
    this.segMs = segMs;
    this.keyMs = keyMs;
    this.bitrate = bitrate;
    this.fps = fps;
    this.audioTrack = audioTrack;
    this.onSegment = onSegment || (() => {});
    this.onError = onError || (() => {});
    this.now = now;
    this.running = false;
    this.encoder = null;
    this.video = null;
    this.dropped = 0;
    this.encodedFrames = 0;
    this._boundaries = []; // 次の区切りを始める映像時刻(マイクロ秒)
    this._seg = null;
    this._seq = 0;
    this._lastKeyTs = -Infinity;
    this._segStartTs = 0;
    this._config = null;
    this._vDesc = null; // 映像の設定(最初の1回だけ出てくる)。全部の区切りに付ける
    this.audio = { ok: false, codec: '', reason: '', chunks: 0, dropped: 0, resyncs: 0, sampleRate: 0, latencyMs: null, settings: null };
    this._aq = []; // 圧縮済みで、まだどの区切りにも入れていない音
    this._aCfg = null;
    this._aDesc = null;
  }

  async start() {
    const track = this.stream.getVideoTracks()[0];
    const st = (track && track.getSettings()) || {};
    const width = st.width || 640;
    const height = st.height || 480;
    this.fps = Math.round(st.frameRate || this.fps) || 30;
    const cfg = await pickConfigB(width, height, this.bitrate, this.fps);
    if (!cfg) throw new Error('この端末では、MP4にできる圧縮が使えません');
    this._config = cfg;
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this._onChunk(chunk, metadata),
      error: (e) => this.onError(`圧縮でエラーが出ました(${e && e.message ? e.message : e})`),
    });
    this.encoder.configure(cfg);

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});

    this.running = true;
    this._wall0 = this.now();
    this._perf0 = performance.now();
    this._lastKeyTs = -Infinity;
    this._boundaries = [0];
    this._seq = 0;
    await this._startAudio();
    this._pump();
  }

  // ---- 音 ----
  async _startAudio() {
    const a = this.audio;
    if (!this.audioTrack) { a.reason = 'マイクが使えません'; return; }
    try {
      a.settings = this.audioTrack.getSettings ? this.audioTrack.getSettings() : null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._actx = new Ctx({ latencyHint: 'interactive' });
      if (this._actx.state === 'suspended') await this._actx.resume().catch(() => {});
      const sr = Math.round(this._actx.sampleRate);
      const acfg = await pickAudioConfig(sr, 1);
      if (!acfg) { a.reason = 'この端末では、音を圧縮できません(AACもOpusも使えません)'; this._closeAudioCtx(); return; }
      this._aCfg = acfg;
      a.codec = acfg.codec; a.sampleRate = sr;
      this._aenc = new AudioEncoder({
        output: (chunk, metadata) => this._onAudioChunk(chunk, metadata),
        error: (e) => this.onError(`音の圧縮でエラーが出ました(${e && e.message ? e.message : e})`),
      });
      this._aenc.configure(acfg);
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      try { await this._actx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this._src = this._actx.createMediaStreamSource(new MediaStream([this.audioTrack]));
      this._node = new AudioWorkletNode(this._actx, 'kvar-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      const mute = this._actx.createGain();
      mute.gain.value = 0; // 動かし続けるために出力へつなぐ。音は出さない
      this._src.connect(this._node); this._node.connect(mute); mute.connect(this._actx.destination);
      this._aSamples = 0; this._aBase = null; this._aWin = [];
      const lat = a.settings && Number(a.settings.latency);
      this._aLatencyMs = Number.isFinite(lat) && lat > 0 && lat < 0.25 ? lat * 1000 : 0;
      a.latencyMs = this._aLatencyMs || null;
      this._node.port.onmessage = (e) => this._onPcm(e.data);
      a.ok = true;
    } catch (err) {
      a.ok = false; a.reason = `音を録れませんでした(${err && err.message ? err.message : err})`;
      this._closeAudioCtx();
    }
  }

  _closeAudioCtx() {
    try { if (this._node) { this._node.port.onmessage = null; this._node.disconnect(); } } catch (e) { /* 無視 */ }
    try { if (this._src) this._src.disconnect(); } catch (e) { /* 無視 */ }
    try { if (this._actx && this._actx.state !== 'closed') this._actx.close(); } catch (e) { /* 無視 */ }
    this._node = null; this._src = null; this._actx = null;
  }

  _onPcm({ pcm, t }) {
    if (!this.running || !this._aenc || this._aenc.state !== 'configured') return;
    // 音の時計(AudioContext)と、映像の時計(performance.now)の差。メッセージが遅れる分は足し算にしかならないので、直近10秒のいちばん小さい値を採る
    const nowP = performance.now();
    const c = nowP - this._actx.currentTime * 1000;
    const bucket = Math.floor(nowP / 1000);
    const last = this._aWin[this._aWin.length - 1];
    if (last && last.b === bucket) { if (c < last.c) last.c = c; } else this._aWin.push({ b: bucket, c });
    while (this._aWin.length && this._aWin[0].b < bucket - 10) this._aWin.shift();
    let clock = Infinity;
    for (const w of this._aWin) if (w.c < clock) clock = w.c;
    const actual = clock + t * 1000 - this._aLatencyMs; // このかたまりの時刻(performance.now のミリ秒)
    if (this._aBase == null) this._aBase = actual;
    let startMs = this._aBase + (this._aSamples / this.audio.sampleRate) * 1000; // 普段は、サンプル数から決める(時刻が滑らかにつながる)
    if (Math.abs(actual - startMs) > 40) { this._aBase += actual - startMs; startMs = actual; this.audio.resyncs++; } // 機器の時計のずれが溜まったら、合わせ直す
    const ts = Math.round((startMs - this._perf0) * 1000);
    if (ts < 0) { this._aSamples += pcm.length; this.audio.dropped++; return; } // 録画を始める前の音は捨てる
    if (this._aenc.encodeQueueSize > 40) { this._aSamples += pcm.length; this.audio.dropped++; return; }
    try {
      const data = new AudioData({ format: 'f32-planar', sampleRate: this.audio.sampleRate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: ts, data: pcm });
      this._aenc.encode(data);
      data.close();
    } catch (err) { this.audio.dropped++; }
    this._aSamples += pcm.length;
  }

  _onAudioChunk(chunk, metadata) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (metadata && metadata.decoderConfig && !this._aDesc) {
      const dc = metadata.decoderConfig;
      this._aDesc = { codec: dc.codec || this._aCfg.codec, sampleRate: dc.sampleRate || this._aCfg.sampleRate, numberOfChannels: dc.numberOfChannels || 1, description: descToBase64(dc.description) };
    }
    this.audio.chunks++;
    this._aq.push({ ts: chunk.timestamp, dur: chunk.duration || Math.round((1024 / this._aCfg.sampleRate) * 1e6), size: data.length, data });
  }

  // ---- 映像 ----
  _pump() {
    const tick = (now, metadata) => {
      if (!this.running) return;
      this._grab(metadata);
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
      else setTimeout(tick, 1000 / this.fps);
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
    else setTimeout(tick, 1000 / this.fps);
  }

  _grab(metadata) {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    if (this.video.readyState < 2) return;
    // カメラが映像を撮った時刻が分かれば、それを使う(音との時刻合わせのため)。分からなければ、いまの時刻
    const nowP = performance.now();
    let at = nowP;
    const cap = metadata && metadata.captureTime;
    if (Number.isFinite(cap) && cap > nowP - 400 && cap <= nowP + 5) at = cap;
    const ts = Math.max(0, Math.round((at - this._perf0) * 1000)); // マイクロ秒
    if (ts <= (this._lastTs ?? -1)) return; // 時刻が戻る・同じ(同じコマを2回)ときは捨てる
    if (this.encoder.encodeQueueSize > 8) { this.dropped++; return; }
    let frame;
    try { frame = new VideoFrame(this.video, { timestamp: ts }); } catch (err) { this.dropped++; return; }
    this._lastTs = ts;
    let key = false;
    if (ts - this._segStartTs >= this.segMs * 1000 && this._boundaries.length === 0 && this._seg) {
      this._boundaries.push(ts); // 区切りの時間が来た。次のキーフレームから新しい区切りにする
      key = true;
    } else if (ts - this._lastKeyTs >= this.keyMs * 1000 - 20000) {
      key = true;
    }
    if (key) this._lastKeyTs = ts;
    try { this.encoder.encode(frame, { keyFrame: key }); this.encodedFrames++; } catch (err) { this.onError('圧縮に失敗しました'); }
    frame.close();
  }

  _onChunk(chunk, metadata) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const isKey = chunk.type === 'key';
    if (metadata && metadata.decoderConfig && !this._vDesc) {
      const dc = metadata.decoderConfig;
      this._vDesc = {
        codec: dc.codec,
        codedWidth: dc.codedWidth || this._config.width,
        codedHeight: dc.codedHeight || this._config.height,
        description: descToBase64(dc.description),
      };
    }
    if (isKey && this._boundaries.length && chunk.timestamp >= this._boundaries[0]) {
      this._boundaries.shift();
      this._flushSegment(chunk.timestamp);
      this._seg = { chunks: [], bytes: [], firstTs: chunk.timestamp };
      this._segStartTs = chunk.timestamp;
    }
    if (!this._seg) return; // 最初のキーフレームより前に出たコマ(無いはず)
    this._seg.lastTs = chunk.timestamp;
    this._seg.chunks.push({ type: isKey ? 'key' : 'delta', ts: chunk.timestamp, dur: chunk.duration || Math.round(1000000 / this.fps), size: data.length });
    this._seg.bytes.push(data);
  }

  // boundaryTs: 次の区切りの先頭の時刻。これより前の音を、この区切りに入れる(省略すると、残りを全部入れる)
  _flushSegment(boundaryTs) {
    const seg = this._seg;
    this._seg = null;
    if (!seg || !seg.chunks.length) return;
    const config = this._vDesc || { codec: this._config.codec, codedWidth: this._config.width, codedHeight: this._config.height, description: null };
    const aChunks = []; const aBytes = [];
    let rest = this._aq;
    if (boundaryTs != null) {
      rest = [];
      for (const a of this._aq) { if (a.ts < boundaryTs) aChunks.push({ ts: a.ts, dur: a.dur, size: a.size }); else rest.push(a); }
      this._aq.filter((a) => a.ts < boundaryTs).forEach((a) => aBytes.push(a.data));
    } else {
      this._aq.forEach((a) => { aChunks.push({ ts: a.ts, dur: a.dur, size: a.size }); aBytes.push(a.data); });
      rest = [];
    }
    this._aq = rest;
    const meta = { v: 2, fps: this.fps, config, firstTs: seg.firstTs, chunks: seg.chunks };
    if (this._aDesc) meta.audio = { config: this._aDesc, chunks: aChunks };
    const blob = buildContainer(meta, seg.bytes, aBytes);
    const durMs = Math.round((seg.lastTs - seg.firstTs) / 1000 + 1000 / this.fps);
    const t0 = Math.round(this._wall0 + seg.firstTs / 1000);
    this.onSegment({ seq: this._seq++, blob, mime: B_MIME, t0, durMs, fps: this.fps, meta: { codec: config.codec, frames: seg.chunks.length, audio: this._aDesc ? this._aDesc.codec : '', audioChunks: aChunks.length } });
  }

  async stop() {
    if (!this.running && !this.encoder) return;
    this.running = false;
    try { if (this._aenc && this._aenc.state === 'configured') await this._aenc.flush(); } catch (err) { /* 無視 */ }
    try { if (this.encoder && this.encoder.state === 'configured') await this.encoder.flush(); } catch (err) { /* 無視 */ }
    this._flushSegment();
    try { if (this._aenc && this._aenc.state !== 'closed') this._aenc.close(); } catch (err) { /* 無視 */ }
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (err) { /* 無視 */ }
    this._aenc = null;
    this.encoder = null;
    this._closeAudioCtx();
    if (this.video) { this.video.srcObject = null; this.video = null; }
  }

  get active() { return this.running; }
}
