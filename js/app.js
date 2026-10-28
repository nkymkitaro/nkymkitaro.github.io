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
import { maybeShowHomeNudge } from './home-nudge.js';
import { prefetchRelayConfig } from './relay.js';
import { createReplayUi } from './replay-ui.js';
import { setBandState, showSubBand, hideSubBand, subBandText, createStateBand } from './state-band.js';
import { createCodeInput } from './code-input.js';
import { initJoinQr, closeJoinQr, parseJoinParam, parseJoinMethod, removeJoinParam } from './join-qr.js';
import { initStartScreen, rememberRole } from './start-screen.js';
import { initPrepPage, openPrep, isPrepSeen } from './prep-page.js';
import { initAnalytics, track, getDisplayMode } from './analytics.js';
import { createZoomControl } from './zoom-control.js';
import { initRoleSurvey, maybeAskRole, dismissRoleSurvey, openRoleSurveyFromHelp, getSavedRole } from './role-survey.js';

// LINEなどのアプリ内ブラウザの判定(js/in-app-browser.js が <head> で先に済ませている)。
// leaving: LINEから標準ブラウザへ開き直している最中。blocked: 「ブラウザで開いてください」を出して先へ進ませない
const inApp = window.kendoInApp || { leaving: false, blocked: false };

// 利用状況の計測(analytics.js)。本番のドメイン以外では何も送らない。失敗してもアプリは普通に動く。
// 標準ブラウザへ開き直す前は送らない(開き直した先で1回だけ数える)
// 「最初の画面に戻る」で読み込み直したときは、同じ人の使い続けなので数えない(印は1回で消す)
function takeReturnedFlag() {
  try {
    const returned = sessionStorage.getItem(RETURNED_KEY) === '1';
    sessionStorage.removeItem(RETURNED_KEY);
    return returned;
  } catch (err) { return false; }
}
const RETURNED_KEY = 'kendo-var-returned-to-start';
if (!inApp.leaving) {
  const returned = takeReturnedFlag();
  initAnalytics({ userRole: getSavedRole() });
  if (!returned) track('app_open', { display_mode: getDisplayMode() });
}

const cameraLink = new CameraLink();
let hostZoom = null; // 親機のズームの操作(js/zoom-control.js)
let sendZoom = null; // 子機のズームの操作
// さかのぼれる長さの既定は30秒(15秒は試合でも地稽古でも短いため、2026-10-17 に15秒から上げた)。
// 数分の録画は、この写真方式ではなく動画で残す別の方式で扱う
const DEFAULT_BUFFER_SEC = 30;
// 録画の幅の既定は640px(カメラの取り込みと同じ大きさ。拡大して見たときに粗くならないよう、2026-10-14 に320pxから上げた)
const recorder = new MultiCamRecorder({ fps: 15, durationSec: DEFAULT_BUFFER_SEC, width: 640, quality: 0.6 });
const player = new ReplayPlayer(document.getElementById('displayCanvas'), recorder);

// --- VAR設定(親機からいつでも調整できる) ---
const REWIND_OPTIONS = [10, 15, 20, 30]; // 秒
const BUFFER_OPTIONS = [15, 30, 60]; // 秒
const BUFFER_HEAVY_SEC = 60; // この長さを選んだときは「重くなることがあります。」を出す
// 録画の画質。カメラは640×480で取り込むので、640pxより上げても細かくならない(「高」は外した、2026-10-14)。
// 「低」は、重い・熱くなる端末向けの逃げ道(以前の標準の320px)
const QUALITY_OPTIONS = [
  { key: 'low', label: '低', width: 320, quality: 0.6 },
  { key: 'standard', label: '標準', width: 640, quality: 0.6 },
];
const SAVE_SCOPE_OPTIONS = [
  { key: 'selected', label: '選択中のみ' },
  { key: 'all', label: '全カメラ' },
];
const varSettings = {
  rewindSeconds: 15,
  bufferSeconds: DEFAULT_BUFFER_SEC,
  qualityKey: 'standard',
  saveScopeKey: 'selected',
};

function leaveSetupScreen() {
  document.getElementById('setupArea').style.display = 'none';
  document.body.classList.remove('mode-setup');
}

