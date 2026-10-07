// stateBand.js: 状態の帯(デザインポリシー 2-1・2-2)。
// 今の状態(LIVE / VAR REPLAY / 一時停止中)を、映像の左上に大きく太い文字で出す共通部品。
// 保存中などの一時的な状態は、主の帯の下に小さい帯(サブ帯)で重ねる。
// 見た目と動き(勢いよく入って、わずかに行き過ぎてから収まる)は css/style.css の .state-band が持つ。

const LABELS = {
  live: 'LIVE',
  replay: 'VAR REPLAY',
  paused: '一時停止中',
};

let band = null;
let sub = null;
let current = null;

function el() {
  if (!band) {
    band = document.getElementById('stateBand');
    sub = document.getElementById('stateSubBand');
  }
  return band;
}

// 出入りの動きを最初から再生し直す
function playEnter(target) {
  target.classList.remove('band-enter');
  void target.offsetWidth; // 一度レイアウトさせてから付け直さないと、アニメーションが再生されない
  target.classList.add('band-enter');
}

// 主の帯の状態を切り替える。同じ状態なら何もしない(動かす意味がないため)
export function setBandState(state) {
  if (!el() || state === current || !LABELS[state]) return;
  current = state;
  band.dataset.state = state;
  band.querySelector('.state-band-text').textContent = LABELS[state];
  playEnter(band);
}

export function showSubBand(text) {
  if (!el()) return;
  sub.textContent = text;
  sub.hidden = false;
  playEnter(sub);
}

export function hideSubBand() {
  if (!el()) return;
  sub.hidden = true;
}
