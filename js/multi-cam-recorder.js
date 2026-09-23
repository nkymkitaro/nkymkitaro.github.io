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
    this.cams = new Map(); // id -> { label, getVideoEl, canvas, ctx, frames: [{ts, blob}], paused }
    this.timer = null;
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
          while (cam.frames.length > this.maxFrames) cam.frames.shift();
        },
        'image/jpeg',
        this.quality
      );
    }
  }
}
