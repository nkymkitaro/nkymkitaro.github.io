// ReplayPlayer: MultiCamRecorder に貯まった「複数カメラぶんの録画バッファ」を使って、
// 巻き戻し・コマ送り・速度変更・別アングルへの切り替えを担当するクラス。
// ライブ中は選択中カメラの映像をそのまま描画し(startLiveLoop)、
// リプレイ中は録画バッファから該当コマをデコードして描画する。
import { tapFeedback } from './haptics.js';

const SEEK_HAPTIC_INTERVAL_MS = 50; // シークを指でなぞったときの振動の間隔(ブーッと鳴り続けないように間引く)
// 並べて見るとき、ほかのカメラで「同じ瞬間」とみなすずれの上限。これより離れたコマしかなければ「映像なし」にする
// (切断などで、その時刻のコマがないカメラに、別の時刻の映像を出さないため)
const GRID_MATCH_LIMIT_MS = 300;
const GRID_LABEL_PX = 14; // 並べて見るときのカメラ名の文字の大きさ(画面上の見た目の大きさ)
const GRID_GAP_PX = 3;    // 並べた映像どうしのすきま(画面上の見た目の大きさ)

// 並べて見るとき、描き直しが1コマの時間(15コマ/秒=67ms)を超える端末では、映像を小さくしてから描く。
// 小さくするのは並べた形だけ(1つずつ見る形は元の画質)。判断は、直近の描き直しの時間の中央値で自動で行う
const GRID_FRAME_BUDGET_MS = 67;
const GRID_TIMING_SAMPLES = 5;     // 中央値を取る描き直しの回数
const GRID_SMALL_WIDTH_PX = 320;   // 小さくするときの映像の幅(元は640px)

