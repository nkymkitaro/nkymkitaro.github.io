// prepPage.js: 「はじめる前に」準備ページ(2台以上で使うときの準備)。
// - 初めて開いたときに1回だけ、スタート画面の前に出す(出す・出さないの目印は、index.html の head と同じキー)
// - 「準備OK」「1台だけで使う」のどちらでも、押したらスタート画面へ進む
// - ヘルプの一番上からいつでも開ける(openPrep)
// - 手触り(押した時の沈み・振動)は共通部品 press-feedback、動きの値は css/style.css の :root を使う
import { attachPress } from './press-feedback.js';

const SEEN_KEY = 'kendo-var-prep-seen';

// 見たことを端末に覚えておく。保存できない環境では、毎回出てもよい
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch (err) { /* 覚えられなくても使える */ }
}

// onFirstRunSolo: 初回の表示で「1台だけで使う」を押したときに呼ばれる(スタート画面の「前回」の印用)
export function initPrepPage({ onFirstRunSolo } = {}) {
  const area = document.getElementById('prepArea');
  if (!area) return;
  const steps = Array.from(area.querySelectorAll('.prep-step'));
  const okButton = document.getElementById('btnPrepOk');
  const soloButton = document.getElementById('btnPrepSolo');
  const root = document.documentElement;
  let firstRun = root.classList.contains('needs-prep');

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
    if (solo && wasFirstRun && onFirstRunSolo) onFirstRunSolo();
  }
  okButton.addEventListener('click', () => close({ solo: false }));
  soloButton.addEventListener('click', () => close({ solo: true }));

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !firstRun) close({ solo: false });
  });
}

// ヘルプなどから開く。チェックは付け直せるよう、毎回外しておく
export function openPrep() {
  const area = document.getElementById('prepArea');
  if (!area) return;
  area.querySelectorAll('.prep-step').forEach((s) => s.setAttribute('aria-pressed', 'false'));
  document.getElementById('btnPrepOk').textContent = '準備OK';
  area.classList.add('show');
  const title = document.getElementById('prepTitle');
  if (title) title.focus({ preventScroll: true });
  area.scrollTop = 0;
}
