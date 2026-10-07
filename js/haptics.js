// haptics.js: ボタンを押せたことを、振動で手に伝える。
// 稽古・試合の直後で手が震えていると、押せたかどうかが分かりにくいため。
// (Androidのブラウザで有効。iPhoneのSafariは振動に対応していないので何も起きない)
export function tapFeedback(pattern = 30) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (err) {
    // 振動が使えない環境では何もしない
  }
}
