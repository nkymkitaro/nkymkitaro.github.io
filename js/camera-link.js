// CameraLink: WebRTC(PeerJS)によるカメラ映像の取得・配信を担当するクラス。
// VARPlayer(録画・再生ロジック)からは完全に独立しており、
// 「今どの映像ソースを見るべきか」を getActiveVideoElement() だけで教える。
export class CameraLink {
  constructor() {
    this.peer = null;
    this.myId = '';
    this.isRemoteConnected = false;
    this.activeSource = 'local';

    this.localMonitorVideo = document.getElementById('localMonitorVideo');
    this.remoteVideo = document.getElementById('remoteVideo');
    this.btnCamLocal = document.getElementById('btnCamLocal');
    this.btnCamRemote = document.getElementById('btnCamRemote');
  }

  static generateShortId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  getActiveVideoElement() {
    return this.activeSource === 'local' ? this.localMonitorVideo : this.remoteVideo;
  }

  // 親機として起動: 自分のカメラを取得し、子機からの着信も受け付ける
  async startAsMonitor(onLocalStreamReady) {
    this.myId = CameraLink.generateShortId();
    document.getElementById('myIdDisplay').textContent = this.myId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
      this.localMonitorVideo.srcObject = stream;
      this.localMonitorVideo.onloadedmetadata = () => {
        this.localMonitorVideo.play();
        onLocalStreamReady(this.localMonitorVideo);
      };
    } catch (err) {
      alert('親機カメラの起動失敗: ' + err);
    }

    this.peer = new Peer('kendo-var-room-' + this.myId);
    this.peer.on('call', (call) => {
      call.answer();
      call.on('stream', (remoteStream) => {
        this.remoteVideo.srcObject = remoteStream;
        this.remoteVideo.onloadedmetadata = () => {
          this.remoteVideo.play();
          this.isRemoteConnected = true;
          this.btnCamRemote.textContent = '📱 子機カメラ (接続中)';
        };
      });
    });
  }

  // 子機として起動: 映像を送るだけの軽量ピア
  startAsCamera() {
    this.peer = new Peer();
  }

  async connectToMonitor(targetId) {
    const statusEl = document.getElementById('cameraStatus');
    statusEl.textContent = 'カメラ起動中...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
      statusEl.textContent = '親機へ接続中...';
      this.peer.call('kendo-var-room-' + targetId, stream);
      statusEl.textContent = '✅ 親機へ映像リアルタイム送信中！';
    } catch (err) {
      alert('接続エラー: ' + err);
    }
  }

  switchSource(source, onSwitch) {
    if (source === 'remote' && !this.isRemoteConnected) {
      alert('子機カメラが未接続です。子機側で4桁IDを入力して送信してください。');
      return;
    }
    this.activeSource = source;
    this.btnCamLocal.className = source === 'local' ? 'btn-active' : '';
    this.btnCamRemote.className = source === 'remote' ? 'btn-active' : '';
    onSwitch();
  }
}
