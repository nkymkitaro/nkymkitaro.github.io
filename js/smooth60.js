// smooth60.js: ⚙の「なめらか(60コマ)」。オンのときだけ、親機のカメラに60コマ/秒を頼む(2026-11-17 中山さんの決定「Bで」)。
// - 60コマ/秒にするには、露出モード continuous をはっきり指定する(Pixel 9a の実測: 指定なしは普通の部屋で約20コマ、指定ありで約57コマ。
//   依頼 claude/requests/2026-11-13-to-videocoder-fps60-stability-test.md の対応2)。映像は約2割暗くなる
// - カメラが替わったとき(自撮りへの切り替えなど)や、ほかの処理が取り込みの大きさを頼み直したとき(60の指定が消える)は、自動で頼み直す
// - 2026-11-22 中山さん「暗くなろうが関係なく、なめらかでは60fpsで撮る」: 明るさより60コマを優先する。
//   ①60コマちょうど(exact)を頼む(断られたら ideal に戻す) ②それでも50コマを切るなら、ISO(感度)を段々上げる
//   (Pixel 9a の実測: ISO を上げると露出時間が短いまま明るさが戻り、57コマが出た。代わりに映像がざらつく)。暗い知らせは出さない
// - 2026-11-22(中山さん「暗くなったらゲインをあげよう」B): 60コマが出ていても、映像が暗ければ ISO(ゲイン)を1段上げ、明るすぎれば1段下げる。
//   映像の明るさは1秒ごとに 32×18 に縮めて端末の中で測り、すぐ捨てる
// - 最初はオフ。計測(GA4)には何も送らない
import { readLocal, writeLocal } from './safe-storage.js';

const KEY = 'kendovar.smooth60';
const LOW_FPS = 50;
const LOW_SECONDS = 3; // 何秒続けて下回ったら、ISO を1段上げるか
const WARMUP_MS = 3000; // 開いた直後は露出が落ち着かないので数えない

let on = readLocal(KEY) === '1';
let getTrack = () => null;
let appliedId = '';
let level = 0; // 0: ISO は自動 / 1〜4: ISO を段々上げる(カメラが替わったら0に戻す)
const ISO_STEPS = [0, 400, 1600, 3200, Infinity]; // 端末の範囲に収める。Infinity = 最大
const MAX_LEVEL = ISO_STEPS.length - 1;
const DARK = 60; const BRIGHT = 150; // 映像の明るさ(0〜255)。暗い・明るすぎの目安
let darkSec = 0; let brightSec = 0;
let exactOk = true; // 60ちょうどを断られた端末は ideal にする
let isoOk = true; // ISO の指定を断られた端末は、ISO を指定しない
let lowSec = 0;
let openedAt = 0;
let frames = 0;

