// replay-ui.js: VARリプレイを全画面で見るときの、操作の出し入れと指の操作。
// - 映像は画面いっぱいに出し、操作(コマ送り・再生・速度・シークバー・カメラ・保存・LIVEに戻る)は映像の上に重ねる(css/style.css の「VARリプレイの全画面」)
// - 操作は、最後に触ってから約2秒で薄くなって消える。映像に触るとまた出る。操作のボタンを触っている間は消えない
// - 指の操作(リプレイ中のみ):
//     1回タップ ............ 操作を出す・隠す(2回タップと区別するため、少しだけ待ってから反応する)
//     2回タップ ............ 触った場所を中心に2倍 / 元に戻す
//     2本指で広げる・縮める .. 拡大(1〜4倍)
//     1本で横になぞる ........ (拡大していないとき)コマを前後に送る。1コマごとにシークバーと同じ手触り
//     1本でなぞる ............ (拡大しているとき)見る場所を動かす。映像の外までは動かさない
// - 手が震えていても、1回タップで拡大しないよう、拡大は「2回タップ」か「2本指」のときだけ。
//   指の動きが数px以内なら、なぞった扱いにしない(タップのまま)
// - 保存するクリップには関係しない(拡大は表示だけ。録画バッファの映像はそのまま)

const HIDE_AFTER_MS = 2000;       // 最後に触ってから、操作が消えるまで
const TAP_SLOP_PX = 12;           // この距離までの動きは、なぞりではなくタップ(手の震えの余裕)
const SINGLE_TAP_WAIT_MS = 260;   // 2回タップかどうかを見分けるために待つ時間(短く)
const DOUBLE_TAP_GAP_MS = 300;    // 2回タップとみなす、1回目と2回目の間の長さ
const DOUBLE_TAP_DISTANCE_PX = 48; // 2回タップとみなす、1回目と2回目の場所の差
const PX_PER_FRAME = 10;          // 横になぞって1コマ進むのに必要な距離
const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2;
const PINCH_DEADZONE = 0.05;      // 2本指の幅が、始めの5%以内の変化なら拡大・縮小しない(震え対策)
const SNAP_TO_ONE = 1.03;         // 指を離したとき、これ以下なら等倍に戻す

