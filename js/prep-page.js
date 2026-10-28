// prepPage.js: 「はじめる前に」準備ページ(2台以上で使うときの準備)。
// - 初めて「カメラを追加」を押したときに1回だけ出す(見たかの目印は SEEN_KEY。2026-10-28 に、スタート画面の前から移した)
// - 「準備OK」を押すと、続き(参加用のQRの表示)へ進む。「1台だけで使う」は、続きへ進まず閉じる
// - ヘルプの一番上からいつでも開ける(openPrep)
// - 手触り(押した時の沈み・振動)は共通部品 press-feedback、動きの値は css/style.css の :root を使う
import { attachPress } from './press-feedback.js';

const SEEN_KEY = 'kendo-var-prep-seen';

// 準備ページを見たことがあるか。読めない環境では、見ていないことにする(毎回出てもよい)
export function isPrepSeen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (err) { return false; }
}

// 見たことを端末に覚えておく。保存できない環境では、毎回出てもよい
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch (err) { /* 覚えられなくても使える */ }
}

// onFirstRunSolo: 初回の表示で「1台だけで使う」を押したときに呼ばれる(スタート画面の「前回」の印用)
// onChoice('ok' | 'single'): どちらのボタンを押したか(解析用)
export function initPrepPage({ onFirstRunSolo, onChoice } = {}) {
  const area = document.getElementById('prepArea');
  if (!area) return;
  const steps = Array.from(area.querySelectorAll('.prep-step'));
  const okButton = document.getElementById('btnPrepOk');
  const soloButton = document.getElementById('btnPrepSolo');
  const root = document.documentElement;
  let onOk = null; // openPrep({ onOk }) で渡された続き
  area._setOnOk = (fn) => { onOk = fn; };
  area._quiet = false; // 子機の失敗の案内から開いたときは、解析(prep_choice)に数えない
  let firstRun = root.classList.contains('needs-prep'); // 以前の「初回に自動で出す」形の名残。今は付かない

  // ステップを押すと、右の丸にチェックが付く(もう一度押すと外れる)。全部付くと「準備OK！」になる
  function updateOkLabel() {
    const all = steps.every((s) => s.getAttribute('aria-pressed') === 'true');
    okButton.textContent = all ? '準備OK！' : '準備OK';
  }
  steps.forEach((step) => {
    attachPress(step, { vibrate: 12 });
    step.addEventListener('click', () => {
      step.setAttribute('aria-pressed', step.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      updateOkLabel();
    });
  });
  attachPress(okButton, { vibrate: 30 });
  attachPress(soloButton, { vibrate: 12 });

  function close({ solo }) {
    const wasFirstRun = firstRun;
    firstRun = false;
    markSeen();
    area.classList.remove('show');
    root.classList.remove('needs-prep');
    if (onChoice && !area._quiet) onChoice(solo ? 'single' : 'ok');
    if (solo && wasFirstRun && onFirstRunSolo) onFirstRunSolo();
    const next = onOk; onOk = null;
    if (!solo && next) next(); // 「カメラを追加」から開いたときの続き
  }
  okButton.addEventListener('click', () => close({ solo: false }));
  soloButton.addEventListener('click', () => close({ solo: true }));

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !firstRun) { onOk = null; close({ solo: false }); } // 閉じるだけ(続きへは進まない)
  });
}

// ヘルプなどから開く。チェックは付け直せるよう、毎回外しておく
// onOk: 「準備OK」を押したあとに呼ぶ(「カメラを追加」から開いたとき、参加用のQRを出す)
export function openPrep({ onOk, quiet = false } = {}) {
  const area = document.getElementById('prepArea');
  if (!area) return;
  if (area._setOnOk) area._setOnOk(onOk || null);
  area._quiet = quiet;
  area.querySelectorAll('.prep-step').forEach((s) => s.setAttribute('aria-pressed', 'false'));
  document.getElementById('btnPrepOk').textContent = '準備OK';
  area.classList.add('show');
  const title = document.getElementById('prepTitle');
  if (title) title.focus({ preventScroll: true });
  area.scrollTop = 0;
}
