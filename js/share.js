// share.js: 「仲間に送る」(アプリの紹介)と、動画のファイル共有。
// - 映像はサーバーに置かない。端末の共有画面で、ファイルのまま直接送る
// - 送る文面はアプリの紹介だけ。名前・場所・番号などは付けない
import { showToast } from './toast.js';
import { track } from './analytics.js';
import { copyText } from './join-qr.js';

const APP_URL = 'https://kendovar.jp/?utm_source=app_invite&utm_medium=share';
const APP_TEXT = 'MITORI。スマホで撮って、その場で見返す。2台なら、死角からも。';

// 「仲間に送る」: 共有画面を開く。開けない端末では、文面とリンクをコピーする
export async function shareApp() {
  const message = `${APP_TEXT}\n${APP_URL}`;
  if (navigator.share) {
    track('share_app');
    try {
      await navigator.share({ text: message });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 共有画面を閉じただけ
      // 開けなかったときは、コピーに切り替える
    }
  }
  const copied = await copyText(message);
  showToast(copied ? 'コピーしました' : 'コピーできませんでした');
}

// 保存の直後の知らせ。「仲間に送る」を1つだけ添える(録画の終わりには出さない)
export function offerAppShare() {
  showToast('保存しました', { duration: 6000, action: { label: '仲間に送る', onClick: shareApp } });
}

// 動画ファイルを共有画面で送れる端末か(使えないなら、共有ボタンは出さない)
let fileShareOk;
export function canShareVideoFiles() {
  if (fileShareOk !== undefined) return fileShareOk;
  try {
    const probe = new File([new Uint8Array(1)], 'MITORI.mp4', { type: 'video/mp4' });
    fileShareOk = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch (err) {
    fileShareOk = false;
  }
  return fileShareOk;
}

// 'shared'(開いた) / 'cancelled'(閉じた) / 'blocked'(押した操作の効力が切れて開けない) / 'failed'
export async function shareVideoFiles(files, title = 'MITORI 録画') {
  try {
    if (!navigator.canShare || !navigator.canShare({ files })) return 'failed';
    track('share_clip');
    await navigator.share({ files, title });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled';
    if (err && err.name === 'NotAllowedError') return 'blocked';
    return 'failed';
  }
}
