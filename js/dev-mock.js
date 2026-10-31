// dev-mock.js: 2台目・3台目のカメラが「つながったことにする」確認用の部品(2026-10-31)。
// ?mockcams=2 のようにURLに付けたときだけ、app.js が読み込む。通常の利用では読み込まれない。
// 親機の映像を複製して、子機の映像のかわりにする。実際の通信(PeerJS)は使わない。
// 目的: 2台以上のときの画面の配置(右の列の収まり、切り替えボタン)を、実機がなくても確かめる(css/style.css・js/ui-audit)
export function installMockCams(cameraLink, count) {
  const n = Math.min(3, Math.max(1, count | 0));
  const start = () => {
    const stream = cameraLink.localMonitorVideo.srcObject;
    if (!stream) { setTimeout(start, 300); return; }
    for (let i = 0; i < n; i++) {
      const videoEl = document.createElement('video');
      videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true;
      videoEl.style.display = 'none';
      videoEl.srcObject = stream.clone();
      document.body.appendChild(videoEl);
      videoEl.play().catch(() => {});
      const number = i + 2;
      cameraLink.remoteCams.push({ id: `mock${number}`, label: `カメラ${number}`, number, videoEl, connected: true, call: null, dataConn: null });
    }
    cameraLink._notifyCamsChanged();
  };
  start();
}
