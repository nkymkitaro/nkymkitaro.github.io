// in-app-browser.js: LINE・Instagram などの「アプリの中のブラウザ」で開かれたかを判定し、
// カメラが使える標準のブラウザへ逃がす。
// - アプリ内ブラウザは、カメラ(getUserMedia)が使えないか不安定なことが多い
// - LINE: URLに openExternalBrowser=1 を付けて開き直すと、端末の標準ブラウザで開く(LINEの仕様)。
//   開き直す前は、準備ページ・スタート画面・計測を動かさない(このファイルは <head> で最初に読む)
// - LINEで移れなかった場合(古いLINEなど)と、ほかのアプリ内ブラウザでは、「ブラウザで開いてください」の画面を出し、先へ進ませない
// - 判定の結果は window.kendoInApp に置き、ほかのファイル(計測・ホーム画面に追加)からも使う
// ふつうの <script> として読む(type="module" にしない)。描画の前に判定と開き直しを済ませるため
(function () {
  'use strict';

  // アプリ内ブラウザの印(User-Agent に含まれる文字)。増えたら、ここに1行足す
  var IN_APP_MARKS = [
    { name: 'line', pattern: / Line\//i },
    { name: 'instagram', pattern: /Instagram/i },
    { name: 'facebook', pattern: /FBAN|FBAV|FB_IAB/ },
    { name: 'x', pattern: /Twitter/i },
    { name: 'tiktok', pattern: /musical_ly|BytedanceWebview/i },
    { name: 'snapchat', pattern: /Snapchat/i },
    { name: 'wechat', pattern: /MicroMessenger/i },
  ];
  var EXTERNAL_PARAM = 'openExternalBrowser';

  function detect(ua) {
    for (var i = 0; i < IN_APP_MARKS.length; i++) {
      if (IN_APP_MARKS[i].pattern.test(ua)) return IN_APP_MARKS[i].name;
    }
    return null;
  }

  function hasExternalParam() {
    try { return new URLSearchParams(window.location.search).get(EXTERNAL_PARAM) === '1'; } catch (e) { return false; }
  }

  // 今のURLに openExternalBrowser=1 を付ける(?join= などほかの引数と # は残す)
  function urlWithExternalParam() {
    var url = new URL(window.location.href);
    url.searchParams.set(EXTERNAL_PARAM, '1');
    return url.toString();
  }

  // 人に渡すURL(openExternalBrowser は外す。ほかの引数と # は残す)
  function shareableUrl() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete(EXTERNAL_PARAM);
      return url.toString();
    } catch (e) {
      return window.location.href;
    }
  }

  var ua = (navigator && navigator.userAgent) || '';
  var kind = detect(ua);
  var leaving = false;
  var blocked = false;

  if (kind === 'line' && !hasExternalParam()) {
    // LINE: 標準ブラウザで開き直す。一瞬スタート画面が見えないよう、描画も止めておく
    try {
      document.documentElement.style.visibility = 'hidden';
      window.location.replace(urlWithExternalParam());
      leaving = true;
    } catch (e) {
      document.documentElement.style.visibility = '';
      blocked = true;
    }
  } else if (kind) {
    // LINEで移れなかった(開き直したのにまだLINEの中)、またはほかのアプリ内ブラウザ
    blocked = true;
  }

  if (kind) document.documentElement.classList.add('in-app');
  if (blocked) document.documentElement.classList.add('in-app-blocked');

  // 「URLをコピー」。押したら、ボタンの文字で「コピーしました」と知らせる(この画面ではほかの知らせが見えないため)
  function initCopyButton() {
    var btn = document.getElementById('btnInAppCopy');
    if (!btn) return;
    var label = btn.textContent;
    var timer = null;
    btn.addEventListener('click', function () {
      var text = shareableUrl();
      var done = function (ok) {
        btn.textContent = ok ? 'コピーしました' : 'コピーできませんでした';
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = label; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
      } else {
        done(fallbackCopy(text));
      }
    });
  }

  // クリップボードAPIが使えないアプリ内ブラウザ向けの予備
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  if (blocked) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCopyButton);
    else initCopyButton();
  }

  window.kendoInApp = {
    kind: kind, // null(ふつうのブラウザ) / 'line' / 'instagram' など
    isInApp: function () { return !!kind; },
    leaving: leaving, // 標準ブラウザへ開き直している最中
    blocked: blocked, // 「ブラウザで開いてください」を出して、先へ進ませない
    detect: detect,
    shareableUrl: shareableUrl,
  };
})();
