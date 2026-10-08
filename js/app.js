// app.js: このアプリの合成ルート(composition root)。
// - CameraLink(カメラ接続) / MultiCamRecorder(常時バックグラウンド録画) / ReplayPlayer(再生)
//   をここで生成して繋ぎ合わせる
// - HTMLにonclickを書かず、ボタンとロジックの対応関係をここに一元化する
//   (「このボタンは何をするか」を知りたければこのファイルだけ見ればよい)
import { CameraLink } from './camera-link.js';
import { MultiCamRecorder } from './multi-cam-recorder.js';
import { ReplayPlayer } from './replay-player.js';
import { showToast } from './toast.js';
import { enableWakeLock } from './wake-lock.js';
import { saveClip } from './clip-saver.js';
import { attachPress } from './press-feedback.js';
import { motionMs } from './motion.js';
import { initInstallPrompt } from './install-prompt.js';
import { setBandState, showSubBand, hideSubBand, subBandText, createStateBand } from './state-band.js';
import { createCodeInput } from './code-input.js';
import { initStartScreen, rememberRole } from './start-screen.js';
import { initPrepPage, openPrep } from './prep-page.js';

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
const SAVE_SCOPE_OPTIONS = [
  { key: 'selected', label: '選択中のみ' },
  { key: 'all', label: '全カメラ' },
];
const varSettings = {
  rewindSeconds: 15,
  bufferSeconds: 15,
  qualityKey: 'standard',
  saveScopeKey: 'selected',
};

function leaveSetupScreen() {
  document.getElementById('setupArea').style.display = 'none';
  document.body.classList.remove('mode-setup');
}

function startMonitor() {
  leaveSetupScreen();
  document.getElementById('monitorArea').style.display = 'block';
  document.body.classList.add('mode-monitor'); // 横向き時のレイアウト切り替え用
  enableWakeLock(); // 撮影中に画面が消えるとカメラも止まってしまうため

  recorder.start(); // カメラが増えるたびに登録していく。まだ0台でも動かして問題ない
  cameraLink.onCamsChanged = handleCamsChanged;
  cameraLink.onCamRemoved = (camId) => recorder.unregisterCamera(camId);

  // 表示サイズは映像の縦横比に合わせてReplayPlayer側で自動調整する
  cameraLink.startAsMonitor(() => {
    player.startLiveLoop(() => cameraLink.getActiveVideoElement());
  });

  setInterval(renderRecStatus, 500);
  renderRecStatus();
  updateStateBand(); // 起動時に「LIVE」の帯を出す
}

