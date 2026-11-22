import { diagOn, diagSet, diagAdd, diagTime } from './diag.js';
// MultiCamRecorder: 接続中の全カメラの映像を、常にバックグラウンドで
// 直近 durationSec 秒ぶんだけ録画し続けるクラス。
//
// 「4台同時に録画してもメモリを圧迫しない」ようにするため、生のImageDataではなく
// 縮小した映像をJPEGに圧縮したBlobとして保持する。Blobは圧縮されたバイト列のまま
// 保持され、実際にコマとして描画するときだけ ReplayPlayer 側でデコードする。
// 自動の下げの段(幅px)。設定の幅より小さいものだけを順に使う
const AUTO_STEPS = [1920, 1280, 640, 320];
const AUTO_MIN_SAMPLES = 15; // 下げた直後は、新しい大きさの写真がこの枚数たまるまで、次の判断をしない
export class MultiCamRecorder {
  constructor({ fps = 15, durationSec = 15, width = 320, quality = 0.6 } = {}) {
    this.fps = fps;
    this.maxFrames = fps * durationSec;
    this.durationSec = durationSec;
    this.width = width;
    this.quality = quality;
    this.cams = new Map(); // id -> { label, getVideoEl, canvas, ctx, frames: [{ts, blob}], paused, dropped }
    this.timer = null;
    // VARで見返している間は、古いコマを捨てない(捨てるとコマ番号がずれて、見ている場面が勝手に進むため)。
    // 新しいコマは追加し続け、増えすぎないよう holdExtraSec 秒ぶんまでは持つ。LIVEに戻ったら切り詰める
    this.holding = false;
    this.holdExtraSec = 60;
    // VARの自動の下げ(2026-11-18): ためる量の見込み(最近の写真の大きさの平均 × 持つコマ数 × 台数)が
    // memCapBytes を超えるときだけ、写真の幅を1段ずつ下げる。ライブの表示・録画・ディレイは変えない。
    // memCapBytes が 0 のときは何もしない。下げたとき onAutoDowngrade({ width, estBytes, capBytes }) を呼ぶ
    this.memCapBytes = 0;
    this.autoCapWidth = 0; // 0 = 下げていない。それ以外は、写真の幅の上限(px)
    this.onAutoDowngrade = null;
    // 負荷の目安(2026-11-22): 写真を撮ろうとした回数・圧縮が間に合わず飛ばした回数・圧縮にかかった時間。app.js が1秒ごとに読んで0に戻す
    this.load = { tries: 0, skipped: 0, encMs: 0, encN: 0 };
  }

  // 実際に使う幅(設定の幅と、自動の下げの小さいほう)
  effectiveWidth() {
    return this.autoCapWidth ? Math.min(this.width, this.autoCapWidth) : this.width;
  }

  // ためる量の見込み(バイト)。VAR中の追加ぶんも含めた最大。最近の写真が足りないカメラは数えない
  estimateBytes() {
    const frames = this.fps * (this.durationSec + this.holdExtraSec);
    let total = 0;
    for (const cam of this.cams.values()) {
      const r = cam.recentBytes;
      if (!r || r.length < AUTO_MIN_SAMPLES) continue;
      total += (r.reduce((a, b) => a + b, 0) / r.length) * frames;
    }
    return total;
  }

  // 設定(画質・秒数)を変えたときなど、自動の下げを解いて、見込みを取り直す
  resetAutoCap() {
    this.autoCapWidth = 0;
    for (const cam of this.cams.values()) cam.recentBytes = [];
  }

  _checkMemory() {
    if (!this.memCapBytes) return;
    const est = this.estimateBytes();
    if (est <= this.memCapBytes) return;
    const cur = this.effectiveWidth();
    const next = AUTO_STEPS.find((w) => w < cur);
    if (!next) return; // これ以上は下げない(320px)
    this.autoCapWidth = next;
    for (const cam of this.cams.values()) cam.recentBytes = []; // 新しい大きさで取り直す
    if (this.onAutoDowngrade) this.onAutoDowngrade({ width: next, estBytes: est, capBytes: this.memCapBytes });
  }

  // 今持ってよいコマ数の上限(VAR中は holdExtraSec 秒ぶん多く持つ)
  _limit() {
    return this.maxFrames + (this.holding ? this.fps * this.holdExtraSec : 0);
  }

  // 上限を超えたぶんを古い順に捨てる。捨てた数は dropped に足す(再生側がコマ番号を合わせ直すため)
  _trim(cam) {
    // 数(枚数)だけでなく、時間でも古いコマを捨てる。圧縮が間に合わずコマを飛ばしたとき、
    // 枚数だけで切ると、決めた長さより長くためてしまうため(2026-11-03)
    const keepMs = (this.durationSec + (this.holding ? this.holdExtraSec : 0) + 1) * 1000;
    const cutoff = performance.now() - keepMs;
    let old = 0;
    while (old < cam.frames.length && cam.frames[old].ts < cutoff) old++;
    const over = Math.max(old, cam.frames.length - this._limit());
    if (over > 0) {
      cam.frames.splice(0, over);
      cam.dropped += over;
    }
  }

