// app.js: このアプリの合成ルート(composition root)。
// - CameraLink と VARPlayer をここで生成して繋ぎ合わせる
// - HTMLにonclickを書かず、ボタンとロジックの対応関係をここに一元化する
//   (「このボタンは何をするか」を知りたければこのファイルだけ見ればよい)
import { CameraLink } from './camera-link.js';
import { VARPlayer } from './var-player.js';

const cameraLink = new CameraLink();
const player = new VARPlayer(
  document.getElementById('displayCanvas'),
  () => cameraLink.getActiveVideoElement()
);

function startMonitor() {
  document.getElementById('setupArea').style.display = 'none';
  document.getElementById('monitorArea').style.display = 'block';
  cameraLink.startAsMonitor((video) => {
    player.canvas.width = video.videoWidth || 480;
    player.canvas.height = video.videoHeight || 360;
    player.start();
  });
}

function startCamera() {
  document.getElementById('setupArea').style.display = 'none';
  document.getElementById('cameraArea').style.display = 'block';
  cameraLink.startAsCamera();
}

function connectToMonitor() {
  const targetId = document.getElementById('targetIdInput').value.trim();
  if (!targetId) return alert('IDを入力してください');
  cameraLink.connectToMonitor(targetId);
}

function switchCameraSource(source) {
  cameraLink.switchSource(source, () => {
    player.clearBuffer();
    if (player.isReplay) player.goLive();
  });
}

// --- 使い方ヘルプ(ボトムシート) ---
const helpSheet = document.getElementById('helpSheet');
const helpOverlay = document.getElementById('helpOverlay');

function openHelp() {
  helpSheet.classList.add('open');
  helpOverlay.classList.add('open');
}

function closeHelp() {
  helpSheet.classList.remove('open');
  helpOverlay.classList.remove('open');
}

// --- イベント配線 ---
document.getElementById('btnStartMonitor').addEventListener('click', startMonitor);
document.getElementById('btnStartCamera').addEventListener('click', startCamera);
document.getElementById('btnConnectToMonitor').addEventListener('click', connectToMonitor);

document.getElementById('btnCamLocal').addEventListener('click', () => switchCameraSource('local'));
document.getElementById('btnCamRemote').addEventListener('click', () => switchCameraSource('remote'));

document.getElementById('btnRewind').addEventListener('click', () => player.rewind(15));
document.getElementById('btnGoLive').addEventListener('click', () => player.goLive());
document.getElementById('btnStepBack').addEventListener('click', () => player.stepFrame(-1));
document.getElementById('btnPlayPause').addEventListener('click', () => player.togglePlayPause());
document.getElementById('btnStepForward').addEventListener('click', () => player.stepFrame(1));
document.getElementById('btnSpeed').addEventListener('click', () => player.cycleSpeed());
document.getElementById('seekBar').addEventListener('input', (e) => player.onSeekInput(e.target.value));

document.getElementById('btnHelp').addEventListener('click', openHelp);
document.getElementById('btnCloseHelp').addEventListener('click', closeHelp);
helpOverlay.addEventListener('click', closeHelp);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelp();
});
