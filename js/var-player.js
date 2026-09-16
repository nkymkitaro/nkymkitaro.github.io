// VARPlayer: 映像フレームのバッファリングと巻き戻し再生(VAR)を担当するクラス。
// CameraLink には依存せず、コンストラクタで受け取る getVideoElement() コールバック経由でのみ
// 「今どの映像を録画すべきか」を知る(疎結合)。
export class VARPlayer {
  constructor(canvas, getVideoElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.getVideoElement = getVideoElement;

    this.frameBuffer = [];
    this.MAX_FRAMES = 450; // 30fps × 15秒分をバッファ
    this.isReplay = false;
    this.isPlaying = false;
    this.replayIndex = 0;
    this.speedOptions = [0.25, 0.5, 1]; // 今後ここに追加するだけで速度を増やせる
    this.playbackSpeed = 0.5;
    this.replayTimer = null;

    this.seekBar = document.getElementById('seekBar');
    this.timeReadout = document.getElementById('timeReadout');
    this.playPauseBtn = document.getElementById('btnPlayPause');
    this.speedBtn = document.getElementById('btnSpeed');
    this.statusBadge = document.getElementById('statusBadge');

    this._captureLoop = this._captureLoop.bind(this);
  }

  start() {
    requestAnimationFrame(this._captureLoop);
  }

  clearBuffer() {
    this.frameBuffer.length = 0;
  }

  _captureLoop() {
    const video = this.getVideoElement();
    if (!this.isReplay && video && video.readyState === video.HAVE_ENOUGH_DATA) {
      this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      const frame = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.frameBuffer.push(frame);
      if (this.frameBuffer.length > this.MAX_FRAMES) this.frameBuffer.shift();
    }
    if (!this.isReplay) {
      requestAnimationFrame(this._captureLoop);
    }
  }

  rewind(seconds) {
    if (this.frameBuffer.length === 0) return;
    this.isReplay = true;
    const rewindFrames = Math.min(seconds * 30, this.frameBuffer.length - 1);
    this.replayIndex = this.frameBuffer.length - 1 - rewindFrames;
    this.statusBadge.innerHTML = `🎬&nbsp;VAR REPLAY (${this.playbackSpeed}x)`;
    this.statusBadge.className = 'badge bg-replay';
    this.seekBar.disabled = false;
    this._updateUI();
    this._startReplayLoop();
  }

  _startReplayLoop() {
    clearInterval(this.replayTimer);
    this.isPlaying = true;
    this._updatePlayPauseButton();
    const intervalMs = (1000 / 30) / this.playbackSpeed;
    this.replayTimer = setInterval(() => {
      if (!this.isReplay) return;
      if (this.replayIndex < this.frameBuffer.length) {
        this.ctx.putImageData(this.frameBuffer[this.replayIndex], 0, 0);
        this.replayIndex++;
        this._updateUI();
      } else {
        this.replayIndex = Math.max(0, Math.min(this.frameBuffer.length - 1, this.replayIndex));
        this.pause(); // 末尾まで再生したら自動停止
      }
    }, intervalMs);
  }

  pause() {
    clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.isPlaying = false;
    this._updatePlayPauseButton();
    this._updateUI();
  }

  play() {
    if (!this.isReplay) return;
    this._startReplayLoop();
  }

  togglePlayPause() {
    if (!this.isReplay) return;
    this.isPlaying ? this.pause() : this.play();
  }

  goLive() {
    this.isReplay = false;
    this.isPlaying = false;
    clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.statusBadge.innerHTML = '<span class="rec-dot"></span>LIVE 撮影中';
    this.statusBadge.className = 'badge bg-live';
    this.seekBar.disabled = true;
    this.seekBar.max = 0;
    this.seekBar.value = 0;
    this._updateUI();
    requestAnimationFrame(this._captureLoop);
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
    if (this.isReplay) {
      this.statusBadge.innerHTML = `🎬&nbsp;VAR REPLAY (${this.playbackSpeed}x)`;
    }
    if (this.isReplay && this.isPlaying) this._startReplayLoop();
    this._updateSpeedButton();
  }

  cycleSpeed() {
    const idx = this.speedOptions.indexOf(this.playbackSpeed);
    const next = this.speedOptions[(idx + 1) % this.speedOptions.length];
    this.setSpeed(next);
  }

  stepFrame(dir) {
    if (this.frameBuffer.length === 0) return; // まだ何も録画されていない
    if (!this.isReplay) this.rewind(0);
    this.pause();
    this.replayIndex = Math.max(0, Math.min(this.frameBuffer.length - 1, this.replayIndex + dir));
    this.ctx.putImageData(this.frameBuffer[this.replayIndex], 0, 0);
    this._updateUI();
  }

  onSeekInput(value) {
    if (!this.isReplay) return;
    this.pause();
    this.replayIndex = Math.max(0, Math.min(this.frameBuffer.length - 1, parseInt(value, 10)));
    if (this.frameBuffer[this.replayIndex]) {
      this.ctx.putImageData(this.frameBuffer[this.replayIndex], 0, 0);
    }
    this._updateUI();
  }

  _updateUI() {
    this.seekBar.max = Math.max(0, this.frameBuffer.length - 1);
    this.seekBar.value = this.replayIndex;
    if (!this.isReplay || this.frameBuffer.length === 0) {
      this.timeReadout.textContent = 'LIVE';
      this.timeReadout.classList.remove('is-replay');
    } else {
      const behindFrames = (this.frameBuffer.length - 1) - this.replayIndex;
      const behindSeconds = (behindFrames / 30).toFixed(1);
      this.timeReadout.textContent = behindFrames === 0 ? '最新フレーム' : `− ${behindSeconds}秒`;
      this.timeReadout.classList.add('is-replay');
    }
  }

  _updatePlayPauseButton() {
    this.playPauseBtn.innerHTML = this.isPlaying
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    this.playPauseBtn.setAttribute('aria-label', this.isPlaying ? '一時停止' : '再生');
  }

  _updateSpeedButton() {
    this.speedBtn.textContent = this.playbackSpeed + 'x';
  }
}
