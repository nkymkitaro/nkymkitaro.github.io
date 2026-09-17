// CameraLink: WebRTC(PeerJS)による複数カメラ映像の取得・配信を担当するクラス。
// 親機自身のカメラ + 子機(最大3台) = 合計4台までの映像ソースを管理する。
// 「今どんなカメラが繋がっているか」が変わるたびに onCamsChanged で外部(composition root)
// に知らせるだけで、ボタンなどのDOM組み立てはこのクラスの外に任せる(疎結合)。
import { showToast } from './toast.js';

const MAX_REMOTE_CAMS = 3; // 親機1台 + 子機最大3台 = 合計4台まで

export class CameraLink {
  constructor() {
    this.peer = null;
    this.myId = '';
    this.activeSource = 'local';
    this.remoteCams = []; // { id, label, videoEl, connected, call }
    this.onCamsChanged = null; // (sources) => void

    this._nextChildNumber = 1;
    this.localMonitorVideo = document.getElementById('localMonitorVideo');
  }

  static generateShortId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  getAllSources() {
    return [
      { id: 'local', label: '親機', videoEl: this.localMonitorVideo, connected: true },
      ...this.remoteCams.map((c) => ({ id: c.id, label: c.label, videoEl: c.videoEl, connected: c.connected })),
    ];
  }

  getActiveVideoElement() {
    const src = this.getAllSources().find((s) => s.id === this.activeSource);
    return src ? src.videoEl : this.localMonitorVideo;
  }

  _notifyCamsChanged() {
    if (this.onCamsChanged) this.onCamsChanged(this.getAllSources());
  }

  // 親機として起動: 自分のカメラを取得し、子機からの着信も受け付ける(最大3台まで)
  async startAsMonitor(onLocalStreamReady) {
    this.myId = CameraLink.generateShortId();
    document.getElementById('myIdDisplay').textContent = this.myId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.localMonitorVideo.srcObject = stream;
      this.localMonitorVideo.onloadedmetadata = () => {
        this.localMonitorVideo.play();
        onLocalStreamReady(this.localMonitorVideo);
        this._notifyCamsChanged();
      };
    } catch (err) {
      console.error(err);
      showToast('カメラを起動できませんでした。カメラの利用を許可してください。');
    }

    this.peer = new Peer('kendo-var-room-' + this.myId);
    this.peer.on('call', (call) => this._handleIncomingCall(call));
  }

  _handleIncomingCall(call) {
    if (this.remoteCams.length >= MAX_REMOTE_CAMS) {
      // 満員。繋いできた子機にその旨を伝えてから切る。
      const rejectConn = this.peer.connect(call.peer);
      rejectConn.on('open', () => rejectConn.send('FULL'));
      rejectConn.on('error', (e) => console.error(e));
      call.close();
      return;
    }

    call.answer();
    const camId = 'remote-' + call.peer;
    const label = '子機' + this._nextChildNumber++;
    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);

    const camEntry = { id: camId, label, videoEl, connected: true, call };
    this.remoteCams.push(camEntry);

    const markDisconnected = () => {
      if (!camEntry.connected) return;
      camEntry.connected = false;
      this._notifyCamsChanged();
    };
    call.on('close', markDisconnected);

    call.on('stream', (remoteStream) => {
      videoEl.srcObject = remoteStream;
      videoEl.onloadedmetadata = () => {
        videoEl.play();
        this._notifyCamsChanged();
      };
      remoteStream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', markDisconnected);
      });
      // ブラウザによってはcall.on('close')が発火しないことがあるための保険
      const pc = call.peerConnection;
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
          if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
            markDisconnected();
          }
        });
      }
    });
  }

  // 子機として起動: 映像を送るだけの軽量ピア
  startAsCamera() {
    this.peer = new Peer();
    this.peer.on('connection', (conn) => {
      conn.on('data', (data) => {
        if (data === 'FULL') {
          showToast('満員のため接続できませんでした(最大3台まで)');
          const statusEl = document.getElementById('cameraStatus');
          if (statusEl) statusEl.textContent = '未接続';
        }
      });
    });
  }

  async connectToMonitor(targetId) {
    const statusEl = document.getElementById('cameraStatus');
    statusEl.textContent = 'カメラ起動中...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      statusEl.textContent = '接続しています...';
      this.peer.call('kendo-var-room-' + targetId, stream);
      statusEl.textContent = '送信中';
    } catch (err) {
      console.error(err);
      statusEl.textContent = '未接続';
      showToast('接続できませんでした。もう一度お試しください。');
    }
  }

  // ライブ表示するカメラを切り替える。切断済みのカメラへはライブ切り替えできない。
  switchSource(id) {
    const src = this.getAllSources().find((s) => s.id === id);
    if (!src) return false;
    if (!src.connected) {
      showToast(`${src.label}は現在接続されていません`);
      return false;
    }
    this.activeSource = id;
    return true;
  }
}