async function blobToDrawable(blob, smallWidth = 0) {
  if (window.createImageBitmap) {
    if (smallWidth) {
      try {
        return await createImageBitmap(blob, { resizeWidth: smallWidth, resizeQuality: 'low' });
      } catch (err) {
        // 小さくして読み込む指定に対応しない端末は、元の大きさで読み込む
      }
    }
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

    // 見え方: 'single'(1つずつ見る) / 'grid'(並べて見る)。
    // 並べて見るときも、時刻の基準は currentCamId のコマ(シークバー・コマ送りはこのカメラのコマで動く)。
    // ほかのカメラは、同じ撮影時刻に一番近いコマを出す
    this.view = 'single';
    this.onViewChanged = null; // (view) => void: カメラが減って並べられなくなり、自動で1つずつ見る形に戻したとき
    this._gridCache = new Map(); // camId -> { frame, drawable }: コマが変わらないカメラは、描き直すときに画像を作り直さない
    this._gridLayout = null; // 最後に並べたときの配置(タップした場所のカメラを調べるため)
    this._gridSmall = false; // 描き直しが遅い端末では true: 並べた形のときだけ映像を小さくして読み込む
    this.delayMode = false;  // 遅れて映している間は true(ライブの描画を止める)
    this._gridTimes = [];    // 直近の描き直しの時間(ms)。コマを新しく読み込んだ回だけ数える

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

  // 見ているカメラのコマの並び。録画が古いコマを捨てていたら、そのぶんコマ番号を前へずらして、
  // 同じ場面を指し続けるようにする(VAR中は録画側が捨てないので、ふつうは上限を超えたときだけ)
  _frames() {
    const frames = this.recorder.getFrames(this.currentCamId);
    const dropped = this.recorder.getDropped ? this.recorder.getDropped(this.currentCamId) : 0;
    if (this._droppedCam === this.currentCamId) {
      const diff = dropped - this._dropped;
      if (diff > 0) this.frameIndex = Math.max(0, this.frameIndex - diff);
    }
    this._droppedCam = this.currentCamId;
    this._dropped = dropped;
    return frames;
  }

  // カメラを切り替えたとき・VARに入ったときに、捨てたコマの数の基準を今の値にそろえる
  _resetDropBaseline() {
    this._droppedCam = this.currentCamId;
    this._dropped = this.recorder.getDropped ? this.recorder.getDropped(this.currentCamId) : 0;
  }

  // ライブ中は録画バッファとは別に、選択中カメラの映像をそのまま描画し続ける
  startLiveLoop(getActiveVideoEl) {
    if (this._liveLoopStarted) return;
    this._liveLoopStarted = true;
    const loop = () => {
      if (!this.isReplay && !this.delayMode) {
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
    this._resetDropBaseline();
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
    const frames = this._frames();
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
    const frame = this._frames()[this.frameIndex];
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
    this._resetDropBaseline();
    this.frameIndex = index;
    this.pause();
    this._enterReplayState();
    return true;
  }

  // リプレイ中に別のカメラへ切り替える。同じ瞬間(タイムスタンプ)に一番近いコマを探して表示する。
  switchAngle(camId) {
    if (!this.isReplay) return false;
    this._cancelSweep();
    const oldFrames = this._frames();
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
    this._resetDropBaseline();
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
      const frames = this._frames();
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
    this._clearGridCache(); // 見え方(this.view)は残す。次のVARで app.js が決め直す
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
    const frames = this._frames();
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
    const frames = this._frames();
    const next = Math.max(0, Math.min(frames.length - 1, parseInt(value, 10)));
    if (next !== this.frameIndex) this._seekHaptic();
    this.frameIndex = next;
    this._renderCurrentFrame();
  }

  // 指でなぞってコマが変わるたびに、小さく振動させる(間引いて鳴らす)。シークバーと映像のなぞりで同じ手触りにする
  _seekHaptic() {
    const now = performance.now();
    if (now - this._lastSeekHaptic >= SEEK_HAPTIC_INTERVAL_MS) {
      tapFeedback(8);
      this._lastSeekHaptic = now;
    }
  }

  // 映像を指でなぞって、コマ番号を直接動かす(js/replay-ui.js から)。再生は止まる。動いたら true
  scrubTo(index) {
    if (!this.isReplay) return false;
    this._cancelSweep();
    const frames = this._frames();
    if (frames.length === 0) return false;
    this.pause();
    const next = Math.max(0, Math.min(frames.length - 1, Math.round(index)));
    if (next === this.frameIndex) return false;
    this._seekHaptic();
    this.frameIndex = next;
    this._renderCurrentFrame();
    this._bumpThumb(); // つまみの弾み(コマ送りボタンと同じ手触り)
    return true;
  }

  // シークバーの位置と「− N秒」の表示だけを、今のコマ番号に合わせる
  _updateSeekUi() {
    const frames = this._frames();
    this.seekBar.max = Math.max(0, frames.length - 1);
    this.seekBar.value = this.frameIndex;

    if (frames.length === 0) {
      this.timeReadout.textContent = 'LIVE';
      this.timeReadout.classList.remove('is-replay');
      return false;
    }

    const behindFrames = (frames.length - 1) - this.frameIndex;
    const behindSeconds = (behindFrames / this.recorder.fps).toFixed(1);
    this.timeReadout.textContent = behindFrames === 0 ? 'いま' : `${behindSeconds}秒前`;
    this.timeReadout.classList.add('is-replay');
    return true;
  }

  async _renderCurrentFrame() {
    if (this.view === 'grid') return this._renderGrid();
    if (!this._updateSeekUi()) return;
    const frames = this._frames();
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

  // ---- 並べて見る ----

  // 並べられるカメラ(録画のコマがあるもの)。カメラ1、カメラ2…の順
  gridCamIds() {
    const num = (id) => {
      const m = /(\d+)/.exec(this.recorder.getLabel(id) || '');
      return m ? parseInt(m[1], 10) : 99;
    };
    return this.recorder.listCameraIds()
      .filter((id) => this.recorder.getFrames(id).length > 0)
      .sort((a, b) => num(a) - num(b));
  }

  canGrid() {
    return this.gridCamIds().length >= 2;
  }

  // 見え方を切り替える。時刻(基準のカメラのコマ)はそのまま。render: false なら描き直さない(続けて別の操作をするとき)
  setView(view, { render = true } = {}) {
    const next = view === 'grid' && this.canGrid() ? 'grid' : 'single';
    this.view = next;
    if (next !== 'grid') this._clearGridCache();
    if (render && this.isReplay) this._renderCurrentFrame();
    return next;
  }

  _clearGridCache() {
    this._renderToken++; // 描いている途中のものがあれば、片付けた画像を使わないよう打ち切る
    for (const entry of this._gridCache.values()) {
      if (entry.drawable && entry.drawable.close) entry.drawable.close();
    }
    this._gridCache.clear();
    this._gridLayout = null;
  }

  // 撮影時刻 ts に一番近いコマ(コマは撮影順に並んでいるので、二分探索で探す)
  _nearestFrame(frames, ts) {
    if (frames.length === 0) return null;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    let best = frames[lo];
    if (lo > 0 && Math.abs(frames[lo - 1].ts - ts) < Math.abs(best.ts - ts)) best = frames[lo - 1];
    return Math.abs(best.ts - ts) <= GRID_MATCH_LIMIT_MS ? best : null;
  }

  // 並べ方を選ぶ。映像1つあたりが一番大きく見える並べ方にする
  // (横向きの2台は左右、縦向きは上下。3〜4台は2×2か、縦・横の1列のうち大きく見えるほう)
  _chooseGrid(count, tileW, tileH) {
    const boxW = this.canvas.clientWidth || tileW * 2;
    const boxH = this.canvas.clientHeight || tileH;
    const candidates = count <= 2 ? [[2, 1], [1, 2]] : [[2, 2], [1, count], [count, 1]];
    let best = null;
    for (const [cols, rows] of candidates) {
      const scale = Math.min(boxW / (cols * tileW), boxH / (rows * tileH));
      if (!best || scale > best.scale + 1e-6) best = { cols, rows, scale };
    }
    return best;
  }

  async _renderGrid() {
    if (!this._updateSeekUi()) return;
    const ids = this.gridCamIds();
    if (ids.length < 2) {
      // カメラが減って並べられなくなった: 1つずつ見る形に戻す
      this.setView('single', { render: false });
      if (this.onViewChanged) this.onViewChanged('single');
      return this._renderCurrentFrame();
    }
    const ref = this._frames()[this.frameIndex];
    if (!ref) return;
    const token = ++this._renderToken;
    const created = [];
    const startedAt = performance.now();
    let items;
    try {
      items = await Promise.all(ids.map(async (id) => {
        const frame = this._nearestFrame(this.recorder.getFrames(id), ref.ts);
        if (!frame) return { id, frame: null, drawable: null };
        const cached = this._gridCache.get(id);
        if (cached && cached.frame === frame) return { id, frame, drawable: cached.drawable };
        const drawable = await blobToDrawable(frame.blob, this._gridSmall ? GRID_SMALL_WIDTH_PX : 0);
        created.push(drawable);
        return { id, frame, drawable };
      }));
    } catch (err) {
      console.error(err);
      created.forEach((d) => d.close && d.close());
      return;
    }
    if (token !== this._renderToken || this.view !== 'grid') {
      created.forEach((d) => d.close && d.close()); // 描画中に追い越された(古いコマが遅れて出るのを防ぐ)
      return;
    }

    // 1つの枠の大きさは、映像の一番大きいものに合わせる(縦向きと横向きのカメラが混ざっても、引き伸ばさない)
    let tileW = 0;
    let tileH = 0;
    items.forEach((it) => {
      if (!it.drawable) return;
      tileW = Math.max(tileW, it.drawable.width);
      tileH = Math.max(tileH, it.drawable.height);
    });
    if (!tileW || !tileH) { tileW = 640; tileH = 480; }
    const layout = this._chooseGrid(items.length, tileW, tileH);
    this._fitCanvasTo(layout.cols * tileW, layout.rows * tileH);
    layout.tileW = tileW;
    layout.tileH = tileH;
    this._paintTiles(items, layout);

    // 新しく作った画像を控え、使わなくなった古い画像は片付ける
    items.forEach((it) => {
      const old = this._gridCache.get(it.id);
      if (old && old.drawable !== it.drawable && old.drawable && old.drawable.close) old.drawable.close();
      if (it.drawable) this._gridCache.set(it.id, { frame: it.frame, drawable: it.drawable });
      else this._gridCache.delete(it.id);
    });
    for (const id of [...this._gridCache.keys()]) {
      if (!ids.includes(id)) {
        const old = this._gridCache.get(id);
        if (old.drawable && old.drawable.close) old.drawable.close();
        this._gridCache.delete(id);
      }
    }
    this._gridLayout = { cols: layout.cols, rows: layout.rows, tileW, tileH, ids };
    if (created.length > 0) this._noteGridTime(performance.now() - startedAt);
  }

  // ---- 遅れて映す(2026-10-30 依頼 delay-display)。いま − N秒 のコマを、順に出し続ける ----
  // 新しくためる仕組みは作らず、VARと同じ録画バッファを読む。VARには入らない(isReplay は false のまま)
  startDelay(sec, { onState } = {}) {
    this.stopDelay();
    this.delayMode = true;
    this.delaySec = sec;
    this._delayReady = null;
    this._delayOnState = onState || null;
    this._delayCache = new Map(); // camId -> { frame, drawable }
    this._delayToken = 0;
    this._delayBusy = false;
    let last = 0;
    const loop = (now) => {
      if (!this.delayMode) return;
      if (now - last >= 60 && !this._delayBusy) { last = now; this._delayTick(); }
      this._delayRaf = requestAnimationFrame(loop);
    };
    this._delayRaf = requestAnimationFrame(loop);
  }

  stopDelay() {
    if (!this.delayMode) return;
    this.delayMode = false;
    cancelAnimationFrame(this._delayRaf);
    this._delayToken++;
    for (const entry of this._delayCache.values()) {
      if (entry.drawable && entry.drawable.close) entry.drawable.close();
    }
    this._delayCache.clear();
    this._delayReady = null;
  }

  async _delayTick() {
    this._delayBusy = true;
    const token = ++this._delayToken;
    const created = [];
    try {
      const targetTs = performance.now() - this.delaySec * 1000;
      const ids = this.gridCamIds();
      // N秒たつまでは出さない(いちばん古いコマが、まだ「いま − N秒」に届いていない)
      const ready = ids.some((id) => this.recorder.getFrames(id)[0].ts <= targetTs + 150);
      // 準備中は、あと何秒で始まるかも知らせる(いちばん早く届くカメラ基準)
      const remain = ready ? 0 : Math.max(1, Math.ceil(Math.min(...ids.map((id) => {
        const fr = this.recorder.getFrames(id);
        return fr.length ? this.delaySec - (performance.now() - fr[0].ts) / 1000 : this.delaySec;
      }))));
      if (ready !== this._delayReady || remain !== this._delayRemain) {
        this._delayReady = ready;
        this._delayRemain = remain;
        if (this._delayOnState) this._delayOnState(ready, remain);
      }
      if (!ready) {
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        return;
      }
      const items = await Promise.all(ids.map(async (id) => {
        const frames = this.recorder.getFrames(id);
        // 録画のいちばん古いコマより前を指したときは、そのコマ(長さの上限ぎりぎりのとき)
        const frame = frames.length && frames[0].ts > targetTs ? frames[0] : this._nearestFrame(frames, targetTs);
        if (!frame) return { id, frame: null, drawable: null };
        const cached = this._delayCache.get(id);
        if (cached && cached.frame === frame) return { id, frame, drawable: cached.drawable };
        const drawable = await blobToDrawable(frame.blob);
        created.push(drawable);
        return { id, frame, drawable };
      }));
      if (token !== this._delayToken || !this.delayMode) {
        created.forEach((d) => d.close && d.close());
        return;
      }
      if (items.length === 1) {
        const d = items[0].drawable;
        if (d) {
          this._fitCanvasTo(d.width, d.height);
          this.ctx.drawImage(d, 0, 0, this.canvas.width, this.canvas.height);
        }
      } else if (items.length > 1) {
        let tileW = 0; let tileH = 0;
        items.forEach((it) => {
          if (!it.drawable) return;
          tileW = Math.max(tileW, it.drawable.width);
          tileH = Math.max(tileH, it.drawable.height);
        });
        if (!tileW || !tileH) { tileW = 640; tileH = 480; }
        const layout = this._chooseGrid(items.length, tileW, tileH);
        layout.tileW = tileW;
        layout.tileH = tileH;
        this._fitCanvasTo(layout.cols * tileW, layout.rows * tileH);
        this._paintTiles(items, layout);
      }
      // 使った画像を控え、使わなくなった古い画像は片付ける
      items.forEach((it) => {
        const old = this._delayCache.get(it.id);
        if (old && old.drawable !== it.drawable && old.drawable && old.drawable.close) old.drawable.close();
        if (it.drawable) this._delayCache.set(it.id, { frame: it.frame, drawable: it.drawable });
        else this._delayCache.delete(it.id);
      });
      for (const id of [...this._delayCache.keys()]) {
        if (!ids.includes(id)) {
          const old = this._delayCache.get(id);
          if (old.drawable && old.drawable.close) old.drawable.close();
          this._delayCache.delete(id);
        }
      }
    } catch (err) {
      console.error(err);
      created.forEach((d) => d.close && d.close());
    } finally {
      this._delayBusy = false;
    }
  }

  // 並べた映像を canvas に描く(VARの「並べて見る」と、遅れて映すで共通)。tileW・tileH は layout に入れて渡す
  _paintTiles(items, layout) {
    const { tileW, tileH } = layout;
    const ctx = this.ctx;
    const unit = 1 / layout.scale; // 画面上の1pxが、canvasの何pxにあたるか
    const gap = Math.round(GRID_GAP_PX * unit);
    const fontPx = Math.round(GRID_LABEL_PX * unit);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    items.forEach((it, i) => {
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const x = col * tileW + gap / 2;
      const y = row * tileH + gap / 2;
      const w = tileW - gap;
      const h = tileH - gap;
      ctx.fillStyle = '#111';
      ctx.fillRect(x, y, w, h);
      if (it.drawable) {
        const s = Math.min(w / it.drawable.width, h / it.drawable.height);
        const dw = it.drawable.width * s;
        const dh = it.drawable.height * s;
        ctx.drawImage(it.drawable, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = '#8e8e93';
        ctx.font = `800 ${fontPx}px Murecho, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('映像なし', x + w / 2, y + h / 2);
      }
      // カメラ名(左上)。暗い地に白い文字で、明るい映像の上でも読めるようにする
      const label = this.recorder.getLabel(it.id);
      ctx.font = `900 ${fontPx}px Murecho, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const padX = Math.round(fontPx * 0.6);
      const bw = ctx.measureText(label).width + padX * 2;
      const bh = Math.round(fontPx * 1.7);
      ctx.fillStyle = 'rgba(28, 28, 30, 0.82)';
      ctx.fillRect(x, y, bw, bh);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + padX, y + bh / 2);
    });
  }

  // 並べた形の描き直しにかかった時間を控え、1コマの時間を超える端末では、映像を小さくして読み込む形に切り替える
  // (一度切り替えたら戻さない。切り替え後は新しく読み込むコマから小さくなる)
  _noteGridTime(ms) {
    if (this._gridSmall) return;
    this._gridTimes.push(ms);
    if (this._gridTimes.length > GRID_TIMING_SAMPLES) this._gridTimes.shift();
    if (this._gridTimes.length < GRID_TIMING_SAMPLES) return;
    const sorted = [...this._gridTimes].sort((a, b) => a - b);
    if (sorted[sorted.length >> 1] > GRID_FRAME_BUDGET_MS) {
      this._gridSmall = true;
      // 大きいまま控えた画像は使わず、次の描き直しで小さく読み込み直す(今の配置はタップの判定に使うので残す)
      for (const entry of this._gridCache.values()) {
        if (entry.drawable && entry.drawable.close) entry.drawable.close();
      }
      this._gridCache.clear();
    }
  }

  // 並べて見ているとき、映像の枠の中の点(x, y: 枠の左上からのpx)に映っているカメラ。なければ null
  tileAt(x, y) {
    const g = this._gridLayout;
    if (this.view !== 'grid' || !g) return null;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (!W || !H || !cw || !ch) return null;
    // canvas は object-fit: contain で枠に収めているので、余白の分をずらして canvas の座標に直す
    const s = Math.min(W / cw, H / ch);
    const cx = (x - (W - cw * s) / 2) / s;
    const cy = (y - (H - ch * s) / 2) / s;
    if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) return null;
    const index = Math.floor(cy / g.tileH) * g.cols + Math.floor(cx / g.tileW);
    return g.ids[index] || null;
  }

  _updatePlayPauseButton() {
    this.playPauseBtn.innerHTML = this.isPlaying
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    this.playPauseBtn.setAttribute('aria-label', this.isPlaying ? '一時停止' : '再生');
  }

  _updateSpeedButton() {
    this.speedBtn.textContent = this.playbackSpeed + '倍';
  }
}
