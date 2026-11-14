// 介面語言（中／EN），外殼和每個主題共用；要放在 <head>，其他程式之前載入
// 決定順序跟 Aron Lab 一樣：網址的 ?lang= → 自己選過的 → IP 地區 → 瀏覽器語言
// IP 地區由 functions/index.js 在 Cloudflare 寫進外殼的 <html data-geo>：台灣、香港、澳門、中國用中文，其他地區用英文
// 主題在外殼的 iframe 裡時直接跟外殼走；外殼切換語言會重新載入主題
// 用法：程式裡 tr('中文', 'English')；HTML 裡 data-en="English"（內容可含標籤）、data-en-title、data-en-aria
(function () {
  const KEY = 'ticker.lang', h = document.documentElement;
  const ok = (v) => (v === 'zh' || v === 'en' ? v : null);
  let lang = null;
  try { if (window.parent !== window) lang = ok(window.parent.document.documentElement.dataset.lang); } catch { /* 跨網域就自己判斷 */ }
  if (!lang) {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* 無痕模式 */ }
    const g = h.dataset.geo, geo = /^[A-Z]{2}$/.test(g || '') ? (/^(TW|HK|MO|CN)$/.test(g) ? 'zh' : 'en') : null;
    const browser = [].concat(navigator.languages || navigator.language || []).some((x) => /^zh/i.test(x)) ? 'zh' : 'en';
    lang = ok(new URLSearchParams(location.search).get('lang')) || ok(saved) || geo || browser;
  }
  let EN;
  const use = (l) => { lang = l; EN = l === 'en'; h.dataset.lang = l; h.lang = EN ? 'en' : 'zh-Hant'; };
  use(lang);

  function apply(root = document) {
    if (!EN) return;
    root.querySelectorAll('[data-en]').forEach((el) => { el.innerHTML = el.dataset.en; });
    root.querySelectorAll('[data-en-title]').forEach((el) => { el.title = el.dataset.enTitle; });
    root.querySelectorAll('[data-en-aria]').forEach((el) => { el.setAttribute('aria-label', el.dataset.enAria); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply()); else apply();

  window.tr = (zh, en) => (EN ? en : zh);
  window.I18N = {
    get lang() { return lang; }, get en() { return EN; }, apply,
    // 外殼的切換按鈕用：換語言並記住（網址的 ?lang= 不會蓋掉記住的選擇）
    set(l) { if (!ok(l)) return; use(l); try { localStorage.setItem(KEY, l); } catch { /* ignore */ } },
    // 星期：中文「六」、英文「Sat」
    wd: (i) => (EN ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六'])[i],
  };
})();
