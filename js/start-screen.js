// startScreen.js: スタート画面(「はじめる」/「カメラで参加」)の動き(デザインポリシー 2-4・11章)。
// - パネルに触れた瞬間に少し沈む(attachPress)
// - 選んだパネルが画面いっぱいに広がってから、次の画面に切り替える(--dur-base。動きで待たせない)
// - 前回選んだほうに「前回」の印を付ける。自動で進めることはしない
// - 「動きを減らす」設定の端末では、広がる動きを省いてすぐ切り替える
import { attachPress } from './press-feedback.js';
import { motionMs } from './motion.js';

const STORAGE_KEY = 'kendo-var-last-role';

// 端末に覚えておく。保存できない環境(プライベートブラウズなど)でも画面の動作には影響させない
function loadLastRole() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (err) { return null; }
}
function saveLastRole(role) {
  try { localStorage.setItem(STORAGE_KEY, role); } catch (err) { /* 保存できなくても使える */ }
}

// パネルの位置と色をそのまま写した板を出し、画面いっぱいに広げてから next を呼ぶ
function expandFrom(panel, next) {
  const duration = motionMs('--dur-base');
  if (duration === 0) { next(); return; }

  const rect = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  const cover = panel.cloneNode(true);
  cover.removeAttribute('id');
  cover.classList.add('start-expander');
  cover.classList.remove('press', 'is-pressed');
  cover.style.cssText = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;border-radius:${style.borderRadius};`;
  document.body.appendChild(cover);
  void cover.offsetWidth; // 一度レイアウトさせてから動かさないと、広がるアニメーションにならない
  cover.style.top = '0px';
  cover.style.left = '0px';
  cover.style.width = '100vw';
  cover.style.height = '100vh';
  cover.style.height = '100dvh';
  cover.style.borderRadius = '0px';

  setTimeout(() => {
    next();
    cover.classList.add('fade-out'); // 切り替わった画面へ、ひと息で入れ替わる
    setTimeout(() => cover.remove(), motionMs('--dur-fast') + 50);
  }, duration);
}

// handlers: { monitor: () => void, camera: () => void }
export function initStartScreen(handlers) {
  const panels = Array.from(document.querySelectorAll('.start-panel'));
  const last = loadLastRole();
  let leaving = false; // 手が震えて二度押ししても、画面の切り替えは1回だけ

  panels.forEach((panel) => {
    const role = panel.dataset.role;
    const mark = panel.querySelector('.start-last');
    if (mark) mark.hidden = role !== last;
    attachPress(panel, { vibrate: 30 });
    panel.addEventListener('click', () => {
      if (leaving) return;
      leaving = true;
      saveLastRole(role);
      expandFrom(panel, handlers[role]);
    });
  });
}
