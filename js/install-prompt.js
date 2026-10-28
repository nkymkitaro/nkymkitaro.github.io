// installPrompt.js: 「ホーム画面に追加」をボタン1つでできるようにする。
// Android Chrome などは、追加できる状態になると beforeinstallprompt を送ってくるので、
// それを控えておき、ボタンが押されたときに追加の確認画面を出す。
// iPhone(Safari)にはこの仕組みがないため、ボタンは出さず、ヘルプの手順案内に任せる。
// LINEなどのアプリ内ブラウザでは追加できないので、ボタンを出さない(判定は js/in-app-browser.js)。
import { showToast } from './toast.js';

// 追加できたときの知らせ。ホーム画面に置かれたかはブラウザから分からない(端末のホームアプリの設定で決まる)ので、
// アプリ一覧の場所も添える
const INSTALLED_MESSAGE = '追加しました。ホーム画面にない場合は、アプリ一覧から置けます。';
const INSTALLED_NOTICE_MS = 5000;

let deferredPrompt = null;

function isInAppBrowser() {
  return !!(window.kendoInApp && window.kendoInApp.isInApp());
}

function setButtonsVisible(visible) {
  const show = visible && !isInAppBrowser();
  document.querySelectorAll('.install-btn').forEach((btn) => {
    btn.classList.toggle('show', show);
  });
}

// 知らせはトーストで出す。後半は「次にどうするか」の案内で、1行のサブ帯には収まらないため(デザインポリシー 8章)
function notifyInstalled() {
  showToast(INSTALLED_MESSAGE, { duration: INSTALLED_NOTICE_MS });
}

// ブラウザが「追加」の仕組みを渡してきているか(Android の Chrome など)。最初のVARのあとの案内(home-nudge.js)が使う
export function canPromptInstall() { return !!deferredPrompt; }

// 追加の確認画面を出す。出せたら true
export async function promptInstall() {
  if (!deferredPrompt) return false;
  const promptEvent = deferredPrompt;
  deferredPrompt = null;
  setButtonsVisible(false);
  try {
    await promptEvent.prompt();
    await promptEvent.userChoice;
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
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
    notifyInstalled();
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
