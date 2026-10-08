// stateBand.js: 状態の帯(デザインポリシー 2-1・2-2)。
// 今の状態(LIVE / VAR REPLAY / 一時停止中)を、映像の左上に大きく太い文字で出す共通部品。
// 保存中などの一時的な状態は、主の帯の下に小さい帯(サブ帯)で重ねる。
// 見た目と動き(勢いよく入って、わずかに行き過ぎてから収まる)は css/style.css の .state-band が持つ。
// 親機の帯はこのファイルが出すそのまま(setBandState など)を使い、
// 子機の画面など別の帯が要るところは createStateBand で同じ部品を作る。

const MONITOR_LABELS = {
  live: 'LIVE',
  replay: 'VAR REPLAY',
  paused: '一時停止中',
};

// bandId / subId: 帯とサブ帯の要素のid。labels: 状態名 → 帯に出す文字
export function createStateBand({ bandId, subId, labels }) {
  let band = null;
  let sub = null;
  let current = null;
  let subTimer = null;

  function el() {
    if (!band) {
      band = document.getElementById(bandId);
      sub = document.getElementById(subId);
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
  function setState(state) {
    if (!el() || state === current || !labels[state]) return;
    current = state;
    band.dataset.state = state;
    band.querySelector('.state-band-text').textContent = labels[state];
    playEnter(band);
  }

  // サブ帯を出す。autoHideMs を渡すと、その時間だけ出して自動で消す(保存完了の知らせなど)
  function showSub(text, { autoHideMs = 0 } = {}) {
    if (!el()) return;
    clearTimeout(subTimer);
    const changed = sub.hidden || sub.textContent !== text;
    sub.textContent = text;
    sub.hidden = false;
    if (changed) playEnter(sub);
    if (autoHideMs > 0) subTimer = setTimeout(hideSub, autoHideMs);
  }

  function hideSub() {
    if (!el()) return;
    clearTimeout(subTimer);
    sub.hidden = true;
  }

  function subText() {
    return el() && !sub.hidden ? sub.textContent : '';
  }

  // 画面を離れるときに呼ぶ。次に出すとき、同じ状態でも出入りの動きが再生される
  function reset() {
    current = null;
    hideSub();
  }

  return { setState, showSub, hideSub, subText, reset };
}

const monitorBand = createStateBand({ bandId: 'stateBand', subId: 'stateSubBand', labels: MONITOR_LABELS });
export const setBandState = monitorBand.setState;
export const showSubBand = monitorBand.showSub;
export const hideSubBand = monitorBand.hideSub;
export const subBandText = monitorBand.subText;
