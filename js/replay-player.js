// ReplayPlayer: MultiCamRecorder に貯まった「複数カメラぶんの録画バッファ」を使って、
// 巻き戻し・コマ送り・速度変更・別アングルへの切り替えを担当するクラス。
// ライブ中は選択中カメラの映像をそのまま描画し(startLiveLoop)、
// リプレイ中は録画バッファから該当コマをデコードして描画する。
async function blobToDrawable(blob) {
  if (window.createImageBitmap) {
    return await createImageBitmap(blob);
  }
  // createImageBitmap非対応ブラウザ向けの保険
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

export class ReplayPlayer {
  constructor(canvas, recorder) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.recorder = recorder;

    this.isReplay = false;
    this.isPlaying = false;
    this.currentCamId = null;
    this.frameIndex = 0;
    this.speedOptions = [0.25, 0.5, 1];
    this.playbackSpeed = 0.5;
    this.replayTimer = null;
    this._renderToken = 0;
    this._liveLoopStarted = false;

    this.seekBar = document.getElementById('seekBar');
    this.timeReadout = document.getElementById('timeReadout');
    this.playPauseBtn = document.getElementById('btnPlayPause');
    this.speedBtn = document.getElementById('btnSpeed');
    this.statusBadge = document.getElementById('statusBadge');
  }

  // ライブ中は録画バッファとは別に、選択中カメラの映像をそのまま描画し続ける
  startLiveLoop(getActiveVideoEl) {
    if (this._liveLoopStarted) return;
    this._liveLoopStarted = true;
    const loop = () => {
      if (!this.isReplay) {
        const video = getActiveVideoEl();
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
          this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  rewind(seconds, camId) {
    const frames = this.recorder.getFrames(camId);
    if (frames.length === 0) return false;

    this.isReplay = true;
    this.currentCamId = camId;
    const rewindCount = Math.min(Math.round(seconds * this.recorder.fps), frames.length - 1);
    this.frameIndex = frames.length - 1 - rewindCount;

    this.statusBadge.innerHTML = `🎬&nbsp;VAR REPLAY (${this.playbackSpeed}x)`;
    this.statusBadge.className = 'badge bg-replay';
    this.seekBar.disabled = false;

    this._renderCurrentFrame();
    this._startPlaybackLoop();
    return true;
  }

  // リプレイ中に別のカメラへ切り替える。同じ瞬間(タイムスタンプ)に一番近いコマを探して表示する。
  switchAngle(camId) {
    if (!this.isReplay) return false;
    const oldFrames = this.recorder.getFrames(this.currentCamId);
    const newFrames = this.recorder.getFrames(camId);
    if (newFrames.length === 0) return false;

    const anchor = oldFrames[this.frameIndex];
    const targetTs = anchor ? anchor.ts : newFrames[newFrames.length - 1].ts;

    let nearestIndex = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < newFrames.length; i++) {
      const diff = Math.abs(newFrames[i].ts - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearestIndex = i;
      }
    }

    this.currentCamId = camId;
    this.frameIndex = nearestIndex;
    this._renderCurrentFrame();
    return true;
  }

  _startPlaybackLoop() {
    clearInterval(this.replayTimer);
    this.isPlaying = true;
    this._updatePlayPauseButton();
    const intervalMs = (1000 / this.recorder.fps) / this.playbackSpeed;
    this.replayTimer = setInterval(() => {
      const frames = this.recorder.getFrames(this.currentCamId);
      if (this.frameIndex < frames.length - 1) {
        this.frameIndex++;
        this._renderCurrentFrame();
      } else {
        this.pause(); // 最新コマまで到達したら自動停止
      }
    }, intervalMs);
  }

  pause() {
    clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.isPlaying = false;
    this._updatePlayPauseButton();
  }

  play() {
    if (!this.isReplay) return;
    this._startPlaybackLoop();
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
    this.timeReadout.textContent = 'LIVE';
    this.timeReadout.classList.remove('is-replay');
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
    if (this.isReplay) {
      this.statusBadge.innerHTML = `🎬&nbsp;VAR REPLAY (${this.playbackSpeed}x)`;
      if (this.isPlaying) this._startPlaybackLoop();
    }
    this._updateSpeedButton();
  }

  cycleSpeed() {
    const idx = this.speedOptions.indexOf(this.playbackSpeed);
    this.setSpeed(this.speedOptions[(idx + 1) % this.speedOptions.length]);
  }

  stepFrame(dir) {
    if (!this.isReplay) return;
    const frames = this.recorder.getFrames(this.currentCamId);
    if (frames.length === 0) return;
    this.pause();
    this.frameIndex = Math.max(0, Math.min(frames.length - 1, this.frameIndex + dir));
    this._renderCurrentFrame();
  }

  onSeekInput(value) {
    if (!this.isReplay) return;
    this.pause();
    const frames = this.recorder.getFrames(this.currentCamId);
    this.frameIndex = Math.max(0, Math.min(frames.length - 1, parseInt(value, 10)));
    this._renderCurrentFrame();
  }

  async _renderCurrentFrame() {
    const frames = this.recorder.getFrames(this.currentCamId);
    this.seekBar.max = Math.max(0, frames.length - 1);
    this.seekBar.value = this.frameIndex;

    if (frames.length === 0) {
      this.timeReadout.textContent = 'LIVE';
      this.timeReadout.classList.remove('is-replay');
      return;
    }

    const behindFrames = (frames.length - 1) - this.frameIndex;
    const behindSeconds = (behindFrames / this.recorder.fps).toFixed(1);
    this.timeReadout.textContent = behindFrames === 0 ? '最新フレーム' : `− ${behindSeconds}秒`;
    this.timeReadout.classList.add('is-replay');

    const frame = frames[this.frameIndex];
    if (!frame) return;

    const token = ++this._renderToken;
    try {
      const drawable = await blobToDrawable(frame.blob);
      if (token !== this._renderToken) {
        if (drawable.close) drawable.close();
        return; // 描画中に追い越されたら破棄(古いコマが遅れて出るのを防ぐ)
      }
      this.ctx.drawImage(drawable, 0, 0, this.canvas.width, this.canvas.height);
      if (drawable.close) drawable.close();
    } catch (err) {
      console.error(err);
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
