// 五個設計方案共用的即時資料：Binance BTC + 本機 /api/markets
(function () {
  const REST = 'https://api.binance.com/api/v3/klines';
  // 9443 埠在部分網路（公司、學校、某些 Wi-Fi）會被擋，連不上就輪下一個
  const WS_HOSTS = ['wss://stream.binance.com:443', 'wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
  const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  const S = { price: null, prev: null, dir: 0, ticker: null, bars: {}, limit: {}, markets: [], trades: [], ticks: [] };
  const L = {};
  const emit = (e, ...a) => (L[e] || []).forEach((f) => f(...a));

  async function loadBars(tf) {
    try {
      const r = await fetch(`${REST}?symbol=BTCUSDT&interval=${tf}&limit=${S.limit[tf]}`);
      const rows = await r.json();
      S.bars[tf] = rows.map((k) => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      emit('bars', tf);
    } catch (e) { setTimeout(() => loadBars(tf), 5000); }
  }

  function upsert(tf, bar) {
    const a = S.bars[tf];
    if (!a) return;
    const last = a[a.length - 1];
    if (!last || bar.t > last.t) { a.push(bar); if (a.length > S.limit[tf] * 1.5) a.splice(0, a.length - S.limit[tf]); }
    else if (bar.t === last.t) Object.assign(last, bar);
  }

  const BIG_USD = 200000;
  let lastHi = 0, lastLo = 0;
  function setPrice(p, T) {
    S.prev = S.price; S.price = p;
    if (S.prev != null && p !== S.prev) S.dir = p > S.prev ? 1 : -1;
    for (const tf in S.bars) {
      const a = S.bars[tf], last = a[a.length - 1];
      if (!last) continue;
      const sec = TF_SEC[tf];
      if (T / 1000 >= last.t + sec) upsert(tf, { t: Math.floor(T / 1000 / sec) * sec, o: p, h: p, l: p, c: p, v: 0 });
      else { last.c = p; if (p > last.h) last.h = p; if (p < last.l) last.l = p; }
    }
  }
  function onTrade(d) {
    const p = +d.p;
    lastTrade = Date.now();
    setPrice(p, d.T);
    // 最近 3 分鐘逐筆（示波器、買賣力道用）
    S.ticks.push({ T: d.T, p, q: +d.q, m: d.m });
    if (S.ticks[0].T < d.T - 180000) { let k = 0; while (k < S.ticks.length && S.ticks[k].T < d.T - 180000) k++; S.ticks.splice(0, k); }
    // 即時事件（給 fx.js 的動效）：現貨大單、創 24H 新高／新低（30 秒內不重複）
    const usd = p * +d.q;
    if (usd >= BIG_USD) emit('fx', { type: 'big', usd, side: d.m ? 'sell' : 'buy', T: d.T });
    const tk = S.ticker;
    if (tk && tk.h && p > tk.h) { tk.h = p; if (d.T - lastHi > 30000) { lastHi = d.T; emit('fx', { type: 'high', price: p }); } }
    if (tk && tk.l && p < tk.l) { tk.l = p; if (d.T - lastLo > 30000) { lastLo = d.T; emit('fx', { type: 'low', price: p }); } }
    S.trades.unshift({ p, q: +d.q, T: d.T, m: d.m });
    if (S.trades.length > 40) S.trades.length = 40;
    emit('trade', S.trades[0]);
  }

  // 開頁先補最近的逐筆成交，示波器不用等
  async function seedTicks() {
    // 分頁補齊最近 130 秒的逐筆成交（熱絡時 1000 筆不到一分鐘）
    try {
      const now = Date.now(), rows = [];
      let start = now - 130000;
      for (let i = 0; i < 8 && start < now; i++) {
        const r = await fetch(`https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&startTime=${start}&endTime=${now}&limit=1000`);
        const page = await r.json();
        if (!Array.isArray(page) || !page.length) break;
        rows.push(...page);
        if (page.length < 1000) break;
        start = page[page.length - 1].T + 1;
      }
      const first = S.ticks.length ? S.ticks[0].T : Infinity;
      const old = rows.filter((x) => x.T < first).map((x) => ({ T: x.T, p: +x.p, q: +x.q, m: x.m }));
      S.ticks.unshift(...old);
      // 即時串流還沒進來前，先用最後一筆成交價顯示
      if (S.price == null && old.length) S.price = old[old.length - 1].p;
    } catch { /* 沒補到就從現在開始累積 */ }
  }

  let ws, retry = 0, lastMsg = 0, lastTrade = 0, host = 0;
  function connect() {
    const streams = ['btcusdt@aggTrade', 'btcusdt@ticker', ...Object.keys(S.limit).map((tf) => `btcusdt@kline_${tf}`)];
    const me = ws = new WebSocket(`${WS_HOSTS[host]}/stream?streams=${streams.join('/')}`);
    let got = false;
    // 被擋的埠常常不會報錯，只是一直連不上 → 8 秒沒打開就換下一個
    const guard = setTimeout(() => { if (me.readyState !== 1) me.close(); }, 8000);
    ws.onopen = () => { clearTimeout(guard); lastMsg = Date.now(); emit('status', true); };
    ws.onmessage = (ev) => {
      if (!got) { got = true; retry = 0; }
      lastMsg = Date.now();
      const { stream, data } = JSON.parse(ev.data);
      if (stream.endsWith('@aggTrade')) onTrade(data);
      else if (stream.endsWith('@ticker')) { S.ticker = { c: +data.c, o: +data.o, h: +data.h, l: +data.l, p: +data.p, P: +data.P, q: +data.q, v: +data.v }; emit('ticker'); }
      else if (data.k) { const k = data.k; upsert(k.i, { t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }); }
    };
    ws.onclose = () => {
      clearTimeout(guard);
      if (me !== ws) return;
      emit('status', false);
      if (!got) host = (host + 1) % WS_HOSTS.length;
      setTimeout(() => { Object.keys(S.limit).forEach(loadBars); connect(); }, got ? 1000 : Math.min(30000, 500 * 2 ** retry++));
    };
    ws.onerror = () => me.close();
  }
  setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsg > 15000) ws.close(); }, 5000);

  // 保底：串流 10 秒沒有成交進來，就用 REST 每 3 秒抓一次 24H 行情，價格不會停在「—」
  async function pollTicker() {
    if (Date.now() - lastTrade < 10000) return;
    try {
      const d = await (await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { cache: 'no-store' })).json();
      if (Date.now() - lastTrade < 10000 || !d.lastPrice) return;
      S.ticker = { c: +d.lastPrice, o: +d.openPrice, h: +d.highPrice, l: +d.lowPrice, p: +d.priceChange, P: +d.priceChangePercent, q: +d.quoteVolume, v: +d.volume };
      setPrice(+d.lastPrice, Date.now());
      emit('ticker');
    } catch { /* 下次再試 */ }
  }
  setInterval(pollTicker, 3000);

  // ---- 模式：本機有 server.py 就顯示台美股（stocks）；連不到（例如 GitHub Pages）就換成加密指標（crypto）
  // 網址加 ?mode=crypto 或 ?mode=stocks 可強制（外殼的網址參數也會傳給主題）
  function forcedMode() {
    const q = (u) => { try { return new URLSearchParams(u).get('mode'); } catch { return null; } };
    let m = q(location.search);
    if (!m && window.parent !== window) { try { m = q(window.parent.location.search); } catch { /* 跨網域就算了 */ } }
    return m === 'crypto' || m === 'stocks' ? m : null;
  }
  S.mode = forcedMode();
  let stockTimer = null;

  async function pollMarkets() {
    try {
      const r = await fetch('/api/markets', { cache: 'no-store' });
      if (!r.ok) throw new Error('no api');
      const d = await r.json();
      if (!S.mode) { S.mode = 'stocks'; emit('mode'); }
      S.markets = d.symbols.map((s) => {
        const chg = s.price != null && s.prevClose ? s.price - s.prevClose : 0;
        const pct = s.prevClose ? chg / s.prevClose * 100 : 0;
        const amp = s.prevClose && s.high && s.low ? (s.high - s.low) / s.prevClose * 100 : 0;
        const lo = Math.min(s.low ?? s.price, s.prevClose ?? s.price, s.price);
        const hi = Math.max(s.high ?? s.price, s.prevClose ?? s.price, s.price);
        const pos = hi > lo ? (s.price - lo) / (hi - lo) : 0.5;
        const dec = s.id === 'TAIEX' || s.market === 'US' ? 2 : s.price >= 1000 ? 0 : 2;
        return { ...s, chg, pct, amp, pos, dec, rangeLo: lo, rangeHi: hi };
      });
      emit('markets');
    } catch {
      // 第一次就連不到 → 沒有本機伺服器，切到加密模式
      if (!S.mode && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) { S.mode = 'crypto'; clearInterval(stockTimer); emit('mode'); startCrypto(); }
    }
  }

  const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '--' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtBig = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : fmt(v, 0);
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  const pct = (v) => `${sgn(v)}${Math.abs(v).toFixed(2)}%`;

  // =====================================================================
  // 加密模式：6 個指標＋ETH／穩定幣，全部是可跨網域的公開 API，不需要伺服器或金鑰
  // =====================================================================
  const WHALE_USD = 100000, HOUR = 3600e3;
  const CR = { whales: [], liqs: [], since: Date.now(), taker: [], cb: null, cbHist: [], fng: [], daily: [], h1: [], eth: null, stable: null };
  const jget = (u) => fetch(u, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const money = (v) => { const a = Math.abs(v); return '$' + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'K' : a.toFixed(0)); };
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const trim = (arr) => { const cut = Date.now() - HOUR; let k = 0; while (k < arr.length && arr[k].T < cut) k++; if (k) arr.splice(0, k); };
  function rsi(closes, n = 14) {
    if (closes.length <= n) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(0, d)) / n; l = (l * (n - 1) + Math.max(0, -d)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null);
  // 把一串數值變成迷你圖用的 bars（o=前一點）
  const series = (vals, t0, step) => vals.map((v, i) => ({ t: t0 + i * step, o: i ? vals[i - 1] : v, h: Math.max(v, i ? vals[i - 1] : v), l: Math.min(v, i ? vals[i - 1] : v), c: v }));
  // 事件流（鯨魚、爆倉）→ 12 段 5 分鐘的累計曲線
  function cumulative(list, f) {
    const now = Date.now(), out = []; let acc = 0;
    for (let k = 11; k >= 0; k--) { const a = now - (k + 1) * 300e3, b = now - k * 300e3; for (const x of list) if (x.T >= a && x.T < b) acc += f(x); out.push(acc); }
    return series(out, Math.floor((now - HOUR) / 1000), 300);
  }
  const ago = () => { const m = Math.round((Date.now() - CR.since) / 60000); return m < 60 ? `開頁 ${m} 分鐘內` : '近 1 小時'; };

  function buildCrypto() {
    trim(CR.whales); trim(CR.liqs);
    const out = [];
    const base = { market: 'CR', isOpen: true, statusText: 'LIVE', slots: 12, dec: 2 };
    // 1 鯨魚買賣
    { const buy = CR.whales.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0), sell = CR.whales.filter((x) => x.side === 'sell').reduce((a, x) => a + x.usd, 0);
      const net = buy - sell, share = buy + sell ? buy / (buy + sell) : 0.5, big = CR.whales.reduce((m, x) => (!m || x.usd > m.usd ? x : m), null);
      out.push({ ...base, id: 'WHALE', code: 'WHALE', icon: 'WH', name: '鯨魚買賣', venue: '現貨＋期貨 ≥$100K', price: net, display: signed(net, money), chg: net, pct: (share - 0.5) * 100,
        chgText: CR.whales.length ? `買 ${Math.round(share * 100)}%` : '等待大單', pos: share, prevClose: 0, amp: share * 5, posLabel: '買方',
        sub: `${CR.whales.length} 筆 · ${big ? '最大 ' + money(big.usd) + (big.side === 'buy' ? ' 買' : ' 賣') : ago()}`, bars: cumulative(CR.whales, (x) => (x.side === 'buy' ? x.usd : -x.usd)) }); }
    // 2 爆倉
    { const longs = CR.liqs.filter((x) => x.side === 'long').reduce((a, x) => a + x.usd, 0), shorts = CR.liqs.filter((x) => x.side === 'short').reduce((a, x) => a + x.usd, 0);
      const tot = longs + shorts, ls = tot ? longs / tot : 0.5, big = CR.liqs.reduce((m, x) => (!m || x.usd > m.usd ? x : m), null);
      out.push({ ...base, id: 'LIQ', code: 'LIQ', icon: 'LQ', name: '爆倉', venue: 'Binance＋Bybit', price: tot, display: money(tot), chg: shorts - longs, pct: (0.5 - ls) * 100,
        chgText: tot ? `多單 ${Math.round(ls * 100)}%` : '暫無爆倉', pos: ls, prevClose: 0, amp: ls * 5, posLabel: '多單',
        sub: big ? `最大 ${money(big.usd)} ${big.side === 'long' ? '多單' : '空單'}` : ago(), bars: cumulative(CR.liqs, (x) => x.usd) }); }
    // 3 主動買賣比（期貨 taker）
    { const t = CR.taker, last = t[t.length - 1];
      const ratio = last ? last.r : 1, share = ratio / (1 + ratio);
      out.push({ ...base, id: 'TAKER', code: 'TAKER', icon: 'TK', name: '主動買賣比', venue: 'Binance 期貨 · 5 分', price: ratio, display: ratio.toFixed(2), chg: ratio - 1, pct: (ratio - 1) * 100,
        chgText: `買 ${Math.round(share * 100)}%`, pos: share, prevClose: 1, amp: share * 5, posLabel: '買方', slots: 48,
        sub: last ? `買 ${money(last.buy * (S.price || 0))} · 賣 ${money(last.sell * (S.price || 0))}` : '—', bars: series(t.map((x) => x.r), t.length ? Math.floor(t[0].T / 1000) : 0, 300) }); }
    // 4 Coinbase 溢價
    { const prem = CR.cb != null && S.price ? CR.cb - S.price : 0, pp = S.price ? prem / S.price * 100 : 0;
      out.push({ ...base, id: 'CBP', code: 'CB PREM', icon: 'CB', name: 'Coinbase 溢價', venue: 'Coinbase − Binance', price: prem, display: signed(prem, (v) => '$' + v.toFixed(1)), chg: prem, pct: pp,
        chgText: signed(pp, (v) => v.toFixed(3) + '%'), pos: clamp01(0.5 + pp / 0.2), prevClose: 0, amp: clamp01(0.5 + pp / 0.2) * 5, posLabel: '溢價', slots: 120,
        sub: prem >= 0 ? '美國現貨買盤較強' : '美國現貨買盤較弱', bars: CR.cbHist }); }
    // 5 恐懼貪婪
    { const f = CR.fng, now = f[f.length - 1], prev = f[f.length - 2];
      const v = now ? now.v : 50, ZH = { 'Extreme Fear': '極度恐懼', Fear: '恐懼', Neutral: '中性', Greed: '貪婪', 'Extreme Greed': '極度貪婪' };
      out.push({ ...base, id: 'FNG', code: 'F&G', icon: 'FG', name: '恐懼貪婪', venue: 'alternative.me · 每日', price: v, display: String(v), chg: v - 50, pct: v - 50,
        chgText: now ? ZH[now.c] || now.c : '—', pos: v / 100, prevClose: 50, amp: v / 20, posLabel: '指數', slots: 30,
        sub: prev ? `昨日 ${prev.v} · 7 日均 ${Math.round(f.slice(-7).reduce((a, x) => a + x.v, 0) / Math.min(7, f.length))}` : '—', bars: series(f.map((x) => x.v), f.length ? f[0].t : 0, 86400) }); }
    // 6 200 日線乖離：現價相對 200 日均線的百分比（純數值，不下牛熊結論）＋ 4H RSI(14)
    { const dc = CR.daily.map((b) => b.c), ma200 = sma(dc, 200), px = S.price || dc[dc.length - 1];
      const r4 = rsi((S.bars['4h'] || []).map((b) => b.c)), r1d = rsi(dc);
      const dev = ma200 && px ? (px / ma200 - 1) * 100 : null, chg = dev != null ? px - ma200 : 0;
      const d60 = dc.slice(-60);
      out.push({ ...base, id: 'TREND', code: 'MA200', icon: 'MA', name: '200 日線乖離', venue: 'Binance 日線 · RSI(14)', price: chg,
        display: dev != null ? signed(dev, (v) => v.toFixed(1) + '%') : '—', chg, pct: dev || 0,
        chgText: r4 != null ? `RSI ${Math.round(r4)}` : '—', pos: r4 != null ? r4 / 100 : 0.5, prevClose: ma200 || 0, amp: (r4 || 50) / 20, posLabel: 'RSI 4H', slots: 60,
        sub: ma200 ? `200 日線 ${fmt(ma200, 0)} · RSI 4H ${r4 != null ? Math.round(r4) : '—'} · 1D ${r1d != null ? Math.round(r1d) : '—'}` : '—',
        bars: series(d60, CR.daily.length ? CR.daily[CR.daily.length - d60.length].t : 0, 86400) }); }
    S.markets = out;
    emit('markets');
  }

  // 爆倉進來：累計，≥ 10 萬美元另外發動效事件
  function liq(x) { CR.liqs.push(x); if (x.usd >= 100000) emit('fx', { type: 'liq', usd: x.usd, side: x.side }); }

  function startCrypto() {
    // 鯨魚：現貨逐筆（主連線已在收）＋期貨逐筆；爆倉：Binance forceOrder＋Bybit allLiquidation
    (L.trade || (L.trade = [])).push((t) => { const usd = t.p * t.q; if (usd >= WHALE_USD) CR.whales.push({ T: t.T, usd, side: t.m ? 'sell' : 'buy' }); });
    const fut = () => {
      const w = new WebSocket('wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@forceOrder');
      let last = Date.now();
      w.onmessage = (ev) => {
        last = Date.now();
        const { stream, data } = JSON.parse(ev.data);
        if (stream.endsWith('@aggTrade')) { const usd = +data.p * +data.q; if (usd >= WHALE_USD) CR.whales.push({ T: data.T, usd, side: data.m ? 'sell' : 'buy' }); }
        else if (data.o) { const o = data.o; liq({ T: o.T, usd: +o.ap * +o.z || +o.p * +o.q, side: o.S === 'SELL' ? 'long' : 'short', src: 'binance' }); }
      };
      w.onclose = () => setTimeout(fut, 3000); w.onerror = () => w.close();
      const wd = setInterval(() => { if (Date.now() - last > 30000) { clearInterval(wd); w.close(); } }, 10000);
    };
    const bybit = () => {
      const w = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      let ping;
      w.onopen = () => { w.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] })); ping = setInterval(() => w.send('{"op":"ping"}'), 20000); };
      w.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.topic && m.topic.startsWith('allLiquidation') && Array.isArray(m.data)) for (const x of m.data) liq({ T: +x.T, usd: +x.v * +x.p, side: x.S === 'Buy' ? 'long' : 'short', src: 'bybit' }); };
      w.onclose = () => { clearInterval(ping); setTimeout(bybit, 3000); }; w.onerror = () => w.close();
    };
    fut(); bybit();
    const seen = new Set();
    const scanSeed = () => { for (const t of S.ticks) { const usd = t.p * t.q; if (usd >= WHALE_USD && !seen.has(t.T + ':' + usd)) { seen.add(t.T + ':' + usd); CR.whales.push({ T: t.T, usd, side: t.m ? 'sell' : 'buy' }); } } CR.whales.sort((a, b) => a.T - b.T); };
    setTimeout(scanSeed, 3000); setTimeout(scanSeed, 8000);
    const every = (ms, f) => { const run = () => f().catch(() => {}); run(); setInterval(run, ms); };
    every(60e3, async () => { const d = await jget('https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=48');
      CR.taker = d.map((x) => ({ T: x.timestamp, r: +x.buySellRatio, buy: +x.buyVol, sell: +x.sellVol })); });
    every(5e3, async () => { const d = await jget('https://api.exchange.coinbase.com/products/BTC-USD/ticker'); CR.cb = +d.price; });
    every(60e3, async () => {
      const d = await jget('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60');   // [time, low, high, open, close, vol]，新到舊
      const bm = new Map((S.bars['1m'] || []).map((b) => [b.t, b.c]));
      const pts = d.slice(0, 120).reverse().filter((c) => bm.has(c[0])).map((c) => ({ t: c[0], v: c[4] - bm.get(c[0]) }));
      CR.cbHist = series(pts.map((p) => p.v), pts.length ? pts[0].t : 0, 60);
    });
    every(1800e3, async () => { const d = await jget('https://api.alternative.me/fng/?limit=30'); CR.fng = d.data.map((x) => ({ v: +x.value, c: x.value_classification, t: +x.timestamp })).reverse(); });
    every(600e3, async () => { const d = await jget('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=300'); CR.daily = d.map((k) => ({ t: k[0] / 1000, c: +k[4] })); });
    every(60e3, async () => { const d = await jget('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100'); CR.h1 = d.map((k) => ({ t: k[0] / 1000, c: +k[4] })); });
    every(10e3, async () => { const d = await jget('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT'); CR.eth = { price: +d.lastPrice, P: +d.priceChangePercent }; emit('extras'); });
    every(3600e3, async () => {
      const d = await jget('https://stablecoins.llama.fi/stablecoins?includePrices=false');
      let now = 0, wk = 0; for (const a of d.peggedAssets) { now += (a.circulating && a.circulating.peggedUSD) || 0; wk += (a.circulatingPrevWeek && a.circulatingPrevWeek.peggedUSD) || 0; }
      CR.stable = { total: now, wk: wk ? (now / wk - 1) * 100 : 0 }; emit('extras');
    });
    setInterval(buildCrypto, 1500); setTimeout(buildCrypto, 800);
  }

  // 頂部資訊列小字：加密模式下顯示 ETH 和穩定幣總供給
  function extrasText() {
    const e = CR.eth, st = CR.stable;
    return [e ? `ETH ${fmt(e.price, 1)} ${pct(e.P)}` : null, st ? `穩定幣 ${money(st.total)}（7 日 ${pct(st.wk)}）` : null].filter(Boolean).join(' · ');
  }

  // 顯示用小工具：股票模式照舊；加密指標用自己的文字
  const val = (s) => s.display ?? fmt(s.price, s.dec);
  const chgTxt = (s) => s.chgText ?? pct(s.pct || 0);
  const sub = (s, label) => s.sub ?? `${label} ${(s.amp || 0).toFixed(2)}%`;
  const slots = (s) => s.slots ?? (s.market === 'TW' ? 54 : 78);
  const venue = (s) => s.venue ?? (s.market === 'TW' ? 'TWSE' : 'NYSE');

  function tzNow(tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    const zh = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' }[p.weekday];
    return { wd: p.weekday, wdZh: zh, mo: p.month, dd: p.day, hh: p.hour, mm: p.minute, ss: p.second, str: `${p.hour}:${p.minute}:${p.second}`, date: `${+p.month}/${+p.day}（${zh}）` };
  }

  window.Feed = {
    S, fmt, fmtBig, sgn, pct, tzNow, val, chgTxt, sub, slots, venue, extrasText,
    emit,   // 測試動效用：Feed.emit('fx', { type: 'big', usd: 2e6, side: 'buy' })
    get mode() { return S.mode; },
    on(e, f) { (L[e] || (L[e] = [])).push(f); if (e === 'mode' && S.mode) f(); },   // 模式已定就立刻跑一次
    // 把 ETH／穩定幣小字掛到某個元素上（只在加密模式顯示）
    mountExtras(el) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return;
      const paint = () => { const t = S.mode === 'crypto' ? extrasText() : ''; el.textContent = t; el.style.display = t ? '' : 'none'; };
      (L.extras || (L.extras = [])).push(paint); (L.mode || (L.mode = [])).push(paint); paint();
    },
    start(limits = { '1m': 240, '4h': 180 }) {
      S.limit = limits;
      Object.keys(limits).forEach(loadBars);
      seedTicks();
      connect();
      if (S.mode === 'crypto') { emit('mode'); startCrypto(); }
      else { pollMarkets(); stockTimer = setInterval(pollMarkets, 5000); }
      setInterval(() => Object.keys(limits).forEach(loadBars), 3600e3);
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => { /* 不支援或被拒就算了 */ });
    },
  };
})();