export function isSmooth60() { return on; }
export function setSmooth60(v) {
  on = !!v; writeLocal(KEY, on ? '1' : '0');
  appliedId = ''; lowSec = 0; level = 0; darkSec = 0; brightSec = 0;
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
  next.frameRate = exactOk && !sizeFirst.has(t.id) ? { exact: 60 } : { ideal: 60 };
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  // continuous や ISO に対応しない端末(iPhone など)は、60の頼みだけ
  const adv = {};
  if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
  if (isoOk && level > 0 && caps.iso && caps.iso.max) adv.iso = Math.max(caps.iso.min, Math.min(caps.iso.max, ISO_STEPS[level]));
  if (Object.keys(adv).length) next.advanced = [adv];
  return next;
}
// 60ちょうどを頼むと、画質が半分より小さくなるカメラ(Pixel 9a の自撮り: 60ちょうどは480×640しか出せず、しかも暗いと30コマ)は、
// そのカメラだけ「60はできれば」(ideal)にして、画質を守る(2026-11-22 中山さんの実機の診断)。外カメは今までどおり60ちょうど
const sizeFirst = new Set();
function wantShortOf(c) {
  const v = (x) => (x == null ? 0 : typeof x === 'number' ? x : x.ideal || x.exact || x.min || 0);
  const w = v(c && c.width); const h = v(c && c.height);
  return w && h ? Math.min(w, h) : 0;
}
let origApply = null;
function patchApply() {
  if (origApply || typeof MediaStreamTrack === 'undefined') return;
  origApply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    if (this.kind === 'video' && this === getTrack()) {
      base.set(this, { ...(c || {}) });
      const self = this;
      const checkSize = () => {
        if (!on || sizeFirst.has(self.id) || !exactOk) return undefined;
        const want = wantShortOf(c); const g = self.getSettings ? self.getSettings() : {};
        const got = Math.min(g.width || 0, g.height || 0);
        if (want && got && got * 2 < want) { sizeFirst.add(self.id); return twoStep(c).catch(() => {}); }
        return undefined;
      };
      // Chrome は、露出モード・ISO(advanced)が入った頼みでは、大きさ・コマ数を替えない(その頼みの大きさは無視される)。
      // そのため「最大」でも 480×640 のままだった(2026-11-22 中山さんの実機の診断で判明)。先に大きさ・コマ数だけを頼み、そのあと advanced を足して頼む
      const twoStep = (cc) => {
        const full = withSmooth(self, cc);
        if (!full.advanced) return origApply.call(self, full);
        const first = { ...full }; delete first.advanced;
        return origApply.call(self, first).then(() => origApply.call(self, full));
      };
      return twoStep(c).then(checkSize, (err) => {
        // 60ちょうどを出せない端末: ideal にして頼み直す
        // 断られた項目だけやめて、1回だけ頼み直す(60ちょうど → ideal、ISO → 指定しない)
        if (on && err && err.name === 'OverconstrainedError') {
          if (err.constraint === 'iso' && isoOk) { isoOk = false; return twoStep(c).then(checkSize); }
          if (exactOk && err.constraint !== 'iso') { exactOk = false; return twoStep(c).then(checkSize); }
        }
        throw err;
      });
    }
    return origApply.call(this, c);
  };
}

async function apply(force) {
  const t = getTrack();
  if (!t || t.readyState !== 'live' || typeof t.applyConstraints !== 'function') return;
  if (!force && t.id === appliedId) return;
  if (t.id !== appliedId) { openedAt = performance.now(); lowSec = 0; level = 0; darkSec = 0; brightSec = 0; }
  appliedId = t.id;
  if (!base.has(t)) { const c = (t.getConstraints && t.getConstraints()) || {}; delete c.advanced; delete c.frameRate; base.set(t, c); }
  // 新しいカメラで、オフのままなら何もしない(余計に頼み直さない)
  if (!on && !force) return;
  try { await t.applyConstraints(base.get(t)); } catch (err) { /* 頼めない端末は、今のまま */ }
}

// 映像の明るさ(0〜255の平均)。端末の中で測ってすぐ捨てる
let lumaVideo = null; const lc = typeof document !== 'undefined' ? document.createElement('canvas') : null; let lctx = null;
function measureLuma() {
  const v = lumaVideo; if (!v || !lc || !v.videoWidth) return null;
  try {
    if (!lctx) { lc.width = 32; lc.height = 18; lctx = lc.getContext('2d', { willReadFrequently: true }); }
    lctx.drawImage(v, 0, 0, 32, 18);
    const d = lctx.getImageData(0, 0, 32, 18).data; let s2 = 0;
    for (let i = 0; i < d.length; i += 4) s2 += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return s2 / (d.length / 4);
  } catch (err) { return null; }
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
  lumaVideo = video;
  setInterval(() => {
    apply(false);
    const fps = frames; frames = 0;
    const t = getTrack();
    if (!on || !t || document.hidden || performance.now() - openedAt < WARMUP_MS) { lowSec = 0; return; }
    lowSec = fps > 0 && fps < LOW_FPS ? lowSec + 1 : 0;
    const luma = measureLuma();
    darkSec = luma != null && luma < DARK ? darkSec + 1 : 0;
    brightSec = luma != null && luma > BRIGHT ? brightSec + 1 : 0;
    let next = level;
    if ((lowSec >= LOW_SECONDS || darkSec >= 2) && level < MAX_LEVEL) next = level + 1; // 60が出ない・暗い: ゲインを上げる
    else if (brightSec >= 3 && level > 0 && fps >= LOW_FPS) next = level - 1;          // 明るすぎ: ゲインを下げる
    if (next !== level) {
      level = next; lowSec = 0; darkSec = 0; brightSec = 0; openedAt = performance.now();
      t.applyConstraints(base.get(t) || {}).catch(() => {});
    }
  }, 1000);
}