// 「今押したら何秒前まで戻れるか」と、各カメラが録画できているかを表示する。
// 起動直後や子機が切れたときに、押す前に分かるようにするため。
function renderRecStatus() {
  const el = document.getElementById('recStatus');
  if (!el) return;
  const sources = cameraLink.getAllSources();
  const rewind = varSettings.rewindSeconds;

  let summary;
  if (cameraLink.isPaused) {
    summary = '一時停止中のため、録画していません';
  } else {
    const recorded = Math.floor(recorder.getFrames(cameraLink.activeSource).length / recorder.fps);
    summary = recorded >= rewind
      ? `${rewind}秒前まで戻れます`
      : `録画中です。あと${rewind - recorded}秒で${rewind}秒前まで戻れます`;
  }

  let camsHtml = '';
  if (sources.length > 1) {
    camsHtml = '<div class="rec-cams">' + sources.map((src) => {
      let state;
      if (!src.connected) state = '<span class="rec-cam-off">切断</span>';
      else if (cameraLink.isPaused) state = '<span class="rec-cam-off">停止中</span>';
      else state = '<span class="rec-cam-on"><span class="rec-dot"></span>録画中</span>';
      return `<span class="rec-cam">${src.label} ${state}</span>`;
    }).join('') + '</div>';
  }
  const html = `<div class="rec-summary">${summary}</div>${camsHtml}`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

// --- カメラで参加する画面(子機)。「参加する前」と「送信中」を丸ごと切り替える ---
const camBand = createStateBand({
  bandId: 'camStateBand',
  subId: 'camSubBand',
  labels: { sending: '送信中', paused: '一時停止中', lost: '接続が切れました' },
});
const cameraStatusEl = document.getElementById('cameraStatus');
let codeInput = null;
let cameraNumber = 0; // 親機から教えてもらった、カメラの番号(カメラ2なら2。親機自身がカメラ1)
let cameraPaused = false;

// 参加できなかった理由。番号は消さず、短く知らせる
const JOIN_FAILURE_MESSAGES = {
  camera: 'カメラを使えませんでした。カメラの利用を許可してください',
  'not-found': 'この番号は見つかりませんでした。番号をご確認ください',
  full: '満員のため参加できませんでした',
  // 番号は通ったのに、映像の経路を作れなかった。ネットワークを変えない限りつながらないので、対処まで伝える
  unreachable: 'この端末からは直接つながりませんでした。はじめた端末と同じWi‑Fiか、はじめた端末のテザリングにつないでください',
  closed: '接続できませんでした。もう一度お試しください',
  timeout: '接続できませんでした。もう一度お試しください',
  network: '通信できませんでした。電波をご確認ください',
};
const LONG_TOAST_MS = 7000; // 対処まで書いた長めの知らせは、読み終えられるよう長く出す

function startCamera() {
  leaveSetupScreen();
  document.body.classList.add('mode-camera'); // 画面の切り替え・横向きのレイアウト用
  enableWakeLock({ quiet: true }); // 送信中の画面に「画面をロックすると送信が止まります」と常に出すので、成功の知らせは出さない
  cameraLink.onPauseStateChanged = (isPaused) => {
    cameraPaused = isPaused;
    if (document.body.classList.contains('camera-sending')) updateCameraBand();
  };
  cameraLink.onConnectionLost = () => {
    camBand.setState('lost');
    camBand.showSub('再接続しています…');
  };
  // 繋ぎ直しを打ち切った(直接つながらない状態が続いた)。自動では試さなくなるので、その旨と対処を出す
  cameraLink.onReconnectGaveUp = () => {
    camBand.showSub('再接続できませんでした');
    showToast(JOIN_FAILURE_MESSAGES.unreachable, { duration: LONG_TOAST_MS });
  };
  cameraLink.onReconnected = (number) => {
    if (number) cameraNumber = number;
    updateCameraBand();
  };
  cameraLink.startAsCamera();

  codeInput = createCodeInput({ root: document.getElementById('codeInput'), onComplete: connectToMonitor });
  codeInput.focus(); // 端末によっては、押した直後でないとキーボードが開かない。開かなければ枠を押せばよい
}

// 映像の枠を、カメラ映像の縦横比に合わせて画面いっぱいに広げる。
// 帯を「映像の外枠の角」に置くため(ポリシー 2-1)、映像が画面より細い・低いときも、枠は映像ぴったりにする
const sendView = document.getElementById('sendView');
const sendFrame = document.getElementById('sendFrame');
const sendVideo = document.getElementById('localVideo');
function fitSendFrame() {
  const vw = sendVideo.videoWidth;
  const vh = sendVideo.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(sendView.clientWidth / vw, sendView.clientHeight / vh);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  Object.assign(sendFrame.style, {
    inset: 'auto', left: '50%', top: '50%', width: `${w}px`, height: `${h}px`, margin: `${-h / 2}px 0 0 ${-w / 2}px`,
  });
}
['loadedmetadata', 'resize'].forEach((type) => sendVideo.addEventListener(type, fitSendFrame)); // 端末を回すと映像の向きも変わる
window.addEventListener('resize', fitSendFrame);

// 送信中の帯: 一時停止中ならそう出し、そうでなければ「送信中」とカメラの番号を出す
function updateCameraBand() {
  camBand.setState(cameraPaused ? 'paused' : 'sending');
  camBand.showSub(`カメラ${cameraNumber}`);
}

// 4桁そろったら自動でつなぐ。失敗したら番号を消さずに理由を出し、入れ直せばまたつなぐ
let joining = false;
async function connectToMonitor(targetId) {
  if (joining) return;
  joining = true;
  codeInput.setBusy(true);
  cameraStatusEl.textContent = '接続中…';
  const result = await cameraLink.connectToMonitor(targetId);
  joining = false;
  cameraStatusEl.textContent = '';
  codeInput.setBusy(false);
  if (!result.ok) {
    if (result.reason !== 'cancelled') {
      const long = result.reason === 'unreachable';
      showToast(JOIN_FAILURE_MESSAGES[result.reason] || JOIN_FAILURE_MESSAGES.timeout, long ? { duration: LONG_TOAST_MS } : undefined);
    }
    return;
  }
  // つながった: 入力の部品を片付けて、カメラの映像を画面いっぱいに出す
  cameraNumber = result.number || 0;
  sendVideo.srcObject = cameraLink.ownStream;
  sendVideo.play().catch(() => {}); // 自動再生がブロックされても、映像自体は流れている
  document.activeElement && document.activeElement.blur();
  document.body.classList.add('camera-sending');
  updateCameraBand();
}

// 接続を切って、参加する前の画面に戻る
function leaveCameraSending() {
  cameraLink.disconnectFromMonitor();
  document.body.classList.remove('camera-sending');
  sendVideo.srcObject = null;
  camBand.reset();
  codeInput.clear();
  cameraStatusEl.textContent = '';
  cameraPaused = false;
  showToast('接続を切りました');
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

// 状態の帯を、今の状態(リプレイ中 / 一時停止中 / LIVE)に合わせる
function updateStateBand() {
  if (player.isReplay) setBandState('replay');
  else if (cameraLink.isPaused) setBandState('paused');
  else setBandState('live');
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
  // カメラが1台だけのときは切り替える先がないので出さない。
  // 子機がつながったら、接続IDの説明文も役目を終えるので隠す(CSSの .has-children)
  const multi = sources.length > 1;
  container.style.display = multi ? '' : 'none';
  document.getElementById('monitorArea').classList.toggle('has-children', multi);
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

function renderSaveScopeSelector() {
  const container = document.getElementById('saveScopeSelector');
  container.innerHTML = '';
  SAVE_SCOPE_OPTIONS.forEach((opt) => {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    if (opt.key === varSettings.saveScopeKey) btn.classList.add('btn-active');
    btn.addEventListener('click', () => selectSaveScope(opt.key));
    container.appendChild(btn);
  });
}

function selectSaveScope(key) {
  varSettings.saveScopeKey = key;
  renderSaveScopeSelector();
}

function renderAllSettingsSelectors() {
  renderSecondsSelector('rewindSecSelector', REWIND_OPTIONS, varSettings.rewindSeconds, selectRewindSeconds);
  renderSecondsSelector('bufferSecSelector', BUFFER_OPTIONS, varSettings.bufferSeconds, selectBufferSeconds);
  renderQualitySelector();
  renderSaveScopeSelector();
}
renderAllSettingsSelectors();
updateRewindLabel();
initInstallPrompt();

// 押した手応え(デザインポリシー 2-4)。主要な操作とコマ送りは、対応端末なら押した瞬間に短く振動させる
[['btnRewind', 30], ['btnGoLive', 30], ['btnSaveClip', 30], ['btnBackToReplay', 30],
 ['btnStepBack', 12], ['btnStepForward', 12], ['btnPlayPause', 12], ['btnSpeed', 0]]
  .forEach(([id, vibrate]) => attachPress(document.getElementById(id), { vibrate }));

// --- イベント配線 ---
initStartScreen({ monitor: startMonitor, camera: startCamera });
// 初めて開いたときに「はじめる前に」を出す。「1台だけで使う」を選んだ人には、スタート画面の「はじめる」に「前回」の印を付けておく
initPrepPage({ onFirstRunSolo: () => rememberRole('monitor') });
document.getElementById('btnDisconnect').addEventListener('click', leaveCameraSending);

const playerToolbar = document.getElementById('playerToolbar');
const saveRow = document.getElementById('saveRow');
const monitorArea = document.getElementById('monitorArea');
const btnBackToReplay = document.getElementById('btnBackToReplay');
const BACK_TO_REPLAY_MS = 6000; // 「リプレイに戻る」を出しておく時間
let backToReplayPoint = null;
let backToReplayTimer = null;

// リプレイ中だけ見せる操作(コマ送り・再生・保存・LIVEに戻る)の表示を切り替える
function setReplayUI(isReplay) {
  playerToolbar.classList.toggle('show', isReplay);
  saveRow.classList.toggle('show', isReplay);
  monitorArea.classList.toggle('replaying', isReplay); // LIVEに戻る・シークバーの表示や横向きの配置もこのクラスで切り替える
  updateStateBand();
  renderCamSelector(cameraLink.getAllSources());
}

function hideBackToReplay() {
  clearTimeout(backToReplayTimer);
  backToReplayPoint = null;
  btnBackToReplay.classList.remove('show');
}

document.getElementById('btnRewind').addEventListener('click', () => {
  // 一瞬止めて(ため)から、キュッと巻き戻してリプレイに入る。値は css/style.css の --var-hold / --var-sweep
  const ok = player.rewind(varSettings.rewindSeconds, cameraLink.activeSource, {
    holdMs: motionMs('--var-hold'),
    sweepMs: motionMs('--var-sweep'),
  });
  if (!ok) {
    showToast('録画データがまだありません');
    return;
  }
  hideBackToReplay();
  setReplayUI(true);
});
document.getElementById('btnGoLive').addEventListener('click', () => {
  // 押し間違いに備えて、見ていた場面を少しの間だけ控えておく
  const point = player.getResumePoint();
  player.goLive();
  setReplayUI(false);
  if (point) {
    hideBackToReplay();
    backToReplayPoint = point;
    btnBackToReplay.classList.add('show');
    backToReplayTimer = setTimeout(hideBackToReplay, BACK_TO_REPLAY_MS);
  }
});
btnBackToReplay.addEventListener('click', () => {
  const point = backToReplayPoint;
  hideBackToReplay();
  if (!player.resumeAt(point)) {
    showToast('リプレイの映像が残っていません');
    return;
  }
  setReplayUI(true);
});

// リプレイ中は映像そのものをタップしても再生・一時停止できる(画面で一番大きい「ボタン」)
document.getElementById('displayCanvas').addEventListener('click', () => {
  if (player.isReplay) player.togglePlayPause();
});

// VAR設定の「保存するカメラ」に応じて、保存するクリップの対象を組み立てる
function buildSaveTargets() {
  const sources = cameraLink.getAllSources();
  if (varSettings.saveScopeKey === 'all') {
    return sources
      .filter((src) => recorder.getFrames(src.id).length > 0)
      .map((src) => ({ id: src.id, label: src.label, frames: recorder.getFrames(src.id) }));
  }
  const src = sources.find((s) => s.id === player.currentCamId);
  const label = src ? src.label : 'カメラ';
  return [{ id: player.currentCamId, label, frames: recorder.getFrames(player.currentCamId) }];
}

const SAVED_NOTICE_MS = 1800; // 「保存しました」を出しておく時間
// 保存中はサブ帯で「保存中」を出す。手が震えて二度押ししても、二重に書き出さない
let savingClip = false;
document.getElementById('btnSaveClip').addEventListener('click', async () => {
  if (savingClip) return;
  savingClip = true;
  showSubBand('保存中');
  try {
    await saveClip(buildSaveTargets(), recorder.fps, {
      // 書き出しが終わった時点で「保存しました」を短く出す(共有画面が開く前に知らせる)
      onEncoded: (count) => {
        showSubBand(count > 1 ? `${count}件を保存しました` : '保存しました', { autoHideMs: SAVED_NOTICE_MS });
      },
    });
  } finally {
    if (subBandText() === '保存中') hideSubBand(); // 失敗・データなしのときは「保存中」だけ消す
    savingClip = false;
  }
});
document.getElementById('btnPauseAll').addEventListener('click', () => {
  const paused = cameraLink.togglePauseAll();
  syncRecorderPauseState(cameraLink.getAllSources());
  updateStateBand();
  updatePauseButtonIcon(paused);
});
document.getElementById('btnStepBack').addEventListener('click', () => player.stepFrame(-1));
document.getElementById('btnPlayPause').addEventListener('click', () => player.togglePlayPause());
document.getElementById('btnStepForward').addEventListener('click', () => player.stepFrame(1));
document.getElementById('btnSpeed').addEventListener('click', () => player.cycleSpeed());
document.getElementById('seekBar').addEventListener('input', (e) => player.onSeekInput(e.target.value));

document.getElementById('btnHelp').addEventListener('click', openHelp);
// ヘルプの一番上の「はじめる前に」から、準備ページをいつでも開ける
document.getElementById('btnOpenPrep').addEventListener('click', () => {
  closeHelp();
  openPrep();
});
document.getElementById('btnHelpInline').addEventListener('click', openHelp); // 横向き時の親機用
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
