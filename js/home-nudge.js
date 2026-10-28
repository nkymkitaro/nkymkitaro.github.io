// home-nudge.js: 最初のVARを見終えてLIVEに戻ったとき、「ホーム画面に追加」を1回だけ勧める(2026-10-28。依頼: 2026-10-28-to-coder-home-screen-nudge.md)。
// - 出す条件: ホーム画面から開いていない / アプリ内ブラウザ(LINEなど)ではない / 親機(LIVEに戻る操作は親機にだけある) / 以前に閉じた・追加したことがない
// - Android(追加の仕組みを渡されているとき): 「ホーム画面に追加」ボタン。iPhoneなど渡されていないとき: 手順の絵(3コマ)
// - 閉じる・追加する・VAR/カメラ切り替えを操作する、のどれかで、二度と出さない(端末に覚える)。自動では消さない
// - 計測は足さない(app_open の display_mode と utm_source=home で見える)
import { canPromptInstall, promptInstall } from './install-prompt.js';
import { attachPress } from './press-feedback.js';

const DONE_KEY = 'kendo-var-home-nudge-done';

function isDone() {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch (err) { return false; }
}
function markDone() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch (err) { /* 覚えられなくても使える */ }
}
function isStandalone() {
  return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function isInApp() {
  return !!(window.kendoInApp && window.kendoInApp.isInApp());
}
function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const MENU_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const APP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="12" cy="12" r="4"/></svg>';
const ARROW = '<svg class="nudge-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

let el = null;

function build() {
  el = document.createElement('div');
  el.id = 'homeNudge';
  el.className = 'home-nudge';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'ホーム画面に追加');
  el.hidden = true;
  document.body.appendChild(el);
}

function place() {
  // 縦向き: 「カメラを追加」の上。横向き: 映像の左下(右の列は操作で使うため)
  const add = document.getElementById('btnAddCamera');
  const landscape = window.innerWidth > window.innerHeight;
  if (!landscape && add && add.offsetParent) {
    el.style.bottom = `${Math.max(12, window.innerHeight - add.getBoundingClientRect().top + 10)}px`;
  } else {
    el.style.bottom = '12px';
  }
}

function hide({ remember = true } = {}) {
  if (!el) return;
  el.hidden = true;
  if (remember) markDone();
}

// 「LIVEに戻る」のあとに呼ぶ。条件を満たすときだけ、1回出す
let waitTimer = null;
// 立場の問いは0.7秒後に開くので、それより後に見る
export function maybeShowHomeNudge() {
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => check(0), 1200);
}
function check(tries) {
  if (isDone() || isStandalone() || isInApp()) return;
  // 立場の問い(role-survey.js)が開いているときは、重ならないよう、閉じるのを待つ(最長20秒。待っても閉じなければ出さない)
  const survey = document.getElementById('roleSheet');
  if (survey && survey.classList.contains('open')) {
    clearTimeout(waitTimer);
    if (tries < 40) waitTimer = setTimeout(() => check(tries + 1), 500);
    return;
  }
  if (document.getElementById('monitorArea') && document.getElementById('monitorArea').classList.contains('replaying')) return; // 見返している最中は出さない
  if (!el) build();
  if (!el.hidden) return;
  const steps = canPromptInstall() ? null : (isIos()
    ? [SHARE_ICON, PLUS_ICON, APP_ICON]
    : [MENU_ICON, PLUS_ICON, APP_ICON]);
  el.innerHTML = `
    <div class="home-nudge-head">
      <p class="home-nudge-text">ホーム画面に追加すると、すぐ開けます。</p>
      <button type="button" class="home-nudge-close" aria-label="閉じる"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    ${steps
      ? `<div class="home-nudge-steps" aria-hidden="true">${steps.join(ARROW)}</div>
         <p class="home-nudge-hint">${isIos() ? '共有 → 「ホーム画面に追加」' : 'メニュー → 「ホーム画面に追加」'}</p>`
      : '<button type="button" class="home-nudge-add">ホーム画面に追加</button>'}`;
  const close = el.querySelector('.home-nudge-close');
  attachPress(close, { vibrate: 0 });
  close.addEventListener('click', () => hide());
  const add = el.querySelector('.home-nudge-add');
  if (add) {
    attachPress(add, { vibrate: 12 });
    add.addEventListener('click', async () => { hide(); await promptInstall(); });
  }
  place();
  el.hidden = false;
}

// VARを押す・カメラを切り替えるなど、操作を始めたら閉じる(閉じた扱い。二度と出さない)
document.addEventListener('pointerdown', (e) => {
  if (!el || el.hidden) return;
  if (e.target.closest && e.target.closest('#btnRewind, #camSelector, #btnPauseAll, #btnSettings')) hide();
}, true);
window.addEventListener('resize', () => { if (el && !el.hidden) place(); });
window.addEventListener('appinstalled', () => { if (el && !el.hidden) hide(); else markDone(); });
