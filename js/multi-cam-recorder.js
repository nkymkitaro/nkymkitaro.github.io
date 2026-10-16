// MultiCamRecorder: 接続中の全カメラの映像を、常にバックグラウンドで
// 直近 durationSec 秒ぶんだけ録画し続けるクラス。
//
// 「4台同時に録画してもメモリを圧迫しない」ようにするため、生のImageDataではなく
// 縮小した映像をJPEGに圧縮したBlobとして保持する。Blobは圧縮されたバイト列のまま
// 保持され、実際にコマとして描画するときだけ ReplayPlayer 側でデコードする。
export class MultiCamRecorder {
  constructor({ fps = 15, durationSec = 15, width = 320, quality = 0.6 } = {}) {
    this.fps = fps;
    this.maxFrames = fps * durationSec;
    this.width = width;
    this.quality = quality;
    this.cams = new Map(); // id -> { label, getVideoEl, canvas, ctx, frames: [{ts, blob}], paused, dropped }
    this.timer = null;
    // VARで見返している間は、古いコマを捨てない(捨てるとコマ番号がずれて、見ている場面が勝手に進むため)。
    // 新しいコマは追加し続け、増えすぎないよう holdExtraSec 秒ぶんまでは持つ。LIVEに戻ったら切り詰める
    this.holding = false;
    this.holdExtraSec = 60;
  }

  // 今持ってよいコマ数の上限(VAR中は holdExtraSec 秒ぶん多く持つ)
  _limit() {
    return this.maxFrames + (this.holding ? this.fps * this.holdExtraSec : 0);
  }

  // 上限を超えたぶんを古い順に捨てる。捨てた数は dropped に足す(再生側がコマ番号を合わせ直すため)
  _trim(cam) {
    const over = cam.frames.length - this._limit();
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
    this.maxFrames = this.fps * durationSec;
    for (const cam of this.cams.values()) this._trim(cam);
  }

  // 録画する映像の幅(px)とJPEG品質を変更する。次の撮影サイクルから反映される。
  setQuality(width, quality) {
    this.width = width;
    this.quality = quality;
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
    const now = performance.now();
    for (const cam of this.cams.values()) {
      if (cam.paused) continue;
      const video = cam.getVideoEl();
      if (!video || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) continue;

      const scale = this.width / video.videoWidth;
      const height = Math.round(video.videoHeight * scale);
      if (cam.canvas.width !== this.width || cam.canvas.height !== height) {
        cam.canvas.width = this.width;
        cam.canvas.height = height;
      }
      cam.ctx.drawImage(video, 0, 0, this.width, height);
      cam.canvas.toBlob(
        (blob) => {
          if (!blob) return;
          cam.frames.push({ ts: now, blob });
          this._trim(cam);
        },
        'image/jpeg',
        this.quality
      );
    }
  }
}