  // VARに入った: 古いコマを捨てるのを止める
  hold() {
    this.holding = true;
  }

  // LIVEに戻った: 既定の長さに切り詰める
  release() {
    this.holding = false;
    for (const cam of this.cams.values()) this._trim(cam);
  }

  // これまでに古い順に捨てたコマの数(カメラごと)。再生側はこれでコマ番号を合わせ直す
  getDropped(id) {
    const cam = this.cams.get(id);
    return cam ? cam.dropped : 0;
  }

  registerCamera(id, label, getVideoEl) {
    if (this.cams.has(id)) return;
    const canvas = document.createElement('canvas');
    this.cams.set(id, {
      label,
      getVideoEl,
      canvas,
      ctx: canvas.getContext('2d'),
      frames: [],
      recentBytes: [], // 最近の写真の大きさ(自動の下げの判断用。直近30枚)
      paused: false,
      dropped: 0,
    });
  }

  listCameraIds() {
    return [...this.cams.keys()];
  }

  pauseCamera(id) {
    const cam = this.cams.get(id);
    if (cam) cam.paused = true; // 切断されたカメラの録画だけ止める(バッファは残す)
  }

  resumeCamera(id) {
    const cam = this.cams.get(id);
    if (cam) cam.paused = false;
  }

  // 完全に切断されて二度と使わないカメラのバッファを解放する
  unregisterCamera(id) {
    this.cams.delete(id);
  }

  // 裏録画バッファの長さ(秒)を変更する。短くした場合は超過分をすぐ切り詰める。
  setDurationSec(durationSec) {
    this.durationSec = durationSec;
    this.maxFrames = this.fps * durationSec;
    for (const cam of this.cams.values()) this._trim(cam);
  }

  // 録画する映像の幅(px)とJPEG品質を変更する。次の撮影サイクルから反映される。
  setQuality(width, quality, maxEdge = 0) {
    this.width = width;
    this.maxEdge = maxEdge; // 長い辺の上限(0なら上限なし)。「最大」で、縦持ち・横持ちとも同じ重さにするため
    this.quality = quality;
  }

  // ディレイ(動画方式)の間は、写真をためない(CPUと熱を減らす)。止めるときは、ためた写真も捨てる(あとで古い場面が混ざらないように)
  setSuspended(on) {
    this.suspended = on;
    if (on) for (const cam of this.cams.values()) cam.frames.length = 0;
  }

  // ディレイ中にVARを押したとき、ためてある動画から作った写真を、そのカメラのコマとして入れる
  injectFrames(id, frames) {
    const cam = this.cams.get(id);
    if (cam) cam.frames = frames;
  }

  start() {
    if (this.timer) return;
    const intervalMs = 1000 / this.fps;
    this.timer = setInterval(() => this._captureAll(), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  getFrames(id) {
    const cam = this.cams.get(id);
    return cam ? cam.frames : [];
  }

  getLabel(id) {
    const cam = this.cams.get(id);
    return cam ? cam.label : '';
  }

  _captureAll() {
    if (this.suspended) return;
    const now = performance.now();
    for (const cam of this.cams.values()) {
      if (cam.paused) continue;
      const video = cam.getVideoEl();
      if (!video || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) continue;

      // 元の映像より大きくは引き伸ばさない(「高」「最大」で、小さい映像の写真がむだに大きくならないように)
      let scale = Math.min(1, this.effectiveWidth() / video.videoWidth);
      if (this.maxEdge) scale = Math.min(scale, this.maxEdge / Math.max(video.videoWidth, video.videoHeight));
      const outW = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (cam.canvas.width !== outW || cam.canvas.height !== height) {
        cam.canvas.width = outW;
        cam.canvas.height = height;
      }
      // 前の写真の圧縮が終わっていないときは、このコマは飛ばす(「高」「最大」で圧縮が間に合わないと、
      // 待ちが積み上がって、メモリが増え、画面が固まるため。2026-11-03)
      this.load.tries++;
      if (cam.encoding && now - cam.encodingSince < 1500) { this.load.skipped++; diagAdd('写真を飛ばした回数'); continue; } // 1.5秒たっても終わらないときは、取りこぼしとして続ける
      cam.encoding = true;
      cam.encodingSince = now;
      const t0 = performance.now();
      cam.ctx.drawImage(video, 0, 0, outW, height);
      cam.canvas.toBlob(
        (blob) => {
          cam.encoding = false;
          this.load.encMs += performance.now() - t0; this.load.encN++;
          if (!blob) return;
          cam.frames.push({ ts: now, blob });
          cam.recentBytes.push(blob.size);
          if (cam.recentBytes.length > 30) cam.recentBytes.shift();
          this._trim(cam);
          this._checkMemory();
          if (diagOn) {
            diagTime('写真の圧縮ms', performance.now() - t0);
            diagSet('写真の大きさ', `${outW}x${height}`);
            diagSet('写真1枚KB(直近)', Math.round(blob.size / 1024));
            diagSet(`写真の枚数 ${cam.label || ''}`, cam.frames.length);
          }
        },
        'image/jpeg',
        this.quality
      );
    }
  }
}
