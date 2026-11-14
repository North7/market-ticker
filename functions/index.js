// Cloudflare Pages Function：只在首頁（/）執行，其他檔案照常直接給。
// 把訪客 IP 所在的國家（Cloudflare 的 request.cf.country，例如 TW、US）寫進 <html data-geo>，
// themes/i18n.js 用它決定預設語言：網址的 ?lang= → 自己選過的 → IP 地區 → 瀏覽器語言。
// 主題在首頁的 iframe 裡，直接跟首頁的語言走；GitHub Pages 跑不了這個，那邊就照舊看瀏覽器語言。
export async function onRequest({ request, next }) {
  const res = await next();
  const country = request.cf && request.cf.country;
  if (!country || !/^[A-Z]{2}$/.test(country) || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  return new HTMLRewriter().on('html', { element(el) { el.setAttribute('data-geo', country); } }).transform(res);
}
