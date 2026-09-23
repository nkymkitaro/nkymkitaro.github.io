// app.js: このアプリの合成ルート(composition root)。
// - CameraLink(カメラ接続) / MultiCamRecorder(常時バックグラウンド録画) / ReplayPlayer(再生)
//   をここで生成して繋ぎ合わせる
// - HTMLにonclickを書かず、ボタンとロジックの対応関係をここに一元化する
//   (「このボタンは何をするか」を知りたければこのファイルだけ見ればよい)
import { CameraLink } from './camera-link.js';
import { MultiCamRecorder } from './multi-cam-recorder.js';
import { ReplayPlayer } from './replay-player.js';
import { showToast } from './toast.js';

const cameraLink = new CameraLink();
const recorder = new MultiCamRecorder({ fps: 15, durationSec: 15, width: 320, quality: 0.6 });
const player = new ReplayPlayer(document.getElementById('displayCanvas'), recorder);

// --- VAR設定(親機からいつでも調整できる) ---
const REWIND_OPTIONS = [10, 15, 20, 30]; // 秒
const BUFFER_OPTIONS = [10, 15, 20, 30]; // 秒
const QUALITY_OPTIONS = [
  { key: 'low', label: '低', width: 240, quality: 0.5 },
  { key: 'standard', label: '標準', width: 320, quality: 0.6 },
  { key: 'high', label: '高', width: 480, quality: 0.7 },
];
const varSettings = {
  rewindSeconds: 15,
  bufferSeconds: 15,
  qualityKey: 'standard',
};

function startMonitor() {
  document.getElementById('setupArea').style.display = 'none';
  document.getElementById('monitorArea').style.display = 'block';

  recorder.start(); // カメラが増えるたびに登録していく。まだ0台でも動かして問題ない
  cameraLink.onCamsChanged = handleCamsChanged;
  cameraLink.onCamRemoved = (camId) => recorder.unregisterCamera(camId);

  cameraLink.startAsMonitor((video) => {
    player.canvas.width = video.videoWidth || 480;
    player.canvas.height = video.videoHeight || 360;
    player.startLiveLoop(() => cameraLink.getActiveVideoElement());
  });
}

function startCamera() {
  document.getElementById('setupArea').style.display = 'none';
  document.getElementById('cameraArea').style.display = 'block';
  cameraLink.onPauseStateChanged = (isPaused) => {
    const statusEl = document.getElementById('cameraStatus');
    if (statusEl) statusEl.textContent = isPaused ? '一時停止中(親機の操作)' : '送信中';
  };
  cameraLink.startAsCamera();
}

function connectToMonitor() {
  const targetId = document.getElementById('targetIdInput').value.trim();
  if (!targetId) return showToast('IDを入力してください');
  cameraLink.connectToMonitor(targetId);
}

// 接続中カメラの一覧が変わった(増えた/切断された)たびに呼ばれる
function handleCamsChanged(sources) {
  sources.forEach((src) => {
    if (!recorder.listCameraIds().includes(src.id)) {
      recorder.registerCamera(src.id, src.label, () => src.videoEl);
    }
  });
  syncRecorderPauseState(sources);
  renderCamSelector(sources);
}

// 「切断済み」または「全体を一時停止中」のカメラは録画も止める。
// (切断後も静止画を録画し続けると、直近の本当の映像が上書きされてしまうため)
function syncRecorderPauseState(sources) {
  sources.forEach((src) => {
    if (!src.connected || cameraLink.isPaused) {
      recorder.pauseCamera(src.id);
    } else {
      recorder.resumeCamera(src.id);
    }
  });
}

// LIVE中の状態バッジを、一時停止中かどうかに合わせて描き直す(リプレイ中は触らない)
function updateStatusBadge() {
  if (player.isReplay) return;
  const badge = document.getElementById('statusBadge');
  if (cameraLink.isPaused) {
    badge.innerHTML = '⏸ 一時停止中';
    badge.className = 'badge bg-paused';
  } else {
    badge.innerHTML = '<span class="rec-dot"></span>LIVE 撮影中';
    badge.className = 'badge bg-live';
  }
}

function updatePauseButtonIcon(paused) {
  const btn = document.getElementById('btnPauseAll');
  btn.innerHTML = paused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/></svg>';
  btn.setAttribute('aria-label', paused ? '録画を再開' : '録画を一時停止');
}

// カメラ切り替えボタンを、接続中カメラの数(最大4つ)に合わせて描き直す
function renderCamSelector(sources) {
  const container = document.getElementById('camSelector');
  container.innerHTML = '';
  const highlightId = player.isReplay ? player.currentCamId : cameraLink.activeSource;

  sources.forEach((src) => {
    const btn = document.createElement('button');
    const classes = [];
    if (src.id === highlightId) classes.push('btn-active');
    if (!src.connected) classes.push('cam-offline');
    btn.className = classes.join(' ');
    btn.textContent = src.connected ? src.label : `${src.label}(切断)`;
    btn.addEventListener('click', () => selectCamera(src.id));
    container.appendChild(btn);
  });
}

