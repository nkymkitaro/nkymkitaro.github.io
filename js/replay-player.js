// ReplayPlayer: MultiCamRecorder に貯まった「複数カメラぶんの録画バッファ」を使って、
// 巻き戻し・コマ送り・速度変更・別アングルへの切り替えを担当するクラス。
// ライブ中は選択中カメラの映像をそのまま描画し(startLiveLoop)、
// リプレイ中は録画バッファから該当コマをデコードして描画する。
import { tapFeedback } from './haptics.js';

const SEEK_HAPTIC_INTERVAL_MS = 50; // シークを指でなぞったときの振動の間隔(ブーッと鳴り続けないように間引く)

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
    this._sweepId = 0; // VARに入るときの「ため」と巻き戻しの動き。途中で別の操作が来たら番号を進めて打ち切る
    this._lastSeekHaptic = 0;

    this.seekBar = document.getElementById('seekBar');
    this.timeReadout = document.getElementById('timeReadout');
    this.playPauseBtn = document.getElementById('btnPlayPause');
    this.speedBtn = document.getElementById('btnSpeed');
  }

  // canvasの内部サイズを映像の縦横比に合わせる。
  // (横向きで撮った子機・縦向きの親機など、カメラごとに縦横比が違っても引き伸ばさないため。
  //  表示上の大きさはCSSの object-fit: contain で画面に収める)
  _fitCanvasTo(width, height) {
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // ライブ中は録画バッファとは別に、選択中カメラの映像をそのまま描画し続ける
  startLiveLoop(getActiveVideoEl) {
    if (this._liveLoopStarted) return;
    this._liveLoopStarted = true;
    const loop = () => {
      if (!this.isReplay) {
        const video = getActiveVideoEl();
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
          this._fitCanvasTo(video.videoWidth, video.videoHeight);
          this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // VARに入る(デザインポリシー 2-4「ためと解放」)。
  // 1. 押した瞬間にライブ描画を止め、映像を一瞬止める(holdMs: ため)
  // 2. 最新のコマから目的の場面まで、キュッと巻き戻す(sweepMs)
  // 3. 目的の場面から再生を始める
  // holdMs・sweepMs が0(動きを減らす設定など)なら、すぐ目的の場面から再生する。
  // 動きの途中でも、コマ送り・シーク・LIVEに戻るなどの操作はすぐに受け付ける(動きは打ち切る)。
  rewind(seconds, camId, { holdMs = 0, sweepMs = 0 } = {}) {
    const frames = this.recorder.getFrames(camId);
    if (frames.length === 0) return false;

    this.pause();
    this._cancelSweep();
    this.isReplay = true; // ここでライブ描画が止まり、押した瞬間の映像のまま止まる(ため)
    this.currentCamId = camId;
    this.seekBar.disabled = false;

    const rewindCount = Math.min(Math.round(seconds * this.recorder.fps), frames.length - 1);
    // 録画バッファは裏で進み続けるので、場面はコマ番号ではなく撮影時刻で覚えておく
    const startTs = frames[frames.length - 1].ts;
    const targetTs = frames[frames.length - 1 - rewindCount].ts;
    const id = this._sweepId;

    const finish = () => {
      if (id !== this._sweepId) return;
      this._setHoldLook(false);
      this.frameIndex = this._indexAt(targetTs);
      this._renderCurrentFrame();
      this._startPlaybackLoop();
    };

    if (holdMs <= 0 && sweepMs <= 0) {
      finish();
      return true;
    }

    this.frameIndex = frames.length - 1;
    this._updateSeekUi(); // ため の間は映像を描き換えず、シークの位置と時間表示だけ合わせる
    this._setHoldLook(true);

    setTimeout(() => {
      if (id !== this._sweepId) return;
      this._setHoldLook(false);
      if (sweepMs <= 0) {
        finish();
        return;
      }
      const t0 = performance.now();
      const step = (now) => {
        if (id !== this._sweepId) return;
        const p = Math.min(1, (now - t0) / sweepMs);
        const eased = 1 - Math.pow(1 - p, 3); // 速く動き出して、目的の場面でピタッと止まる
        this.frameIndex = this._indexAt(startTs + (targetTs - startTs) * eased);
        this._renderCurrentFrame();
        if (p < 1) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
    }, holdMs);
    return true;
  }

  // 撮影時刻 ts 以降で一番近いコマの番号(なければ最新のコマ)
  _indexAt(ts) {
    const frames = this.recorder.getFrames(this.currentCamId);
    const index = frames.findIndex((f) => f.ts >= ts);
    return index < 0 ? Math.max(0, frames.length - 1) : index;
  }

  // 進行中の「ため・巻き戻し」の動きを打ち切る
  _cancelSweep() {
    this._sweepId++;
    this._setHoldLook(false);
  }

  // ため の間だけ、映像をわずかに縮めて「止まった」ことを見せる(戻りはCSSの弾み)
  _setHoldLook(on) {
    const stage = this.canvas.parentElement;
    if (stage) stage.classList.toggle('var-hold', on);
  }

  // コマ送り・シークで1コマ動いたことを、つまみの弾みで見せる
  _bumpThumb() {
    this.seekBar.classList.remove('bump');
    void this.seekBar.offsetWidth;
    this.seekBar.classList.add('bump');
    clearTimeout(this._bumpTimer);
    this._bumpTimer = setTimeout(() => this.seekBar.classList.remove('bump'), 120);
  }

  // 状態の帯(LIVE / VAR REPLAY)の切り替えは app.js が受け持つ
  _enterReplayState() {
    this.seekBar.disabled = false;
    this._renderCurrentFrame();
  }

  // 今見ている場面(カメラと撮影時刻)。誤ってLIVEに戻ったときに元の場面へ戻すために使う
  getResumePoint() {
    if (!this.isReplay) return null;
    const frame = this.recorder.getFrames(this.currentCamId)[this.frameIndex];
    return frame ? { camId: this.currentCamId, ts: frame.ts } : null;
  }

  // getResumePoint()で控えた場面に、一時停止した状態で戻る。
  // その間に録画バッファから押し出された場合は、残っている一番古いコマから表示する。
  resumeAt(point) {
    if (!point) return false;
    this._cancelSweep();
    const frames = this.recorder.getFrames(point.camId);
    if (frames.length === 0) return false;
    let index = frames.findIndex((f) => f.ts >= point.ts);
    if (index < 0) index = frames.length - 1;

    this.isReplay = true;
    this.currentCamId = point.camId;
    this.frameIndex = index;
    this.pause();
    this._enterReplayState();
    return true;
  }

  // リプレイ中に別のカメラへ切り替える。同じ瞬間(タイムスタンプ)に一番近いコマを探して表示する。
  switchAngle(camId) {
    if (!this.isReplay) return false;
    this._cancelSweep();
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
    this._cancelSweep();
    this.isPlaying ? this.pause() : this.play();
  }

  goLive() {
    this._cancelSweep();
    this.isReplay = false;
    this.isPlaying = false;
    clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.seekBar.disabled = true;
    this.seekBar.max = 0;
    this.seekBar.value = 0;
    this.timeReadout.textContent = 'LIVE';
    this.timeReadout.classList.remove('is-replay');
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
    if (this.isReplay && this.isPlaying) this._startPlaybackLoop();
    this._updateSpeedButton();
  }

  cycleSpeed() {
    const idx = this.speedOptions.indexOf(this.playbackSpeed);
    this.setSpeed(this.speedOptions[(idx + 1) % this.speedOptions.length]);
  }

  stepFrame(dir) {
    if (!this.isReplay) return;
    this._cancelSweep();
    const frames = this.recorder.getFrames(this.currentCamId);
    if (frames.length === 0) return;
    this.pause();
    this.frameIndex = Math.max(0, Math.min(frames.length - 1, this.frameIndex + dir));
    this._renderCurrentFrame();
    this._bumpThumb(); // 振動はボタン側(押した瞬間)で返している
  }

  onSeekInput(value) {
    if (!this.isReplay) return;
    this._cancelSweep();
    this.pause();
    const frames = this.recorder.getFrames(this.currentCamId);
    const next = Math.max(0, Math.min(frames.length - 1, parseInt(value, 10)));
    if (next !== this.frameIndex) {
      // 指でなぞってコマが変わるたびに、小さく振動させる(間引いて鳴らす)
      const now = performance.now();
      if (now - this._lastSeekHaptic >= SEEK_HAPTIC_INTERVAL_MS) {
        tapFeedback(8);
        this._lastSeekHaptic = now;
      }
    }
    this.frameIndex = next;
    this._renderCurrentFrame();
  }

  // シークバーの位置と「− N秒」の表示だけを、今のコマ番号に合わせる
  _updateSeekUi() {
    const frames = this.recorder.getFrames(this.currentCamId);
    this.seekBar.max = Math.max(0, frames.length - 1);
    this.seekBar.value = this.frameIndex;

    if (frames.length === 0) {
      this.timeReadout.textContent = 'LIVE';
      this.timeReadout.classList.remove('is-replay');
      return false;
    }

    const behindFrames = (frames.length - 1) - this.frameIndex;
    const behindSeconds = (behindFrames / this.recorder.fps).toFixed(1);
    this.timeReadout.textContent = behindFrames === 0 ? '最新フレーム' : `− ${behindSeconds}秒`;
    this.timeReadout.classList.add('is-replay');
    return true;
  }

  async _renderCurrentFrame() {
    if (!this._updateSeekUi()) return;
    const frames = this.recorder.getFrames(this.currentCamId);
    const frame = frames[this.frameIndex];
    if (!frame) return;

    const token = ++this._renderToken;
    try {
      const drawable = await blobToDrawable(frame.blob);
      if (token !== this._renderToken) {
        if (drawable.close) drawable.close();
        return; // 描画中に追い越されたら破棄(古いコマが遅れて出るのを防ぐ)
      }
      this._fitCanvasTo(drawable.width, drawable.height);
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
