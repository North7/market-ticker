// 五個設計方案共用的即時資料：Binance BTC + 本機 /api/markets
(function () {
  const REST = 'https://api.binance.com/api/v3/klines';
  const WS = 'wss://stream.binance.com:9443/stream?streams=';
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

  function onTrade(d) {
    const p = +d.p;
    S.prev = S.price; S.price = p;
    if (S.prev != null && p !== S.prev) S.dir = p > S.prev ? 1 : -1;
    for (const tf in S.bars) {
      const a = S.bars[tf], last = a[a.length - 1];
      if (!last) continue;
      const sec = TF_SEC[tf];
      if (d.T / 1000 >= last.t + sec) upsert(tf, { t: Math.floor(d.T / 1000 / sec) * sec, o: p, h: p, l: p, c: p, v: 0 });
      else { last.c = p; if (p > last.h) last.h = p; if (p < last.l) last.l = p; }
    }
    // 最近 3 分鐘逐筆（示波器、買賣力道用）
    S.ticks.push({ T: d.T, p, q: +d.q, m: d.m });
    if (S.ticks[0].T < d.T - 180000) { let k = 0; while (k < S.ticks.length && S.ticks[k].T < d.T - 180000) k++; S.ticks.splice(0, k); }
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
    } catch { /* 沒補到就從現在開始累積 */ }
  }

  let ws, retry = 0, lastMsg = 0;
  function connect() {
    const streams = ['btcusdt@aggTrade', 'btcusdt@ticker', ...Object.keys(S.limit).map((tf) => `btcusdt@kline_${tf}`)];
    ws = new WebSocket(WS + streams.join('/'));
    ws.onopen = () => { retry = 0; lastMsg = Date.now(); emit('status', true); };
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      const { stream, data } = JSON.parse(ev.data);
      if (stream.endsWith('@aggTrade')) onTrade(data);
      else if (stream.endsWith('@ticker')) { S.ticker = { c: +data.c, o: +data.o, h: +data.h, l: +data.l, p: +data.p, P: +data.P, q: +data.q, v: +data.v }; emit('ticker'); }
      else if (data.k) { const k = data.k; upsert(k.i, { t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }); }
    };
    ws.onclose = () => { emit('status', false); setTimeout(() => { Object.keys(S.limit).forEach(loadBars); connect(); }, Math.min(30000, 1000 * 2 ** retry++)); };
    ws.onerror = () => ws.close();
  }
  setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsg > 15000) ws.close(); }, 5000);

  async function pollMarkets() {
    try {
      const r = await fetch('/api/markets', { cache: 'no-store' });
      const d = await r.json();
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
    } catch { /* 下一輪再試 */ }
  }

  const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '--' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtBig = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : fmt(v, 0);
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  const pct = (v) => `${sgn(v)}${Math.abs(v).toFixed(2)}%`;

  function tzNow(tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { wd: p.weekday, hh: p.hour, mm: p.minute, ss: p.second, str: `${p.hour}:${p.minute}:${p.second}` };
  }

  window.Feed = {
    S, fmt, fmtBig, sgn, pct, tzNow,
    on(e, f) { (L[e] || (L[e] = [])).push(f); },
    start(limits = { '1m': 240, '4h': 180 }) {
      S.limit = limits;
      Object.keys(limits).forEach(loadBars);
      seedTicks();
      connect();
      pollMarkets();
      setInterval(pollMarkets, 5000);
      setInterval(() => Object.keys(limits).forEach(loadBars), 3600e3);
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => { /* 不支援或被拒就算了 */ });
    },
  };
})();
