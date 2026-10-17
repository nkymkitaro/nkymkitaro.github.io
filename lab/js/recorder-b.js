// recorder-b.js: 方式B。映像を1コマずつ取り出して自分で圧縮(WebCodecs)し、0.5秒ごとのキーフレーム付きで区切りに残す。試作用。
// - 方式Aと違い、区切りの切れ目に重なりが無い(同じ流れの途中でキーフレームを強制して切る)
// - 各コマの時刻を持つので、見返すときに「任意の時刻」へ素早く飛べて、コマ送りもしやすい
// - 区切りファイルの形(独自): [4バイト: 見出しの長さ][見出し(JSON)][コマのデータを順に並べたもの]

export const B_MIME = 'application/x-kvar-b';

const CODEC_CANDIDATES = [
  { codec: 'avc1.42001f', avc: { format: 'annexb' } },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

export async function pickConfigB(width = 640, height = 480, bitrate = 1000000, fps = 30) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const cand of CODEC_CANDIDATES) {
    const cfg = { ...cand, width, height, bitrate, framerate: fps, latencyMode: 'realtime' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return r.config || cfg;
    } catch (err) { /* 次へ */ }
  }
  return null;
}

export async function probeB() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return { ok: false, reason: 'この端末のブラウザには WebCodecs がありません' };
  const cfg = await pickConfigB();
  return cfg ? { ok: true, codec: cfg.codec } : { ok: false, reason: '使える圧縮方式が見つかりません' };
}

// ---- 区切りファイルの組み立てと読み出し ----
export function buildContainer(meta, chunkBytes) {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([len, head, ...chunkBytes], { type: B_MIME });
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
  return { meta, chunks };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export class RecorderB {
  // onSegment({ seq, blob, mime, t0, durMs, fps, meta }), onError(message)
  constructor(stream, { segMs = 60000, keyMs = 500, bitrate = 1000000, fps = 30, onSegment, onError, now = () => Date.now() } = {}) {
    this.stream = stream;
    this.segMs = segMs;
    this.keyMs = keyMs;
    this.bitrate = bitrate;
    this.fps = fps;
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
    this._stopped = null;
  }

  async start() {
    const track = this.stream.getVideoTracks()[0];
    const st = (track && track.getSettings()) || {};
    const width = st.width || 640;
    const height = st.height || 480;
    this.fps = Math.round(st.frameRate || this.fps) || 30;
    const cfg = await pickConfigB(width, height, this.bitrate, this.fps);
    if (!cfg) throw new Error('この端末では方式Bの圧縮が使えません');
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
    this._pump();
  }

  _pump() {
    const tick = () => {
      if (!this.running) return;
      this._grab();
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
      else setTimeout(tick, 1000 / this.fps);
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
    else setTimeout(tick, 1000 / this.fps);
  }

  _grab() {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    if (this.video.readyState < 2) return;
    const ts = Math.round((performance.now() - this._perf0) * 1000); // マイクロ秒
    if (this.encoder.encodeQueueSize > 8) { this.dropped++; return; }
    let frame;
    try { frame = new VideoFrame(this.video, { timestamp: ts }); } catch (err) { this.dropped++; return; }
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
    if (isKey && this._boundaries.length && chunk.timestamp >= this._boundaries[0]) {
      this._boundaries.shift();
      this._flushSegment();
      this._seg = { chunks: [], bytes: [], firstTs: chunk.timestamp, config: null };
      this._segStartTs = chunk.timestamp;
    }
    if (!this._seg) return; // 最初のキーフレームより前に出たコマ(無いはず)
    if (metadata && metadata.decoderConfig && !this._seg.config) {
      const dc = metadata.decoderConfig;
      this._seg.config = {
        codec: dc.codec,
        codedWidth: dc.codedWidth || this._config.width,
        codedHeight: dc.codedHeight || this._config.height,
        description: dc.description ? toBase64(new Uint8Array(dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer)) : null,
      };
    }
    this._seg.lastTs = chunk.timestamp;
    this._seg.chunks.push({ type: isKey ? 'key' : 'delta', ts: chunk.timestamp, dur: chunk.duration || Math.round(1000000 / this.fps), size: data.length });
    this._seg.bytes.push(data);
  }

  _flushSegment() {
    const seg = this._seg;
    this._seg = null;
    if (!seg || !seg.chunks.length) return;
    const config = seg.config || { codec: this._config.codec, codedWidth: this._config.width, codedHeight: this._config.height, description: null };
    const meta = { v: 1, fps: this.fps, config, firstTs: seg.firstTs, chunks: seg.chunks };
    const blob = buildContainer(meta, seg.bytes);
    const durMs = Math.round((seg.lastTs - seg.firstTs) / 1000 + 1000 / this.fps);
    const t0 = Math.round(this._wall0 + seg.firstTs / 1000);
    this.onSegment({ seq: this._seq++, blob, mime: B_MIME, t0, durMs, fps: this.fps, meta: { codec: config.codec, frames: seg.chunks.length } });
  }

  async stop() {
    if (!this.running && !this.encoder) return;
    this.running = false;
    try { if (this.encoder && this.encoder.state === 'configured') await this.encoder.flush(); } catch (err) { /* 無視 */ }
    this._flushSegment();
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (err) { /* 無視 */ }
    this.encoder = null;
    if (this.video) { this.video.srcObject = null; this.video = null; }
  }

  get active() { return this.running; }
}
