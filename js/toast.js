// toast.js: ブラウザ標準のalert()を置き換える、軽量な通知UI。
// 「◯◯の内容」というブラウザ純正ダイアログの野暮ったさを避け、
// アプリのトーン(暗色・角丸カード)に合わせた通知を上部に短く出す。
let hideTimer = null;

export function showToast(message, { duration = 3200 } = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}