let liveStartSent = false;
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
    if (!liveStartSent) { liveStartSent = true; track('live_start'); } // 撮影の画面に着いた(許可が通り、映像が出た)。1回だけ
    player.startLiveLoop(() => cameraLink.getActiveVideoElement());
    // 親機自身のカメラ(カメラ1)のズーム。対応していない端末では出さない
    if (!hostZoom) hostZoom = createZoomControl({
      parent: document.getElementById('monitorArea'),
      className: 'zoom-host',
      getTrack: () => { const st = cameraLink.localMonitorVideo.srcObject; return st ? st.getVideoTracks()[0] : null; },
    });
    hostZoom.refresh();
    hostZoom.setActive(cameraLink.activeSource === 'local');
  });
  // 参加用のQR(番号は startAsMonitor の最初で決まる)。作れなくても、番号で参加できる。
  // 初めて「カメラを追加」を押したときだけ、先に「はじめる前に」(同じWi-Fi・テザリング)を出す
  initJoinQr(cameraLink.myId, { beforeOpen: (proceed) => { if (isPrepSeen()) return false; openPrep({ onOk: proceed }); return true; } });

  setInterval(renderRecStatus, 500);
  renderRecStatus();
  updateStateBand(); // 起動時に「LIVE」の帯を出す
}

// --- VARボタンの輪(css/style.css「VARボタンの輪」)。見ているカメラのたまった秒数 ÷ さかのぼれる長さ ---
const varRingBtn = document.getElementById('btnRewind');
const varRingSvg = varRingBtn.querySelector('.var-ring');
const varRingRects = varRingSvg ? Array.from(varRingSvg.querySelectorAll('rect')) : [];
let varRingLen = 0;
function layoutVarRing() {
  const w = varRingBtn.clientWidth;
  const h = varRingBtn.clientHeight;
  if (!w || !h) return;
  varRingRects.forEach((r) => {
    r.setAttribute('x', 1.5); r.setAttribute('y', 1.5);
    r.setAttribute('width', w - 3); r.setAttribute('height', h - 3);
    r.setAttribute('rx', 10);
  });
  varRingLen = varRingRects[0].getTotalLength();
  varRingRects[1].style.strokeDasharray = `${varRingLen}`;
  updateVarRing();
}
function updateVarRing() {
  if (!varRingLen) return;
  const frames = recorder.getFrames(cameraLink.activeSource).length;
  const p = Math.max(0, Math.min(1, (frames / recorder.fps) / varSettings.bufferSeconds));
  varRingRects[1].style.strokeDashoffset = `${varRingLen * (1 - p)}`;
  varRingBtn.classList.toggle('ring-paused', cameraLink.isPaused);
}
if (varRingSvg && 'ResizeObserver' in window) new ResizeObserver(layoutVarRing).observe(varRingBtn);
setInterval(updateVarRing, 250); // 1秒に4回。録画や映像の負荷は増えない(数を数えるだけ)

