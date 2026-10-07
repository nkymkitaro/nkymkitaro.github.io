// pressFeedback.js: 押した手応え(デザインポリシー 2-4)。
// 指が触れた瞬間(離した時ではなく)にボタンを少し沈め、離すとバネのように戻す。
// 見た目と動きは css/style.css の .press / .is-pressed が持つ(動きの値は :root の共通設定)。
// 振動を付ける場合も、押した瞬間に返す(対応端末のみ。非対応なら見た目の反応だけ)。
// クリックの処理そのものは遅らせないので、動きの途中でも次の操作を受け付ける。
import { tapFeedback } from './haptics.js';

export function attachPress(el, { vibrate = 0 } = {}) {
  if (!el) return;
  el.classList.add('press');
  const release = () => el.classList.remove('is-pressed');
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    el.classList.add('is-pressed');
    if (vibrate) tapFeedback(vibrate);
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}