// ライブ中はカメラの切り替え、リプレイ中は「同じ瞬間を別アングルで見る」切り替えになる
function selectCamera(id) {
  if (player.isReplay) {
    player.switchAngle(id);
  } else {
    cameraLink.switchSource(id);
  }
  renderCamSelector(cameraLink.getAllSources());
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

// --- VAR設定(ボトムシート) ---
const settingsSheet = document.getElementById('settingsSheet');
const settingsOverlay = document.getElementById('settingsOverlay');

function openSettings() {
  settingsSheet.classList.add('open');
  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsSheet.classList.remove('open');
  settingsOverlay.classList.remove('open');
}

function updateRewindLabel() {
  document.getElementById('btnRewindLabel').textContent = `${varSettings.rewindSeconds}秒前VAR`;
}

// 「N秒」のような選択肢ボタン群を描き直す共通処理(巻き戻し秒数・バッファ秒数で使い回す)
function renderSecondsSelector(containerId, options, currentValue, onSelect) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  options.forEach((sec) => {
    const btn = document.createElement('button');
    btn.textContent = `${sec}秒`;
    if (sec === currentValue) btn.classList.add('btn-active');
    btn.addEventListener('click', () => onSelect(sec));
    container.appendChild(btn);
  });
}

function renderQualitySelector() {
  const container = document.getElementById('qualitySelector');
  container.innerHTML = '';
  QUALITY_OPTIONS.forEach((opt) => {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    if (opt.key === varSettings.qualityKey) btn.classList.add('btn-active');
    btn.addEventListener('click', () => selectQuality(opt.key));
    container.appendChild(btn);
  });
}

function selectRewindSeconds(sec) {
  varSettings.rewindSeconds = sec;
  updateRewindLabel();
  renderSecondsSelector('rewindSecSelector', REWIND_OPTIONS, varSettings.rewindSeconds, selectRewindSeconds);
}

function selectBufferSeconds(sec) {
  varSettings.bufferSeconds = sec;
  recorder.setDurationSec(sec);
  renderSecondsSelector('bufferSecSelector', BUFFER_OPTIONS, varSettings.bufferSeconds, selectBufferSeconds);
}

function selectQuality(key) {
  varSettings.qualityKey = key;
  const opt = QUALITY_OPTIONS.find((o) => o.key === key);
  recorder.setQuality(opt.width, opt.quality);
  renderQualitySelector();
}

function renderAllSettingsSelectors() {
  renderSecondsSelector('rewindSecSelector', REWIND_OPTIONS, varSettings.rewindSeconds, selectRewindSeconds);
  renderSecondsSelector('bufferSecSelector', BUFFER_OPTIONS, varSettings.bufferSeconds, selectBufferSeconds);
  renderQualitySelector();
}
renderAllSettingsSelectors();
updateRewindLabel();

// --- イベント配線 ---
document.getElementById('btnStartMonitor').addEventListener('click', startMonitor);
document.getElementById('btnStartCamera').addEventListener('click', startCamera);
document.getElementById('btnConnectToMonitor').addEventListener('click', connectToMonitor);

const playerToolbar = document.getElementById('playerToolbar');

document.getElementById('btnRewind').addEventListener('click', () => {
  const ok = player.rewind(varSettings.rewindSeconds, cameraLink.activeSource);
  if (!ok) {
    showToast('録画データがまだありません');
    return;
  }
  playerToolbar.classList.add('show'); // コマ送り/再生ボタンはVAR中だけ表示する
  renderCamSelector(cameraLink.getAllSources());
});
document.getElementById('btnGoLive').addEventListener('click', () => {
  player.goLive();
  playerToolbar.classList.remove('show');
  updateStatusBadge();
  renderCamSelector(cameraLink.getAllSources());
});
document.getElementById('btnPauseAll').addEventListener('click', () => {
  const paused = cameraLink.togglePauseAll();
  syncRecorderPauseState(cameraLink.getAllSources());
  updateStatusBadge();
  updatePauseButtonIcon(paused);
});
document.getElementById('btnStepBack').addEventListener('click', () => player.stepFrame(-1));
document.getElementById('btnPlayPause').addEventListener('click', () => player.togglePlayPause());
document.getElementById('btnStepForward').addEventListener('click', () => player.stepFrame(1));
document.getElementById('btnSpeed').addEventListener('click', () => player.cycleSpeed());
document.getElementById('seekBar').addEventListener('input', (e) => player.onSeekInput(e.target.value));

document.getElementById('btnHelp').addEventListener('click', openHelp);
document.getElementById('btnCloseHelp').addEventListener('click', closeHelp);
helpOverlay.addEventListener('click', closeHelp);

document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelp();
    closeSettings();
  }
});