// 触っている間は操作を消さない対象
const CONTROL_SELECTOR = '#camSelector button, .seek-row, .save-btn, #btnSpeed, #btnStepBack, #btnPlayPause, #btnStepForward, #btnGoLive';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// area: #monitorArea(.replaying が付く全画面の入れ物) / stage: 映像の枠 / canvas: 映像
// onZoom・onScrub: 使われたとき(リプレイ1回につき1度だけ)に呼ぶ。送る側(app.js)は何も数えなくてよい
export function createReplayUi({ area, stage, canvas, zoomBadge, player, onZoom = () => {}, onScrub = () => {} }) {
  let active = false;
  let uiShown = true;
  let hideTimer = 0;
  let tapTimer = 0;
  let touching = false;
  let usedZoom = false;
  let usedScrub = false;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let animTimer = 0;
  const heldControls = new Set();
  const pointers = new Map();
  let mode = 'idle'; // idle / tap / scrub / pan / pinch / ignore
  let down = null;
  let panStart = null;
  let pinch = null;
  let lastTap = null;

  // ---- 操作の出し入れ ----
  function setUi(show) {
    if (uiShown === show && area.dataset.ui) return;
    uiShown = show;
    area.dataset.ui = show ? 'show' : 'hide';
  }

  function cancelHide() { clearTimeout(hideTimer); }

  function scheduleHide() {
    cancelHide();
    if (!active || touching || heldControls.size > 0) return;
    hideTimer = setTimeout(() => setUi(false), HIDE_AFTER_MS);
  }

  function showControls() {
    if (!active) return;
    setUi(true);
    scheduleHide();
  }

  // ---- 拡大・移動 ----
  // 映像が画面の中で実際に占める大きさ(縦横比を保って収めた大きさ)
  function fitted() {
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const ratio = (canvas.width || 1) / (canvas.height || 1);
    const fw = W / H > ratio ? H * ratio : W;
    const fh = W / H > ratio ? H : W / ratio;
    return { W, H, fw, fh };
  }

  // 見る場所(ずらし量)を、映像の外まで動かさない範囲に収める。映像が画面より小さいうちは動かさない(中央)
  function clampShift(s, x, y) {
    const { W, H, fw, fh } = fitted();
    const cx = W / 2;
    const cy = H / 2;
    const x0 = (W - fw) / 2;
    const y0 = (H - fh) / 2;
    const clampAxis = (value, size, box, center, start) => {
      if (s * size < box) return 0;
      const lo = box - center - s * (start + size - center);
      const hi = -center - s * (start - center);
      return clamp(value, lo, hi);
    };
    return { x: clampAxis(x, fw, W, cx, x0), y: clampAxis(y, fh, H, cy, y0) };
  }

  function apply({ animate = false } = {}) {
    clearTimeout(animTimer);
    canvas.classList.toggle('zoom-anim', animate);
    if (animate) animTimer = setTimeout(() => canvas.classList.remove('zoom-anim'), 320);
    canvas.style.setProperty('--zs', String(scale));
    canvas.style.setProperty('--zx', `${tx}px`);
    canvas.style.setProperty('--zy', `${ty}px`);
    const zoomed = scale > 1.001;
    zoomBadge.textContent = zoomed ? `${scale.toFixed(1)}×` : '';
    zoomBadge.classList.toggle('on', zoomed);
    if (zoomed && !usedZoom) {
      usedZoom = true;
      onZoom();
    }
  }

  function setZoom(nextScale, nextX, nextY, options) {
    scale = clamp(nextScale, 1, MAX_ZOOM);
    if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; } else {
      const shift = clampShift(scale, nextX, nextY);
      tx = shift.x;
      ty = shift.y;
    }
    apply(options);
  }

  function resetZoom(animate = false) {
    if (scale === 1 && tx === 0 && ty === 0) return;
    setZoom(1, 0, 0, { animate });
  }

  // 触った場所が画面の同じ位置に残るように、拡大する
  function toggleZoomAt(point) {
    if (scale > 1.001) { resetZoom(true); return; }
    const { W, H } = fitted();
    setZoom(DOUBLE_TAP_ZOOM, (point.x - W / 2) * (1 - DOUBLE_TAP_ZOOM), (point.y - H / 2) * (1 - DOUBLE_TAP_ZOOM), { animate: true });
  }

  // ---- 指の操作 ----
  const local = (e) => {
    const rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function endTouch() {
    touching = false;
    scheduleHide();
  }

  function handleTap(point, wasHidden) {
    const now = performance.now();
    if (lastTap && now - lastTap.t <= DOUBLE_TAP_GAP_MS && dist(lastTap, point) <= DOUBLE_TAP_DISTANCE_PX) {
      clearTimeout(tapTimer);
      lastTap = null;
      toggleZoomAt(point);
      return;
    }
    lastTap = { x: point.x, y: point.y, t: now };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      if (!active) return;
      if (wasHidden) showControls();
      else { cancelHide(); setUi(false); }
    }, SINGLE_TAP_WAIT_MS);
  }

  function beginPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d0: dist(a, b) || 1, s0: scale, tx0: tx, ty0: ty, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, started: false };
  }

  function updatePinch() {
    if (!pinch || pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const ratio = dist(a, b) / pinch.d0;
    if (!pinch.started) {
      if (Math.abs(ratio - 1) < PINCH_DEADZONE) return;
      pinch.started = true;
    }
    const next = clamp(pinch.s0 * ratio, 1, MAX_ZOOM);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const { W, H } = fitted();
    // 指の中点の下にあった映像の点が、指の動きについてくるようにする
    const x = mid.x - W / 2 - next * ((pinch.mid0.x - W / 2 - pinch.tx0) / pinch.s0);
    const y = mid.y - H / 2 - next * ((pinch.mid0.y - H / 2 - pinch.ty0) / pinch.s0);
    setZoom(next, x, y);
  }

  function onDown(e) {
    if (!active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 捕まえられなくても動く */ }
    const point = local(e);
    pointers.set(e.pointerId, point);
    touching = true;
    cancelHide();
    if (pointers.size === 1) {
      mode = 'tap';
      down = { ...point, wasHidden: !uiShown, startIndex: player.frameIndex };
    } else if (pointers.size === 2) {
      clearTimeout(tapTimer);
      lastTap = null;
      mode = 'pinch';
      beginPinch();
      setUi(true);
    } else {
      mode = 'ignore';
    }
  }

  function onMove(e) {
    if (!active || !pointers.has(e.pointerId)) return;
    const point = local(e);
    pointers.set(e.pointerId, point);
    if (mode === 'pinch') {
      updatePinch();
    } else if (mode === 'tap' && down) {
      const dx = point.x - down.x;
      const dy = point.y - down.y;
      if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return; // 手の震えはタップのまま
      clearTimeout(tapTimer);
      lastTap = null;
      if (scale > 1.001) {
        mode = 'pan';
        panStart = { x: point.x, y: point.y, tx, ty };
      } else if (Math.abs(dx) >= Math.abs(dy)) {
        mode = 'scrub';
      } else {
        mode = 'ignore'; // 縦になぞっても、何も起きない
      }
      if (mode !== 'ignore') setUi(true); // なぞり始めたら、シークバーが動くのが見えるよう操作を出す
    }
    if (mode === 'scrub') {
      const moved = player.scrubTo(down.startIndex + (point.x - down.x) / PX_PER_FRAME);
      if (moved && !usedScrub) {
        usedScrub = true;
        onScrub();
      }
    } else if (mode === 'pan') {
      setZoom(scale, panStart.tx + (point.x - panStart.x), panStart.ty + (point.y - panStart.y));
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const point = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (mode === 'pinch') {
      if (pointers.size < 2) {
        if (scale < SNAP_TO_ONE) resetZoom(true);
        mode = pointers.size === 0 ? 'idle' : 'ignore'; // 残った1本の指で、いきなりなぞり始めない
        pinch = null;
      }
    } else if (mode === 'tap' && pointers.size === 0 && e.type === 'pointerup' && down) {
      handleTap(point, down.wasHidden);
    }
    if (pointers.size === 0) {
      mode = 'idle';
      down = null;
      endTouch();
    }
  }

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  // iPhoneのSafariは、2本指の動きをページの拡大として受け取ろうとする。映像の拡大に使うので止める
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => stage.addEventListener(name, (e) => e.preventDefault()));

  // 操作のボタンを触っている間は、消さない。離したら、そこから約2秒で消える
  area.addEventListener('pointerdown', (e) => {
    if (!active || !e.target.closest || !e.target.closest(CONTROL_SELECTOR)) return;
    heldControls.add(e.pointerId);
    cancelHide();
  }, true);
  const releaseControl = (e) => {
    if (heldControls.delete(e.pointerId)) scheduleHide();
  };
  document.addEventListener('pointerup', releaseControl, true);
  document.addEventListener('pointercancel', releaseControl, true);
  document.addEventListener('keydown', () => showControls());

  // 画面の向きや大きさが変わったら、見る場所を新しい大きさに収め直す
  window.addEventListener('resize', () => {
    if (active && scale > 1.001) setZoom(scale, tx, ty);
  });

  return {
    // リプレイに入った(または戻ってきた)とき。操作を出した状態で始める。newSession: 新しいVAR(GAの「1回につき1度」を数え直す)
    enter({ newSession = false } = {}) {
      active = true;
      if (newSession) { usedZoom = false; usedScrub = false; }
      clearTimeout(tapTimer);
      lastTap = null;
      pointers.clear();
      heldControls.clear();
      mode = 'idle';
      touching = false;
      resetZoom(false);
      uiShown = true;
      area.dataset.ui = 'show';
      scheduleHide();
    },
    // LIVEに戻ったとき。拡大を元に戻す
    leave() {
      active = false;
      cancelHide();
      clearTimeout(tapTimer);
      lastTap = null;
      pointers.clear();
      heldControls.clear();
      mode = 'idle';
      resetZoom(false);
      delete area.dataset.ui;
    },
    resetZoom,
    showControls,
  };
}
