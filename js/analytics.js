// analytics.js: アクセス解析(Google アナリティクス 4)への送信を、ここ1か所にまとめる。
// - 各画面からは track() を呼ぶだけ。GA4が表示する標準のタグはそのまま貼らず、下の「設定」で読み込む
// - 送るのは本番のドメインで開いたときだけ(開発中・ローカル・旧URLでは何も送らない)
// - 送る出来事と情報は下の ALLOWED_EVENTS に書いたものだけ。映像・番号・接続ID・自由入力は送らない
// - 読み込みや送信に失敗しても、アプリの動きを止めない・遅らせない(非同期で読み込み、エラーは無視する)

// ---- 設定(数字や名前を変えるときは、ここだけ) ----
const MEASUREMENT_ID = 'G-E82YFBQNKP';
// 本番のドメイン。ここで開いたときだけ送る。www付きは同じサイトなので含める
const ALLOWED_HOSTNAMES = ['kendovar.jp', 'www.kendovar.jp'];
// 広告用の機能は使わない。ページ表示は自動では送らず、下の出来事だけを送る
const GA_CONFIG = {
  send_page_view: false,
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
};

// 送ってよい出来事と、付けてよい情報の名前(これ以外は送らない)
const ALLOWED_EVENTS = {
  app_open: ['display_mode'],
  prep_choice: ['choice'],
  role_answer: ['user_role', 'ask_count'],
  role_select: ['role'],
  camera_join_result: ['result', 'reason', 'method'], // method: qr(QRから) / code(4桁を入れて)
  camera_reconnect: [],
  var_open: ['cameras'],
  var_zoom: [], // リプレイ中に拡大を使った(VAR1回につき1度)
  var_scrub: [], // リプレイ中に映像をなぞってコマ送りした(VAR1回につき1度)
  clip_save: ['count', 'all_cameras'],
  line_open: [],
};
const MAX_STRING_LENGTH = 40; // 万一、長い文字が混ざっても送らない

let enabled = false;

function isProductionHost() {
  try { return ALLOWED_HOSTNAMES.includes(window.location.hostname); } catch (err) { return false; }
}

// 解析を始める。本番のドメイン以外では何もしない。呼び出しは1回でよい
export function initAnalytics({ userRole } = {}) {
  if (enabled || !isProductionHost()) return;
  try {
    window.dataLayer = window.dataLayer || [];
    // gtag.js の決まりで、引数の並び(arguments)をそのまま積む
    window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); }; // eslint-disable-line prefer-rest-params
    window.gtag('js', new Date());
    window.gtag('config', MEASUREMENT_ID, GA_CONFIG);
    enabled = true;
    if (userRole) setUserRole(userRole);

    // 読み込みは非同期。失敗(広告ブロッカーなど)しても何も起きない
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
    script.addEventListener('error', () => { /* 読み込めなくても使える */ });
    document.head.appendChild(script);
  } catch (err) {
    enabled = false;
  }
}

// 値を送ってよい形に整える。文字・数・真偽値だけを通す
function cleanParams(allowedNames, params) {
  const out = {};
  if (!params) return out;
  allowedNames.forEach((name) => {
    const value = params[name];
    if (typeof value === 'string') out[name] = value.slice(0, MAX_STRING_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (typeof value === 'boolean') out[name] = value;
  });
  return out;
}

// 出来事を1つ送る。許可していない名前・情報は送らない
export function track(eventName, params) {
  if (!enabled) return;
  try {
    const allowedNames = ALLOWED_EVENTS[eventName];
    if (!allowedNames) return;
    window.gtag('event', eventName, cleanParams(allowedNames, params));
  } catch (err) { /* 送れなくても使える */ }
}

// 「立場」を、以後の出来事に付くユーザーの属性(user_role)として設定する
export function setUserRole(role) {
  if (!enabled || !role) return;
  try {
    window.gtag('set', 'user_properties', { user_role: String(role).slice(0, MAX_STRING_LENGTH) });
  } catch (err) { /* 設定できなくても使える */ }
}

// ホーム画面から開いたか、ブラウザで開いたか
export function getDisplayMode() {
  try {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    return standalone ? 'home_screen' : 'browser';
  } catch (err) {
    return 'browser';
  }
}
