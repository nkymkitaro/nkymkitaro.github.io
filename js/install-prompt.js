// installPrompt.js: 「ホーム画面に追加」をボタン1つでできるようにする。
// Android Chrome などは、追加できる状態になると beforeinstallprompt を送ってくるので、
// それを控えておき、ボタンが押されたときに追加の確認画面を出す。
// iPhone(Safari)にはこの仕組みがないため、ボタンは出さず、ヘルプの手順案内に任せる。
import { showToast } from './toast.js';

let deferredPrompt = null;

function setButtonsVisible(visible) {
  document.querySelectorAll('.install-btn').forEach((btn) => {
    btn.classList.toggle('show', visible);
  });
}

export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // ブラウザ任せのバナーではなく、アプリ内のボタンから出す
    deferredPrompt = e;
    setButtonsVisible(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setButtonsVisible(false);
    showToast('ホーム画面に追加しました。次回からはホーム画面のアイコンから開いてください');
  });

  document.querySelectorAll('.install-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      setButtonsVisible(false);
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch (err) {
        console.error(err);
      }
    });
  });
}
