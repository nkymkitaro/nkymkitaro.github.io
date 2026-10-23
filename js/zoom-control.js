// zoom-control.js: 撮影中のカメラのズーム(各カメラの端末の画面から操作する)。
// - カメラ自体のズームを使う(MediaStreamTrack.applyConstraints の zoom)。画面の切り取り(デジタルズーム)は作らない
// - 範囲は端末の getCapabilities().zoom から取る。対応していない端末では、操作を画面に出さない
// - 操作は、下のスライダーと倍率の表示だけ(ピンチは使わない。撮影中の画面の操作と取り合うため)
// - 値は覚えない。カメラを取り直したら1倍に戻る(refresh)
// - 録画の仕組みには触れない。映像の取り込み元(トラック)に倍率を指示するだけ
// 動きと手触りの値は css/style.css の :root の共通設定を使う(デザインポリシー 2-4)。
import { tapFeedback } from './haptics.js';

const TICK_VIBRATE_MS = 8; // 整数の倍率を通るときの小さな振動(シークと同じ強さ)

export function zoomSupport(track) {
  try {
    const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
    const z = caps && caps.zoom;
    if (!z || !(z.max > z.min)) return null;
    return { min: z.min, max: z.max, step: z.step > 0 ? z.step : 0.1 };
  } catch (err) {
    return null;
  }
}

// parent: 操作を入れる要素。getTrack: 今のカメラの映像トラックを返す関数(なければ null)
export function createZoomControl({ parent, getTrack, className = '' }) {
  const root = document.createElement('div');
  root.className = `zoom-ctl ${className}`.trim();
  root.hidden = true;
  const readout = document.createElement('span');
  readout.className = 'zoom-readout';
  readout.setAttribute('aria-live', 'off');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'zoom-slider';
  slider.setAttribute('aria-label', 'ズーム');
  root.append(slider, readout);
  parent.appendChild(root);

  let support = null;
  let track = null;
  let pending = null; // 指示待ちの倍率(つづけて動かしたときは、最新だけを送る)
  let applying = false;
  let lastInt = 1;

  const fmt = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}×`;

  async function flush() {
    if (applying) return;
    applying = true;
    while (pending !== null) {
      const v = pending;
      pending = null;
      try {
        if (track) await track.applyConstraints({ advanced: [{ zoom: v }] });
      } catch (err) {
        // 指示が通らなかったときは、いまの倍率に表示を合わせる
        try { const cur = track && track.getSettings().zoom; if (cur) { slider.value = cur; readout.textContent = fmt(cur); } } catch (e2) { /* 無視 */ }
      }
    }
    applying = false;
  }

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    readout.textContent = fmt(v);
    const whole = Math.floor(v + 1e-6);
    if (whole !== lastInt) { lastInt = whole; tapFeedback(TICK_VIBRATE_MS); }
    pending = v;
    flush();
  });

  // カメラを取り直したとき・つながったときに呼ぶ。対応していなければ出さない
  function refresh() {
    track = getTrack();
    support = zoomSupport(track);
    if (!support) { root.hidden = true; return false; }
    slider.min = support.min;
    slider.max = support.max;
    slider.step = support.step;
    slider.value = support.min; // 値は覚えない。1倍(最小)から
    lastInt = Math.floor(support.min + 1e-6);
    readout.textContent = fmt(support.min);
    root.hidden = false;
    return true;
  }

  return {
    refresh,
    el: root,
    // 見せるかどうか(見ているカメラが別のとき、リプレイ中などは、CSSの側でも隠す)
    setActive(active) { root.classList.toggle('zoom-inactive', !active); },
    get supported() { return !!support; },
  };
}
