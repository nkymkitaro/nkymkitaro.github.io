// wakeLock.js: 画面が自動でオフ/暗転しないようにする(Screen Wake Lock API)。
// 撮影中に画面が消えるとカメラ映像も止まってしまうため、親機・子機どちらでも
// カメラ動作中はこれを有効化しておく。
//
// 制約: タブが非表示(バックグラウンド)になると自動的に解除されるため、
// 再度表示されたタイミングで取り直す。また、ユーザーが手動で画面をロックする
// 操作(電源ボタン等)までは防げない — これはOS/ブラウザの仕様上の限界で、
// Web標準の範囲では回避できない。
import { showToast } from './toast.js';

let wakeLock = null;
let enabled = false;

async function acquire() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// 撮影を始めるタイミングで一度だけ呼ぶ。以後はvisibilitychangeで自動的に再取得する。
export async function enableWakeLock() {
  if (enabled) return;
  enabled = true;
  const ok = await acquire();
  if (ok) {
    showToast('画面が自動でオフにならないようにしました(バッテリー消費が増えるため、電源に繋いでおくのがおすすめです)');
  } else if (!('wakeLock' in navigator)) {
    showToast('この端末は画面の自動オフ防止に対応していません。設定で画面のロック時間を長めにしておいてください');
  }
}

document.addEventListener('visibilitychange', () => {
  if (enabled && document.visibilityState === 'visible' && !wakeLock) {
    acquire();
  }
});
