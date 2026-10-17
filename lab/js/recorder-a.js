// recorder-a.js: 方式A。ブラウザ標準の録画機能(MediaRecorder)で、1分ごとの動画ファイルに区切って残す。試作用。
// - 区切りの切れ目で映像が欠けないよう、次の録画を少し(既定1秒)早く始めて重ねる。重なりは見るときに取り除く
// - 1つのセグメントは、それだけで再生できる(各録画の先頭がキーフレーム)

// 順番の理由: 端末の専用回路で圧縮できる H.264 を先に(熱くなりにくい)。webm(Android・パソコンのChrome)を、
// mp4(iPhoneのSafari)より先に。どちらもだめなら vp8(ソフトウェア圧縮)
const MIME_CANDIDATES = [
  'video/webm;codecs=h264',
  'video/mp4;codecs=avc1.42E01E',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMimeA() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (err) { /* 次へ */ }
  }
  return '';
}

export function probeA() {
  const mime = pickMimeA();
  return mime ? { ok: true, mime } : { ok: false, reason: 'MediaRecorder が使えません' };
}

export class RecorderA {
  // onSegment({ seq, blob, mime, t0, durMs, fps }), onError(message)
  constructor(stream, { segMs = 60000, overlapMs = 1000, bitrate = 1000000, onSegment, onError, now = () => Date.now() } = {}) {
    this.stream = stream;
    this.segMs = segMs;
    this.overlapMs = Math.min(overlapMs, Math.floor(segMs / 4));
    this.bitrate = bitrate;
    this.onSegment = onSegment || (() => {});
    this.onError = onError || (() => {});
    this.now = now;
    this.mime = pickMimeA();
    this.running = false;
    this._active = new Map(); // seq -> { rec, chunks, t0, done: Promise }
    this._timers = [];
    this._pending = [];
    this._takeStart = 0;
  }

  start() {
    if (!this.mime) throw new Error('この端末では動画を録画できません');
    this.running = true;
    this._takeStart = performance.now();
    this._begin(0);
    this._scheduleNext(0);
  }

  _scheduleNext(k) {
    // 次の録画(k+1)は区切りの少し前に始め、いまの録画(k)は区切りの時刻に止める
    const startAt = (k + 1) * this.segMs - this.overlapMs;
    const stopAt = (k + 1) * this.segMs;
    const elapsed = () => performance.now() - this._takeStart;
    this._timers.push(setTimeout(() => {
      if (!this.running) return;
      this._begin(k + 1);
    }, Math.max(0, startAt - elapsed())));
    this._timers.push(setTimeout(() => {
      this._finish(k);
      if (this.running) this._scheduleNext(k + 1);
    }, Math.max(0, stopAt - elapsed())));
  }

  _begin(seq) {
    let rec;
    try {
      rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.bitrate });
    } catch (err) {
      this.onError(`録画を始められませんでした(${err && err.message ? err.message : err})`);
      return;
    }
    const entry = { rec, chunks: [], t0: 0, tStartPerf: 0, seq };
    entry.done = new Promise((resolve) => { entry.resolve = resolve; });
    rec.onstart = () => { entry.tStartEvent = this.now(); entry.tStartPerf = performance.now(); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) entry.chunks.push(e.data); };
    rec.onerror = (e) => this.onError(`録画でエラーが出ました(${e && e.error && e.error.message ? e.error.message : '不明'})`);
    rec.onstop = () => {
      // 開始の時刻は、start() を呼んだ時刻を使う。onstart の通知は、端末が忙しいと大きく遅れるため(2026-10-17の試験で確認)
      entry.t0 = entry.tCall;
      const durMs = Math.round(performance.now() - entry.tCallPerf);
      const blob = new Blob(entry.chunks, { type: this.mime.split(';')[0] });
      this._active.delete(seq);
      if (blob.size > 0) {
        const fps = (this.stream.getVideoTracks()[0] && this.stream.getVideoTracks()[0].getSettings().frameRate) || 30;
        this.onSegment({ seq, blob, mime: this.mime, t0: entry.t0, durMs, fps, meta: { startLagMs: entry.tStartEvent ? entry.tStartEvent - entry.tCall : null } });
      } else {
        this.onError('空の録画ができました(映像が届いていません)');
      }
      entry.resolve();
    };
    this._active.set(seq, entry);
    entry.tCall = this.now();
    entry.tCallPerf = performance.now();
    try { rec.start(); } catch (err) { this.onError(`録画を始められませんでした(${err && err.message ? err.message : err})`); }
  }

  _finish(seq) {
    const entry = this._active.get(seq);
    if (entry && entry.rec.state !== 'inactive') {
      try { entry.rec.stop(); } catch (err) { this.onError('録画を止められませんでした'); }
    }
    return entry ? entry.done : Promise.resolve();
  }

  // 録画を終える。最後の区切りが保存されるまで待つ
  async stop() {
    this.running = false;
    this._timers.forEach(clearTimeout);
    this._timers = [];
    const entries = [...this._active.values()].sort((a, b) => a.seq - b.seq);
    // 重なりのために先に始めていた次の録画は、中身がほぼ重なりだけなので、短すぎれば捨てる
    await Promise.all(entries.map((e) => {
      if (e.seq > 0 && entries.length > 1 && (!e.tStartPerf || performance.now() - e.tStartPerf < this.overlapMs + 300)) {
        e.discard = true;
        e.rec.onstop = () => e.resolve();
        try { e.rec.stop(); } catch (err) { /* 無視 */ }
        this._active.delete(e.seq);
        return e.done;
      }
      return this._finish(e.seq);
    }));
  }

  get active() { return this.running && [...this._active.values()].some((e) => e.rec.state === 'recording'); }
}
