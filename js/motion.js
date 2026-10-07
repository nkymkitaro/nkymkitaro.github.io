// motion.js: 動きの共通設定をJSから使うための窓口(デザインポリシー 2-4・10章)。
// 動きの速さ・弾み方の値そのものは css/style.css の :root(--dur-fast など)だけで決める。
// JSで時間を使う場合も、ここ経由でCSSの値を読み、画面ごとに値がばらつかないようにする。

// 端末で「動きを減らす」が設定されているか
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// CSS変数(例: '--dur-base')の値をミリ秒で返す。動きを減らす設定のときは 0
export function motionMs(name) {
  if (prefersReducedMotion()) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return 0;
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}
