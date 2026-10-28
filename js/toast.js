// toast.js: ブラウザ標準のalert()を置き換える、軽量な通知UI。
// 「◯◯の内容」というブラウザ純正ダイアログの野暮ったさを避け、
// アプリのトーン(暗色・角丸カード)に合わせた通知を上部に短く出す。
let hideTimer = null;

// action: { label, onClick } を渡すと、文の下にボタンを1つ出す(押すと onClick を呼び、知らせは閉じる)
export function showToast(message, { duration = 3200, action, fadeMs } = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.toggle('has-action', !!action);
  // fadeMs: 出入りの長さを替える(中継のお知らせの「ふわっと消える」0.5秒だけ。「動きを減らす」設定では、CSS側で止まる)
  toast.classList.toggle('slow-fade', !!fadeMs);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(hideTimer);
      toast.classList.remove('show');
      action.onClick();
    });
    toast.appendChild(btn);
  }
  toast.classList.add('show');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}