// 「今押したら何秒前まで戻れるか」と、各カメラが録画できているかを表示する。
// 起動直後や子機が切れたときに、押す前に分かるようにするため。
function renderRecStatus() {
  const el = document.getElementById('recStatus');
  if (!el) return;
  const sources = cameraLink.getAllSources();
  const rewind = varSettings.rewindSeconds;

  let summary;
  if (cameraLink.isPaused) {
    summary = '一時停止中のため、撮影していません';
  } else {
    const recorded = Math.floor(recorder.getFrames(cameraLink.activeSource).length / recorder.fps);
    summary = recorded >= rewind
      ? `${rewind}秒前まで戻れます`
      : `撮影中です。あと${rewind - recorded}秒で${rewind}秒前まで戻れます`;
  }

  let camsHtml = '';
  if (sources.length > 1) {
    camsHtml = '<div class="rec-cams">' + sources.map((src) => {
      let state;
      if (!src.connected) state = '<span class="rec-cam-off">つながっていません</span>';
      else if (cameraLink.isPaused) state = '<span class="rec-cam-off">停止中</span>';
      else state = '<span class="rec-cam-on"><span class="rec-dot"></span>撮影中</span>';
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
  labels: { sending: '撮影中', paused: '一時停止中', lost: 'つながっていません' },
});
const cameraStatusEl = document.getElementById('cameraStatus');
let codeInput = null;
let cameraNumber = 0; // 親機から教えてもらった、カメラの番号(カメラ2なら2。親機自身がカメラ1)
let cameraPaused = false;

// 参加できなかった理由。番号は消さず、短く知らせる
const JOIN_FAILURE_MESSAGES = {
  camera: 'カメラを使えませんでした。カメラの利用を許可してください。',
  'not-found': 'この番号は見つかりませんでした。番号をご確認ください。',
  full: '満員のため参加できませんでした。',
  // 番号は通ったのに、映像の経路を作れなかった。ネットワークを変えない限りつながらないので、対処まで伝える
  unreachable: '直接つながりませんでした。同じWi‑Fiか、はじめたスマホのテザリングにつないでください。',
  closed: 'つながりませんでした。もう一度お試しください。',
  timeout: 'つながりませんでした。もう一度お試しください。',
  network: '通信できませんでした。電波をご確認ください。',
};
const LONG_TOAST_MS = 7000; // 対処まで書いた長めの知らせは、読み終えられるよう長く出す

// focus: false は、QRから開いて自動でつなぐとき(番号は入っているので、キーボードは開かない)
function startCamera({ focus = true } = {}) {
  leaveSetupScreen();
  document.body.classList.add('mode-camera'); // 画面の切り替え・横向きのレイアウト用
  enableWakeLock({ quiet: true }); // 送信中の画面に「画面を消すと、映像が届かなくなります。」と常に出すので、成功の知らせは出さない
  cameraLink.onPauseStateChanged = (isPaused) => {
    cameraPaused = isPaused;
    if (document.body.classList.contains('camera-sending')) updateCameraBand();
  };
  cameraLink.onConnectionLost = () => {
    camBand.setState('lost');
    camBand.showSub('つなぎ直しています…');
  };
  // 繋ぎ直しを打ち切った(直接つながらない状態が続いた)。自動では試さなくなるので、その旨と対処を出す
  cameraLink.onReconnectGaveUp = () => {
    camBand.showSub('つなぎ直せませんでした');
    showToast(JOIN_FAILURE_MESSAGES.unreachable, { duration: LONG_TOAST_MS });
  };
  cameraLink.onReconnected = (number) => {
    track('camera_reconnect');
    if (number) cameraNumber = number;
    updateCameraBand();
  };
  cameraLink.startAsCamera();
  showCellNote();

  codeInput = createCodeInput({ root: document.getElementById('codeInput'), onComplete: connectToMonitor });
  if (focus) codeInput.focus(); // 端末によっては、押した直後でないとキーボードが開かない。開かなければ枠を押せばよい
}

// 携帯回線のままなら、「Wi‑Fiにつないでください」を1回出す(押すと消える。止めはしない)。
// Android の Chrome だけ値が取れる(iPhone の Safari は取れないので何も出さない)。Wi‑Fiにつながったら自動で消える
function showCellNote() {
  const note = document.getElementById('cellNote');
  const conn = navigator.connection;
  if (!note || !conn || conn.type !== 'cellular') return;
  note.hidden = false;
  note.addEventListener('click', () => { note.hidden = true; }, { once: true });
  conn.addEventListener('change', () => { if (conn.type !== 'cellular') note.hidden = true; });
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
// method: 参加のしかた('code' = 4桁を入れて / 'qr' = QRを読んで開いた / 'link' = 送られたリンクを開いた)。解析用で、つなぎ方は同じ
let joining = false;
async function connectToMonitor(targetId, method = 'code') {
  if (joining) return;
  joining = true;
  codeInput.setBusy(true);
  cameraStatusEl.textContent = 'つないでいます…';
  const result = await cameraLink.connectToMonitor(targetId);
  joining = false;
  cameraStatusEl.textContent = '';
  codeInput.setBusy(false);
  if (method !== 'code') removeJoinParam(); // 結果が出たら、URLから ?join= を消す(再読み込みで古い番号につなぎに行かないように)
  if (result.ok) {
    track('camera_join_result', { result: 'success', method });
  } else if (result.reason !== 'cancelled') {
    track('camera_join_result', { result: 'fail', reason: result.reason, method });
  }
  if (!result.ok) {
    if (result.reason !== 'cancelled') {
      const long = result.reason === 'unreachable';
      // つながらなかったときは、つなぎ方の絵(準備ページと同じもの)を開くボタンを添える
      showToast(JOIN_FAILURE_MESSAGES[result.reason] || JOIN_FAILURE_MESSAGES.timeout, long ? { duration: LONG_TOAST_MS, action: { label: 'つなぎ方を見る', onClick: () => openPrep({ quiet: true }) } } : undefined);
      if (method !== 'code') codeInput.focus(); // 番号の枠で入れ直せるように
    }
    return;
  }
  // つながった: 入力の部品を片付けて、カメラの映像を画面いっぱいに出す
  cameraNumber = result.number || 0;
  sendVideo.srcObject = cameraLink.ownStream;
  if (!sendZoom) {
    sendZoom = createZoomControl({
      parent: document.getElementById('sendView'),
      className: 'zoom-send',
      getTrack: () => (cameraLink.ownStream ? cameraLink.ownStream.getVideoTracks()[0] : null),
    });
  }
  sendZoom.refresh(); // つなぎ直すたびに1倍に戻る
  sendVideo.play().catch(() => {}); // 自動再生がブロックされても、映像自体は流れている
  document.activeElement && document.activeElement.blur();
  document.body.classList.add('camera-sending');
  updateCameraBand();
}

// 参加をやめて、参加する前の画面に戻る
function leaveCameraSending() {
  cameraLink.disconnectFromMonitor();
  document.body.classList.remove('camera-sending');
  sendVideo.srcObject = null;
  if (sendZoom) sendZoom.el.hidden = true;
  camBand.reset();
  codeInput.clear();
  cameraStatusEl.textContent = '';
  cameraPaused = false;
  showToast('参加をやめました');
  maybeAskRole(); // 撮影の邪魔にならない、参加する前の画面に戻ったこのタイミングで、立場を聞く(条件は role-survey.js)
}

// 接続中カメラの一覧が変わった(増えた/切断された)たびに呼ばれる
const knownCamIds = new Set(); // 今までにつながったカメラ。同じカメラの再接続では、大きい表示を閉じない
function handleCamsChanged(sources) {
  // 新しいカメラがつながったら、「カメラを追加」の大きい表示はもう要らないので閉じる
  const connectedIds = sources.filter((src) => src.connected).map((src) => src.id);
  const hasNewCamera = connectedIds.some((id) => !knownCamIds.has(id));
  connectedIds.forEach((id) => knownCamIds.add(id));
  if (hasNewCamera && knownCamIds.size > 1) closeJoinQr();
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
  btn.setAttribute('aria-label', paused ? '撮影を再開' : '撮影を一時停止');
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
  if (hostZoom) hostZoom.setActive(cameraLink.activeSource === 'local'); // 親機のカメラを見ているときだけ
  // リプレイ中は全画面で操作が消えることがあるので、いま見ているカメラは帯の下に常に出しておく
  // (並べて見ているときは、それぞれの映像にカメラ名が出るので出さない)
  const current = sources.find((src) => src.id === highlightId);
  const showingGrid = player.isReplay && player.view === 'grid';
  document.getElementById('camBadge').textContent = current && !showingGrid ? current.label : '';

  sources.forEach((src) => {
    const btn = document.createElement('button');
    const classes = [];
    if (src.id === highlightId) classes.push('btn-active');
    if (!src.connected) classes.push('cam-offline');
    btn.className = classes.join(' ');
    btn.textContent = src.connected ? src.label : `${src.label}(つながっていません)`;
    btn.addEventListener('click', () => selectCamera(src.id));
    container.appendChild(btn);
  });

  // リプレイ中で、2台以上の映像があれば「並べる」(並べて見る形に戻る)を出す
  if (player.isReplay && player.view !== 'grid' && player.canGrid()) {
    const gridBtn = document.createElement('button');
    gridBtn.id = 'btnGridView';
    gridBtn.className = 'grid-view-btn';
    gridBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1.2"/><rect x="13" y="4" width="8" height="7" rx="1.2"/><rect x="3" y="13" width="8" height="7" rx="1.2"/><rect x="13" y="13" width="8" height="7" rx="1.2"/></svg>並べる';
    gridBtn.addEventListener('click', () => applyReplayView('grid'));
    container.appendChild(gridBtn);
  }
}

// ライブ中はカメラの切り替え、リプレイ中は「同じ瞬間を別アングルで見る」切り替えになる
function selectCamera(id) {
  if (player.isReplay) {
    if (player.view === 'grid') {
      applyReplayView('single', id);
      return;
    }
    player.switchAngle(id);
    replayUi.resetZoom(true); // 別のカメラでは見たい場所が違うので、拡大は元に戻す
    replayUi.showControls();
  } else {
    cameraLink.switchSource(id);
  }
  renderCamSelector(cameraLink.getAllSources());
}

// --- 使い方ヘルプ(ボトムシート) ---
const helpSheet = document.getElementById('helpSheet');
const helpOverlay = document.getElementById('helpOverlay');

function openHelp() {
  if (!helpSheet.classList.contains('open')) track('help_open'); // 開いたという事実だけ。1回の操作で1回
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
  updateBufferNote();
}

// 長い設定(60秒)を選んでいるときだけ、選んだ場所の下に小さく注意を出す
function updateBufferNote() {
  const note = document.getElementById('bufferHeavyNote');
  if (note) note.hidden = varSettings.bufferSeconds < BUFFER_HEAVY_SEC;
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
  updateSaveTarget();
}

function renderAllSettingsSelectors() {
  renderSecondsSelector('rewindSecSelector', REWIND_OPTIONS, varSettings.rewindSeconds, selectRewindSeconds);
  renderSecondsSelector('bufferSecSelector', BUFFER_OPTIONS, varSettings.bufferSeconds, selectBufferSeconds);
  renderQualitySelector();
  renderSaveScopeSelector();
  updateBufferNote();
}
renderAllSettingsSelectors();
updateRewindLabel();
initInstallPrompt();
prefetchRelayConfig(); // 中継の試作(?relay=1 のときだけ合言葉を取りに行く。js/relay.js)

// 押した手応え(デザインポリシー 2-4)。主要な操作とコマ送りは、対応端末なら押した瞬間に短く振動させる
[['btnRewind', 30], ['btnGoLive', 30], ['btnSaveClip', 30], ['btnBackToReplay', 30],
 ['btnStepBack', 12], ['btnStepForward', 12], ['btnPlayPause', 12], ['btnSpeed', 0]]
  .forEach(([id, vibrate]) => attachPress(document.getElementById(id), { vibrate }));

// --- イベント配線 ---
initStartScreen({
  monitor: () => { track('role_select', { role: 'start' }); startMonitor(); },
  camera: () => { track('role_select', { role: 'camera' }); startCamera(); },
});
// 初めて開いたときに「はじめる前に」を出す。「1台だけで使う」を選んだ人には、スタート画面の「はじめる」に「前回」の印を付けておく
initPrepPage({ onFirstRunSolo: () => rememberRole('monitor'), onChoice: (choice) => track('prep_choice', { choice }) });
initRoleSurvey();
// QRを読んで開いた(?join=1234)ときは、準備ページとスタート画面を飛ばして、カメラとして自動で参加する。
// 「前回」の印は変えない(rememberRole を呼ばない)
// アプリ内ブラウザで先へ進ませないときは、準備ページも出さず、自動の参加もしない(カメラが使えないため)
if (inApp.blocked || inApp.leaving) document.documentElement.classList.remove('needs-prep');
const qrJoinCode = parseJoinParam(window.location.search);
if (qrJoinCode && !inApp.blocked && !inApp.leaving) {
  document.documentElement.classList.remove('needs-prep');
  startCamera({ focus: false });
  codeInput.fill(qrJoinCode);
  connectToMonitor(qrJoinCode, parseJoinMethod(window.location.search));
}
// リンクですぐ撮影(?start=1): 準備ページとスタート画面を飛ばして、「はじめる」を押したあとの画面へ進む。
// 「前回」の印は変えない。「最初の画面に戻る」矢印はそのまま使える(戻ると、?start=1 のないスタート画面)。
// アプリ内ブラウザで先へ進ませないとき・?join= のときは、何もしない
if (/[?&]start=1(&|$)/.test(window.location.search) && !qrJoinCode && !inApp.blocked && !inApp.leaving) {
  track('role_select', { role: 'start' });
  startMonitor();
}
document.getElementById('btnDisconnect').addEventListener('click', leaveCameraSending);

// --- 最初の画面に戻る(はじめた端末・カメラで参加の「参加する前」) ---
// 画面の状態(カメラ・通信・録画・画面を消さない設定)をひとつずつ片付けると取りこぼしやすいので、
// 開き直して最初の画面から始める。表示するのは「他のカメラがつながっていない・録画していない」ときだけ(css/style.css の .back-start)
function backToStartScreen() {
  try { sessionStorage.setItem(RETURNED_KEY, '1'); } catch (err) { /* 数え直すだけ */ }
  window.location.replace(window.location.pathname);
}
['btnBackStart', 'btnJoinBack'].forEach((id) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  attachPress(btn, { vibrate: 12 });
  btn.addEventListener('click', backToStartScreen);
});

// --- 最初のVARの前の一言(「押すと直前を見返せます」)。最初のVARを押したら、その端末では出さない ---
const VAR_USED_KEY = 'kendo-var-var-used';
const varHint = document.getElementById('varHint');
function hasUsedVar() {
  try { return localStorage.getItem(VAR_USED_KEY) === '1'; } catch (err) { return false; } // 読めない端末では毎回出す
}
function markVarUsed() {
  if (varHint) varHint.hidden = true;
  try { localStorage.setItem(VAR_USED_KEY, '1'); } catch (err) { /* 保存できなくても使える */ }
}
if (varHint && !hasUsedVar()) varHint.hidden = false;

const playerToolbar = document.getElementById('playerToolbar');
const saveRow = document.getElementById('saveRow');
const monitorArea = document.getElementById('monitorArea');
const btnBackToReplay = document.getElementById('btnBackToReplay');
// リプレイの全画面表示での、操作の出し入れ・タップ・2回タップ・2本指の拡大・なぞり(js/replay-ui.js)。
// 拡大となぞりは、使われたかどうかをVAR1回につき1度だけ数える
const replayUi = createReplayUi({
  area: monitorArea,
  stage: document.querySelector('.stage-video'),
  canvas: document.getElementById('displayCanvas'),
  zoomBadge: document.getElementById('zoomBadge'),
  player,
  onZoom: () => track('var_zoom'),
  onScrub: () => track('var_scrub'),
  // 並べて見ているとき、触ったカメラを1つずつ見る形にする
  onGridTap: (point) => {
    const camId = player.tileAt(point.x, point.y);
    if (camId) applyReplayView('single', camId);
  },
});
const BACK_TO_REPLAY_MS = 6000; // 「VARに戻る」を出しておく時間
let backToReplayPoint = null;
let backToReplayTimer = null;

// リプレイ中だけ見せる操作(コマ送り・再生・保存・LIVEに戻る)の表示を切り替える
function setReplayUI(isReplay, { newVar = false } = {}) {
  playerToolbar.classList.toggle('show', isReplay);
  saveRow.classList.toggle('show', isReplay);
  monitorArea.classList.toggle('replaying', isReplay); // リプレイ中は映像を全画面にして操作を重ねる(css の「VARリプレイの全画面」)
  if (isReplay) replayUi.enter({ newSession: newVar }); // 操作を出した状態で始める。拡大は元の大きさ
  else replayUi.leave();
  updateStateBand();
  syncReplayViewUi(); // 並べて見る形の印と「並べる」ボタン(カメラの切り替えボタンも描き直す)
}

// --- リプレイの見え方(並べて見る / 1つずつ見る)。2026-10-16 技術マネージャーの依頼 ---
// 2台以上の映像があれば、並べて見る形から始める。最後に使った見え方は、この端末の中だけに覚えておく
const REPLAY_VIEW_KEY = 'kendoVar.replayView';
function savedReplayView() {
  try { return localStorage.getItem(REPLAY_VIEW_KEY); } catch (err) { return null; }
}
function rememberReplayView(view) {
  try { localStorage.setItem(REPLAY_VIEW_KEY, view); } catch (err) { /* 覚えられなくても動く */ }
}
// VARに入る・リプレイに戻るときの見え方。描き直しは呼んだ側(rewind・resumeAt)が行う
function chooseReplayView() {
  const view = player.canGrid() && savedReplayView() !== 'single' ? 'grid' : 'single';
  return player.setView(view, { render: false });
}
// 見え方の印(CSSの .grid-view)と、指の操作の扱いを今の見え方に合わせる
function syncReplayViewUi() {
  const grid = player.isReplay && player.view === 'grid';
  monitorArea.classList.toggle('grid-view', grid);
  replayUi.setGrid(grid);
  renderCamSelector(cameraLink.getAllSources());
  updateSaveTarget();
}
// 並べて見ているときだけ、保存ボタンの中に「どのカメラを保存するか」を小さく出す
// (並べた形では「選択中」が画面から分かりにくいため。1つずつ見る形では、見ているカメラなので出さない)
function updateSaveTarget() {
  const el = document.getElementById('saveTarget');
  if (!el) return;
  const grid = player.isReplay && player.view === 'grid';
  if (!grid) { el.hidden = true; return; }
  el.textContent = varSettings.saveScopeKey === 'all'
    ? '全カメラ'
    : (recorder.getLabel(player.currentCamId) || 'カメラ');
  el.hidden = false;
}
// 切り替えたことが分かるよう、映像を短く浮かび上がらせる(--dur-base。動きを減らす設定では出ない)
function flashViewChange() {
  const canvas = document.getElementById('displayCanvas');
  canvas.classList.remove('view-in');
  void canvas.offsetWidth;
  canvas.classList.add('view-in');
}
// 見え方を切り替える(見ている時刻はそのまま)。camId: 1つずつ見る形にするとき、見るカメラ
function applyReplayView(view, camId) {
  if (!player.isReplay) return;
  if (view === 'single') {
    player.setView('single', { render: false });
    if (camId && camId !== player.currentCamId) player.switchAngle(camId);
    else player._renderCurrentFrame();
  } else {
    player.setView('grid');
  }
  rememberReplayView(player.view);
  syncReplayViewUi();
  flashViewChange();
  replayUi.showControls();
}
// 並べて見ていてカメラが減り、自動で1つずつ見る形に戻ったとき
player.onViewChanged = () => syncReplayViewUi();
// 端末を回したら、並べ方(左右・上下・2×2)を新しい画面の形で選び直す
window.addEventListener('resize', () => {
  if (player.isReplay && player.view === 'grid') player._renderCurrentFrame();
});

// ブラウザの全画面表示(対応する端末だけ)。VARに入ったときに入り、LIVEに戻ったら解除する。
// iPhoneのブラウザは対応していないので何もしない。ホーム画面から開いていれば、すでにアドレスバーはない
function enterBrowserFullscreen() {
  try {
    const el = document.documentElement;
    if (getDisplayMode() === 'home_screen' || !document.fullscreenEnabled || !el.requestFullscreen || document.fullscreenElement) return;
    const result = el.requestFullscreen({ navigationUI: 'hide' });
    if (result && result.catch) result.catch(() => { /* 断られても、そのまま使える */ });
  } catch (err) { /* 全画面にできなくても、そのまま使える */ }
}

function exitBrowserFullscreen() {
  try {
    if (!document.fullscreenElement || !document.exitFullscreen) return;
    const result = document.exitFullscreen();
    if (result && result.catch) result.catch(() => {});
  } catch (err) { /* 解除できなくても、そのまま使える */ }
}

function hideBackToReplay() {
  clearTimeout(backToReplayTimer);
  backToReplayPoint = null;
  btnBackToReplay.classList.remove('show');
}

document.getElementById('btnRewind').addEventListener('click', () => {
  // 一瞬止めて(ため)から、キュッと巻き戻してリプレイに入る。値は css/style.css の --var-hold / --var-sweep
  recorder.hold(); // 見返している間は、録画の古いコマを捨てない(場面がずれないように)
  chooseReplayView(); // 2台以上なら並べて見る形から(最後に1つずつ見る形を使っていたら、そちら)
  const ok = player.rewind(varSettings.rewindSeconds, cameraLink.activeSource, {
    holdMs: motionMs('--var-hold'),
    sweepMs: motionMs('--var-sweep'),
  });
  if (!ok) {
    recorder.release();
    showToast('見返せる映像がまだありません。');
    return;
  }
  dismissRoleSurvey(); // 立場の問いが開いたまま次のVARに入ったら、閉じる
  markVarUsed();
  track('var_open', { cameras: cameraLink.getAllSources().filter((src) => src.connected).length });
  hideBackToReplay();
  enterBrowserFullscreen(); // 押した操作の中で呼ぶ(ブラウザの決まり)
  setReplayUI(true, { newVar: true });
});
document.getElementById('btnGoLive').addEventListener('click', () => {
  // 押し間違いに備えて、見ていた場面を少しの間だけ控えておく
  const point = player.getResumePoint();
  player.goLive();
  recorder.release(); // 録画を既定の長さに切り詰める
  setReplayUI(false);
  exitBrowserFullscreen();
  if (point) {
    hideBackToReplay();
    backToReplayPoint = point;
    btnBackToReplay.classList.add('show');
    backToReplayTimer = setTimeout(hideBackToReplay, BACK_TO_REPLAY_MS);
  }
  maybeAskRole(); // 見返し終わった直後に、立場を聞く(条件は role-survey.js)
  maybeShowHomeNudge(); // 初めて見終えたとき1回だけ、ホーム画面への追加を勧める(条件は home-nudge.js)
});
btnBackToReplay.addEventListener('click', () => {
  dismissRoleSurvey(); // 戻る操作の直後に、立場の問いが出てしまわないようにする
  const point = backToReplayPoint;
  hideBackToReplay();
  recorder.hold();
  chooseReplayView();
  if (!player.resumeAt(point)) {
    recorder.release();
    showToast('VARの映像が残っていません。');
    return;
  }
  enterBrowserFullscreen();
  setReplayUI(true);
});

// 保存する範囲: 今見ている場面の前後(中山さん決定、2026-10-14)。録画の端にかかるときは、ある分だけ
const SAVE_BEFORE_MS = 5000;
const SAVE_AFTER_MS = 5000;

// 撮影時刻で、見ている場面の前後だけを切り出す(カメラどうしは同じ時計で記録しているので、全カメラでも同じ時間帯になる)
function framesAround(frames, centerTs) {
  if (centerTs == null) return frames;
  return frames.filter((f) => f.ts >= centerTs - SAVE_BEFORE_MS && f.ts <= centerTs + SAVE_AFTER_MS);
}

// VAR設定の「保存するカメラ」に応じて、保存するクリップの対象を組み立てる
function buildSaveTargets() {
  const sources = cameraLink.getAllSources();
  const point = player.getResumePoint(); // 今見ている場面(カメラと撮影時刻)
  const centerTs = point ? point.ts : null;
  if (varSettings.saveScopeKey === 'all') {
    return sources
      .map((src) => ({ id: src.id, label: src.label, frames: framesAround(recorder.getFrames(src.id), centerTs) }))
      .filter((t) => t.frames.length > 0);
  }
  const src = sources.find((s) => s.id === player.currentCamId);
  const label = src ? src.label : 'カメラ';
  return [{ id: player.currentCamId, label, frames: framesAround(recorder.getFrames(player.currentCamId), centerTs) }];
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
        track('clip_save', { count, all_cameras: varSettings.saveScopeKey === 'all' });
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
// ヘルプの「立場を答える・変える」。ヘルプを閉じて、立場のシートを出す
document.getElementById('btnOpenRole').addEventListener('click', () => {
  closeHelp();
  openRoleSurveyFromHelp();
});
document.getElementById('btnLineContact').addEventListener('click', () => track('line_open'));
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
    closeJoinQr();
  }
});

// 録画の部品(lab/js/main.js)に、接続とカメラの映像を貸し出す。
// 録画は通常のページ(index.html)と試作ページ(lab/multi-rec.html、<html data-lab>)の両方で動く
{
  window.kendoVarApp = {
    cameraLink,
    recorder,
    player,
    getRole: () => (document.body.classList.contains('camera-sending') ? 'camera' : document.body.classList.contains('mode-monitor') ? 'monitor' : ''),
    getCameraNumber: () => cameraNumber,
  };
  document.dispatchEvent(new CustomEvent('kendovar-app-ready'));
}
