// join-qr.js: 「QRコードを読むだけで、カメラとして参加」のQRを、はじめた端末(親機)に出す部品。
// - 中身は https://kendovar.jp/?join=1234 の形(番号はその時の4桁)。番号の表示も残す(QRが読めないとき用)
// - QRを作る処理は js/vendor/qrcode.mjs(リポジトリ内。外部サービス・CDNは使わない)。使うときに初めて読み込む
// - 親機の画面に小さく出し、押すと白地いっぱいに大きく出す(離れたスマホのカメラで読むには、大きいほどよい)
// - 子機がつながったら、大きい表示は自動で閉じる(app.js から closeJoinQr)
// - QRを作れなかった・読み込めなかったときは、QRを出さないだけで、番号での参加は今までどおり使える
import { attachPress } from './press-feedback.js';

// QRの行き先。どの端末・どのURLで開いていても、本番のドメインに向ける
export const JOIN_BASE_URL = 'https://kendovar.jp/';
const JOIN_PARAM = 'join';
const CODE_PATTERN = /^\d{4}$/;
const QUIET_ZONE = 4; // 白い余白(モジュール数)。規格どおり4。これが狭いと読めない
const ERROR_CORRECTION = 'M'; // 29桁のURLが、いちばん粗い(=1マスが大きい)バージョン3に収まる最も強い訂正レベル

// 参加用のURL
export function buildJoinUrl(code) {
  return `${JOIN_BASE_URL}?${JOIN_PARAM}=${encodeURIComponent(code)}`;
}

// 「?join=1234」から番号を取り出す。4桁の数字でなければ null(普通に開いたときと同じにする)
export function parseJoinParam(search) {
  try {
    const value = new URLSearchParams(search).get(JOIN_PARAM);
    return value && CODE_PATTERN.test(value) ? value : null;
  } catch (err) {
    return null;
  }
}

// URLから ?join= を消す(再読み込みで古い番号につなぎに行かないように)。ほかの引数と # は残す
export function removeJoinParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(JOIN_PARAM)) return;
    url.searchParams.delete(JOIN_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) { /* 消せなくても、参加には影響しない */ }
}

// QR(qrcode-generator の結果)を、白地に黒の SVG 文字列にする。くっついた黒マスは1本の線にまとめる
function toSvg(qr, label) {
  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) { col++; continue; }
      const start = col;
      while (col < count && qr.isDark(row, col)) col++;
      path += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// 番号からQRの SVG を作る(読み込めなければ null)
export async function createJoinQrSvg(code) {
  try {
    const { qrcode } = await import('./vendor/qrcode.mjs');
    const qr = qrcode(0, ERROR_CORRECTION); // 0 = 長さに合わせて最小のバージョンを選ぶ
    qr.addData(buildJoinUrl(code), 'Byte');
    qr.make();
    return toSvg(qr, `カメラで参加するためのQRコード。接続ID ${code}`);
  } catch (err) {
    return null;
  }
}

let overlay = null;
let isOpen = false;

function openOverlay() {
  if (!overlay) return;
  overlay.hidden = false;
  isOpen = true;
  const closeBtn = overlay.querySelector('#btnQrClose');
  if (closeBtn) closeBtn.focus({ preventScroll: true });
}

// 大きい表示を閉じる
export function closeJoinQr() {
  if (!overlay || !isOpen) return;
  overlay.hidden = true;
  isOpen = false;
}

// 親機の画面にQRを出す。code は親機の4桁の番号
export async function initJoinQr(code) {
  const button = document.getElementById('btnJoinQr');
  overlay = document.getElementById('qrOverlay');
  if (!button || !overlay) return;
  const svg = await createJoinQrSvg(code);
  if (!svg) return; // QRなし。番号だけで使える
  document.getElementById('joinQrThumb').innerHTML = svg;
  document.getElementById('qrBig').innerHTML = svg;
  document.getElementById('qrBigCode').textContent = code;
  button.hidden = false;

  attachPress(button, { vibrate: 12 });
  button.addEventListener('click', openOverlay);
  const closeBtn = overlay.querySelector('#btnQrClose');
  attachPress(closeBtn, { vibrate: 0 });
  closeBtn.addEventListener('click', closeJoinQr);
  overlay.addEventListener('click', closeJoinQr); // どこを押しても閉じる
}
