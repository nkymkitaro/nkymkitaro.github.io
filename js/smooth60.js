// smooth60.js: ⚙の「なめらか(60コマ)」。オンのときだけ、親機のカメラに60コマ/秒を頼む(2026-11-17 中山さんの決定「Bで」)。
// - 60コマ/秒にするには、露出モード continuous をはっきり指定する(Pixel 9a の実測: 指定なしは普通の部屋で約20コマ、指定ありで約57コマ。
//   依頼 claude/requests/2026-11-13-to-videocoder-fps60-stability-test.md の対応2)。映像は約2割暗くなる
// - カメラが替わったとき(自撮りへの切り替えなど)や、ほかの処理が取り込みの大きさを頼み直したとき(60の指定が消える)は、自動で頼み直す
// - 暗くて60が出ないとき(数秒続けて45コマ/秒を切る)は、カメラごとに1回だけ短く知らせる。最初はオフ。計測(GA4)には何も送らない
import { readLocal, writeLocal } from './safe-storage.js';
import { showToast } from './toast.js';

const KEY = 'kendovar.smooth60';
const LOW_FPS = 45;
const LOW_SECONDS = 4; // 何秒続けて下回ったら知らせるか
const WARMUP_MS = 3000; // 開いた直後は露出が落ち着かないので数えない

let on = readLocal(KEY) === '1';
let getTrack = () => null;
let appliedId = '';
let warnedId = '';
let lowSec = 0;
let openedAt = 0;
let frames = 0;

export function isSmooth60() { return on; }
export function setSmooth60(v) {
  on = !!v; writeLocal(KEY, on ? '1' : '0');
  appliedId = ''; lowSec = 0;
  apply(true);
}

// ほかの処理(画質の切り替え・縦横の形の頼み直し)が applyConstraints を呼ぶと、60の指定が消える。
// そこで、親機のカメラへの頼みには、オンの間だけ60と露出モードを足す。
// (Chrome は advanced を付けると getConstraints() が advanced しか返さないため、元の頼み(base)はここで覚えておく)
const base = new WeakMap();
function withSmooth(t, c) {
  const next = { ...(c || {}) };
  delete next.frameRate; delete next.advanced;
  if (!on) return next;
  next.frameRate = { ideal: 60 };
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  // continuous に対応しない端末(iPhone など)は、60の頼みだけ
  if (caps.exposureMode && caps.exposureMode.includes('continuous')) next.advanced = [{ exposureMode: 'continuous' }];
  return next;
}
let origApply = null;
function patchApply() {
  if (origApply || typeof MediaStreamTrack === 'undefined') return;
  origApply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    if (this.kind === 'video' && this === getTrack()) {
      base.set(this, { ...(c || {}) });
      return origApply.call(this, withSmooth(this, c));
    }
    return origApply.call(this, c);
  };
}

async function apply(force) {
  const t = getTrack();
  if (!t || t.readyState !== 'live' || typeof t.applyConstraints !== 'function') return;
  if (!force && t.id === appliedId) return;
  if (t.id !== appliedId) { openedAt = performance.now(); lowSec = 0; }
  appliedId = t.id;
  if (!base.has(t)) { const c = (t.getConstraints && t.getConstraints()) || {}; delete c.advanced; delete c.frameRate; base.set(t, c); }
  // 新しいカメラで、オフのままなら何もしない(余計に頼み直さない)
  if (!on && !force) return;
  try { await t.applyConstraints(base.get(t)); } catch (err) { /* 頼めない端末は、今のまま */ }
}

// 実際のコマ数を数える(画面に出たコマ。親機の見ている映像)
function countFrames(video) {
  if (!video || !video.requestVideoFrameCallback) return;
  const tick = () => { frames += 1; video.requestVideoFrameCallback(tick); };
  video.requestVideoFrameCallback(tick);
}

export function initSmooth60({ trackGetter, video }) {
  getTrack = trackGetter;
  patchApply();
  countFrames(video);
  setInterval(() => {
    apply(false);
    const fps = frames; frames = 0;
    const t = getTrack();
    if (!on || !t || document.hidden || performance.now() - openedAt < WARMUP_MS) { lowSec = 0; return; }
    lowSec = fps > 0 && fps < LOW_FPS ? lowSec + 1 : 0;
    if (lowSec >= LOW_SECONDS && warnedId !== t.id) {
      warnedId = t.id;
      showToast('暗いため、なめらかに撮れていません。明るい場所で使ってください');
    }
  }, 1000);
}
