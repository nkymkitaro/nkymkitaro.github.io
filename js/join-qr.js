// join-qr.js: 「QRコードを読むだけで、カメラとして参加」のQRを、はじめた端末(親機)に出す部品。
// - 中身は https://kendovar.jp/?join=1234&openExternalBrowser=1 の形(番号はその時の4桁)。番号の表示も残す(QRが読めないとき用)
// - QRを作る処理は js/vendor/qrcode.mjs(リポジトリ内。外部サービス・CDNは使わない)。使うときに初めて読み込む
// - 親機の撮影画面には常時は出さず、「カメラを追加」を押したときだけ、白地いっぱいに大きく出す(離れたスマホのカメラで読むには、大きいほどよい。2026-10-19 に変更)
// - 新しいカメラがつながったら、大きい表示は自動で閉じる(app.js から closeJoinQr。同じカメラの再接続では閉じない)
// - QRを作れなかった・読み込めなかったときは、QRを出さないだけで、接続IDでの参加は今までどおり使える
import { attachPress } from './press-feedback.js';
import { showToast } from './toast.js';

// QRの行き先。どの端末・どのURLで開いていても、本番のドメインに向ける
export const JOIN_BASE_URL = 'https://kendovar.jp/';
const JOIN_PARAM = 'join';
const CODE_PATTERN = /^\d{4}$/;
const QUIET_ZONE = 4; // 白い余白(モジュール数)。規格どおり4。これが狭いと読めない
// 訂正レベル。M(約15%まで欠けても読める)。openExternalBrowser を足して URL が52文字になったので、
// バージョン4(33マス角)になる。L にすると29マス角のままだが、映り込みや汚れに弱くなるため M のままにした(2026-10-12)
const ERROR_CORRECTION = 'M';
// LINEのQR読み取りで読んだときも、LINEの中ではなく標準ブラウザで開くようにする(LINEの仕様。js/in-app-browser.js と同じ名前)
const EXTERNAL_PARAM = 'openExternalBrowser=1';

// 参加用のURL。via: 'share' は「リンクを送る」で送ったもの(解析用。参加のしかたを 'link' と数える)
const VIA_PARAM = 'via';
const VIA_SHARE = 'share';
export function buildJoinUrl(code, via) {
  return `${JOIN_BASE_URL}?${JOIN_PARAM}=${encodeURIComponent(code)}&${EXTERNAL_PARAM}${via === VIA_SHARE ? `&${VIA_PARAM}=${VIA_SHARE}` : ''}`;
}

// 開いたURLから、参加のしかたを決める('link' = 送られたリンク / 'qr' = QR)
export function parseJoinMethod(search) {
  try {
    return new URLSearchParams(search).get(VIA_PARAM) === VIA_SHARE ? 'link' : 'qr';
  } catch (err) {
    return 'qr';
  }
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
    url.searchParams.delete(VIA_PARAM);
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
    return toSvg(qr, `カメラで参加するためのQRコード。番号 ${code}`);
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

// 「カメラを追加」を押すと、QRと接続IDを大きく出す。code は親機の4桁の番号
// QRを作れなかったときも、接続IDと案内は出す(番号で参加できる)
// beforeOpen(proceed): 押したときに先に何かを出すとき true を返す(続きは proceed で呼ぶ)。「準備ページを、初めて押したときに出す」ために使う
export async function initJoinQr(code, { beforeOpen } = {}) {
  const button = document.getElementById('btnAddCamera');
  overlay = document.getElementById('qrOverlay');
  if (!button || !overlay) return;
  document.getElementById('qrBigCode').textContent = code;
  const svg = await createJoinQrSvg(code);
  const big = document.getElementById('qrBig');
  if (svg) big.innerHTML = svg;
  else big.hidden = true; // QRなし。接続IDだけで使える

  attachPress(button, { vibrate: 12 });
  button.addEventListener('click', () => { if (beforeOpen && beforeOpen(openOverlay)) return; openOverlay(); });
  const closeBtn = overlay.querySelector('#btnQrClose');
  attachPress(closeBtn, { vibrate: 0 });
  closeBtn.addEventListener('click', closeJoinQr);
  overlay.addEventListener('click', closeJoinQr); // どこを押しても閉じる
  const shareBtn = overlay.querySelector('#btnQrShare');
  if (shareBtn) {
    attachPress(shareBtn, { vibrate: 12 });
    shareBtn.addEventListener('click', (event) => {
      event.stopPropagation(); // ここを押しても、大きい表示は閉じない(送り終わってから閉じる/そのまま使えるように)
      shareJoinLink(code);
    });
  }
}

// 送る文面。言葉はデザインポリシー 11章に合わせている(「子機」「参加する」の代わりに、受け取る人が分かる言い方)
// (2026-10-28 変更: 前の文は「稽古を別の角度から撮りたいので、2台目として参加してもらえますか。」から始まっていた。最初に気づく一言として、先にネットワークを案内する)
const SHARE_TEXT = 'MITORIで撮影に参加してください。先に、同じWi‑Fiにつなぐか、はじめたスマホのテザリングに入ってから、このリンクを開いてください。';

// 「リンクを送る」: OSの共有画面(LINEなどを選べる)を開く。使えない端末(PCなど)では、文面とリンクをコピーする。
// 送る前にこちらからは通信しない。リンクに入るのは接続IDだけ(映像・個人情報は含まない)
export async function shareJoinLink(code) {
  const message = `${SHARE_TEXT}\n${buildJoinUrl(code, VIA_SHARE)}`;
  if (navigator.share) {
    try {
      await navigator.share({ text: message });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 共有画面を閉じただけ
      // 共有画面を開けなかったときは、コピーに切り替える
    }
  }
  const copied = await copyText(message);
  showToast(copied ? 'コピーしました' : 'コピーできませんでした');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) { /* 下の方法を試す */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (err) {
    return false;
  }
}
