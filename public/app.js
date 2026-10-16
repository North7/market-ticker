'use strict';

const LC = window.LightweightCharts;
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('mt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mt.' + k, JSON.stringify(v)); } catch { /* 無痕模式等 */ } },
};

// 圖表一律顯示本地時間（lightweight-charts 預設用 UTC）
const TZ = -new Date().getTimezoneOffset() * 60;
const REST = 'https://api.binance.com/api/v3/klines';
const WS = 'wss://stream.binance.com:9443/stream?streams=';
const SYM = 'btcusdt';
const MAIN_TFS = ['1s', '1m', '5m', '15m'];
const HI_TFS = ['4h', '1d', '1w'];
const TF_SEC = { '1s': 1, '1m': 60, '5m': 300, '15m': 900, '4h': 14400, '1d': 86400, '1w': 604800 };
const WHALE_USD = 250000;

// 紅漲綠跌（台股習慣）／綠漲紅跌，按 C 切換
const colorMode = store.get('colorMode', 'tw');
const COL = colorMode === 'tw' ? { up: '#ff3d5e', down: '#00e39a' } : { up: '#00e39a', down: '#ff3d5e' };
document.documentElement.style.setProperty('--up', COL.up);
document.documentElement.style.setProperty('--down', COL.down);

const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '--'
  : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBig = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : fmt(v);
const sgn = (v) => (v > 0 ? '+' : '');
const dirClass = (v) => (v > 0 ? 'is-up' : v < 0 ? 'is-down' : '');
const setDir = (el, v) => { el.classList.remove('is-up', 'is-down'); const c = dirClass(v); if (c) el.classList.add(c); };

function chartOptions(extra = {}) {
  return {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#6d8aa8', fontFamily: 'JetBrains Mono', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(0,229,255,0.045)' }, horzLines: { color: 'rgba(0,229,255,0.06)' } },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: { color: 'rgba(0,229,255,.45)', labelBackgroundColor: '#0b3247', style: LC.LineStyle.Dashed },
      horzLine: { color: 'rgba(0,229,255,.45)', labelBackgroundColor: '#0b3247', style: LC.LineStyle.Dashed },
    },
    rightPriceScale: { borderColor: 'rgba(0,229,255,.14)' },
    timeScale: { borderColor: 'rgba(0,229,255,.14)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    ...extra,
  };
}

const candleStyle = {
  upColor: COL.up, downColor: COL.down, borderUpColor: COL.up, borderDownColor: COL.down,
  wickUpColor: COL.up, wickDownColor: COL.down,
};
const emaStep = (prev, c, n) => (prev == null ? c : c * (2 / (n + 1)) + prev * (1 - 2 / (n + 1)));

// ---------------------------------------------------------------- BTC K 線
class BtcView {
  constructor(key, tfs, def, visible) {
    this.key = key; this.tfs = tfs; this.visible = visible;
    this.tf = tfs.includes(store.get('tf.' + key)) ? store.get('tf.' + key) : def;
    this.el = $('chart-' + key);
    this.pulse = $('pulse-' + key);
    this.ohlc = $(key + '-ohlc');
    this.chart = LC.createChart(this.el, chartOptions());
    this.candles = this.chart.addCandlestickSeries({ ...candleStyle, priceLineColor: '#00e5ff', priceLineStyle: LC.LineStyle.Dotted });
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
    this.vol = this.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const line = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    this.emaF = this.chart.addLineSeries({ ...line, color: 'rgba(0,229,255,.85)' });
    this.emaS = this.chart.addLineSeries({ ...line, color: 'rgba(176,97,255,.85)' });
    this.bars = []; this.ef = []; this.es = [];
    this.seq = 0; this.loading = true; this.dirty = false; this.pulseDirty = false;
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => { this.pulseDirty = true; });
    this.buildTabs();
  }

  buildTabs() {
    const box = $('tabs-' + this.key);
    box.innerHTML = '';
    for (const tf of this.tfs) {
      const b = document.createElement('button');
      b.textContent = tf.toUpperCase();
      b.className = tf === this.tf ? 'on' : '';
      b.onclick = () => this.setTf(tf);
      box.appendChild(b);
    }
    $(this.key + '-tf-label').textContent = this.tf.toUpperCase();
  }

  setTf(tf) {
    if (tf === this.tf) return;
    this.tf = tf; store.set('tf.' + this.key, tf);
    this.buildTabs();
    this.load();
  }

  async load() {
    const seq = ++this.seq;
    this.loading = true;
    try {
      const r = await fetch(`${REST}?symbol=BTCUSDT&interval=${this.tf}&limit=1000`);
      const rows = await r.json();
      if (seq !== this.seq) return;
      this.bars = rows.map((k) => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      this.ef = []; this.es = [];
      this.bars.forEach((b, i) => { this.ef[i] = emaStep(this.ef[i - 1], b.c, 7); this.es[i] = emaStep(this.es[i - 1], b.c, 25); });
      this.candles.setData(this.bars.map((b) => this.toCandle(b)));
      this.vol.setData(this.bars.map((b) => this.toVol(b)));
      this.emaF.setData(this.bars.map((b, i) => ({ time: b.t + TZ, value: this.ef[i] })));
      this.emaS.setData(this.bars.map((b, i) => ({ time: b.t + TZ, value: this.es[i] })));
      this.chart.timeScale().applyOptions({ secondsVisible: this.tf === '1s' });
      const n = this.bars.length;
      this.chart.timeScale().setVisibleLogicalRange({ from: n - this.visible, to: n + 5 });
      this.loading = false;
      this.dirty = true; this.pulseDirty = true;
    } catch (e) {
      console.warn('K 線載入失敗', this.tf, e);
      if (seq === this.seq) setTimeout(() => seq === this.seq && this.load(), 5000);
    }
  }

  toCandle(b) { return { time: b.t + TZ, open: b.o, high: b.h, low: b.l, close: b.c }; }
  toVol(b) { return { time: b.t + TZ, value: b.v, color: b.c >= b.o ? hexA(COL.up, 0.35) : hexA(COL.down, 0.35) }; }

  onKline(k) {
    if (this.loading || k.i !== this.tf) return;
    this.upsert({ t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
  }

  // 逐筆成交直接推動最後一根 K 棒，比 kline 推播更即時
  onTrade(p, tMs) {
    if (this.loading) return;
    const last = this.bars[this.bars.length - 1];
    if (!last) return;
    const sec = TF_SEC[this.tf];
    if (tMs / 1000 >= last.t + sec) {
      if (this.tf === '1w') return; // 週 K 起點是週一，交給 kline 推播開新棒
      const t = Math.floor(tMs / 1000 / sec) * sec;
      this.upsert({ t, o: p, h: p, l: p, c: p, v: 0 });
      return;
    }
    last.c = p;
    if (p > last.h) last.h = p;
    if (p < last.l) last.l = p;
    this.dirty = true;
  }

  upsert(bar) {
    const n = this.bars.length;
    const last = this.bars[n - 1];
    if (!last || bar.t > last.t) {
      if (this.dirty) this.flush();
      this.bars.push(bar);
    } else if (bar.t === last.t) {
      Object.assign(last, bar);
    } else return;
    this.dirty = true;
  }

  flush() {
    if (this.dirty && !this.loading && this.bars.length) {
      this.dirty = false;
      const i = this.bars.length - 1;
      const b = this.bars[i];
      this.ef[i] = emaStep(this.ef[i - 1], b.c, 7);
      this.es[i] = emaStep(this.es[i - 1], b.c, 25);
      this.candles.update(this.toCandle(b));
      this.vol.update(this.toVol(b));
      this.emaF.update({ time: b.t + TZ, value: this.ef[i] });
      this.emaS.update({ time: b.t + TZ, value: this.es[i] });
      const chg = b.o ? (b.c - b.o) / b.o * 100 : 0;
      const amp = b.o ? (b.h - b.l) / b.o * 100 : 0;
      this.ohlc.innerHTML =
        `<span>O <b>${fmt(b.o)}</b></span><span>H <b>${fmt(b.h)}</b></span><span>L <b>${fmt(b.l)}</b></span>` +
        `<span>C <b class="${dirClass(b.c - b.o)}">${fmt(b.c)}</b></span>` +
        `<span>漲跌 <b class="${dirClass(chg)}">${sgn(chg)}${chg.toFixed(2)}%</b></span><span>振幅 <b>${amp.toFixed(2)}%</b></span>` +
        `<span class="ema-f">━ EMA7</span><span class="ema-s">━ EMA25</span>`;
      this.pulseDirty = true;
    }
    if (this.pulseDirty) {
      this.pulseDirty = false;
      const b = this.bars[this.bars.length - 1];
      const x = b && this.chart.timeScale().timeToCoordinate(b.t + TZ);
      const y = b && this.candles.priceToCoordinate(b.c);
      if (x == null || y == null) { this.pulse.style.display = 'none'; return; }
      this.pulse.style.display = 'block';
      this.pulse.style.transform = `translate(${x}px, ${y}px)`;
    }
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

const views = [new BtcView('main', MAIN_TFS, '1m', 160), new BtcView('hi', HI_TFS, '4h', 120)];

// ---------------------------------------------------------------- 大字報價 + 成交流
let lastPrice = null, shownPrice = '', pendingTrade = null, tapeBest = null;
const priceEl = $('btc-price'), arrowEl = $('btc-arrow'), tapeEl = $('tape');

function drawPrice() {
  if (lastPrice == null) return;
  const s = fmt(lastPrice);
  if (s === shownPrice) return;
  const prevNum = parseFloat(shownPrice.replace(/,/g, ''));
  const dir = isNaN(prevNum) ? '' : lastPrice > prevNum ? 'u' : lastPrice < prevNum ? 'd' : '';
  if (s.length !== shownPrice.length) {
    priceEl.innerHTML = [...s].map((ch) => `<span>${ch}</span>`).join('');
  } else {
    const spans = priceEl.children;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== shownPrice[i]) {
        const sp = document.createElement('span');
        sp.textContent = s[i];
        if (dir) sp.className = dir;
        priceEl.replaceChild(sp, spans[i]);
      }
    }
  }
  if (dir) arrowEl.className = 'tick-arrow ' + dir;
  shownPrice = s;
  document.title = `${s} · BTC`;
}

function pushTape() {
  if (!tapeBest) return;
  const tr = tapeBest; tapeBest = null;
  const row = document.createElement('div');
  const usd = tr.p * tr.q;
  if (usd >= WHALE_USD) row.className = 'whale';
  const t = new Date(tr.T).toLocaleTimeString('en-GB', { hour12: false });
  row.innerHTML = `<span class="t">${t}</span><span class="${tr.m ? 'is-down' : 'is-up'}">${fmt(tr.p)}</span><span class="q">${tr.q.toFixed(4)}</span>`;
  tapeEl.prepend(row);
  while (tapeEl.children.length > 7) tapeEl.lastChild.remove();
}
setInterval(pushTape, 220);

function onTrade(d) {
  const p = +d.p, q = +d.q;
  lastPrice = p;
  for (const v of views) v.onTrade(p, d.T);
  // 每格只顯示這段時間內最大的一筆，大單會被凸顯
  if (!tapeBest || q > tapeBest.q) tapeBest = { p, q, T: d.T, m: d.m };
  const lat = Date.now() - d.E;
  if (lat > -5000 && lat < 60000) $('latency').textContent = `${Math.max(0, lat)} ms`;
}

function onTicker(d) {
  const c = +d.c, o = +d.o, h = +d.h, l = +d.l, p = +d.p, P = +d.P;
  if (lastPrice == null) lastPrice = c;
  const chgp = $('btc-chgp'), chg = $('btc-chg');
  chgp.textContent = `${sgn(P)}${P.toFixed(2)}%`;
  chg.textContent = `${sgn(p)}${fmt(p)}`;
  setDir(chgp, P);
  $('btc-h').textContent = fmt(h);
  $('btc-l').textContent = fmt(l);
  $('btc-amp').textContent = o ? ((h - l) / o * 100).toFixed(2) + '%' : '--';
  $('btc-qv').textContent = '$' + fmtBig(+d.q);
}

// ---------------------------------------------------------------- WebSocket（自動重連）
let ws = null, wsRetry = 0, lastMsg = 0, everOpen = false;
function setLed(id, st) { $('led-' + id).className = 'led ' + st; }

function connect() {
  const streams = [`${SYM}@aggTrade`, `${SYM}@ticker`, ...[...MAIN_TFS, ...HI_TFS].map((tf) => `${SYM}@kline_${tf}`)];
  ws = new WebSocket(WS + streams.join('/'));
  ws.onopen = () => {
    setLed('ws', 'ok'); wsRetry = 0; lastMsg = Date.now();
    if (everOpen) views.forEach((v) => v.load()); // 斷線期間的缺口重新補齊
    everOpen = true;
  };
  ws.onmessage = (ev) => {
    lastMsg = Date.now();
    const { stream, data } = JSON.parse(ev.data);
    if (stream.endsWith('@aggTrade')) onTrade(data);
    else if (stream.endsWith('@ticker')) onTicker(data);
    else if (data.k) views.forEach((v) => v.onKline(data.k));
  };
  ws.onclose = () => {
    setLed('ws', 'err');
    setTimeout(connect, Math.min(30000, 1000 * 2 ** wsRetry++));
  };
  ws.onerror = () => ws.close();
}
// 超過 15 秒沒訊息就當作斷線
setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsg > 15000) ws.close(); }, 5000);
// 每小時整批重載，避免資料無限累積
setInterval(() => views.forEach((v) => v.load()), 3600e3);

function frame() {
  for (const v of views) v.flush();
  drawPrice();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 台股 / 美股卡片
const SESSIONS = {
  TW: { tz: 'Asia/Taipei', open: 9 * 3600, close: 13.5 * 3600, bars: 54 },
  US: { tz: 'America/New_York', open: 9.5 * 3600, close: 16 * 3600, bars: 78 },
};
const cards = {};
const marketOpen = { TW: false, US: false };

function decimals(s) {
  if (s.id === 'TAIEX' || s.market === 'US') return 2;
  return s.price >= 1000 ? 0 : 2;
}

function buildCard(s) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="c-top">
      <div class="c-name"><b>${s.name}</b><span>${s.code}</span><small class="c-time"></small></div>
      <div class="c-price">--</div>
    </div>
    <div class="c-mid">
      <div class="c-chart"></div>
      <div class="c-chg"><b>--</b><span>--</span></div>
    </div>
    <div class="c-range">
      <span class="lo">L --</span>
      <div class="rb"><i class="band"></i><i class="seg"></i><i class="prev"></i><i class="cur"></i></div>
      <span class="hi">H --</span>
      <span class="amp"><em>振幅</em>--</span>
    </div>`;
  $('cards-' + s.market).appendChild(el);
  const chart = LC.createChart(el.querySelector('.c-chart'), chartOptions({
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#6d8aa8', attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
    timeScale: { visible: false, rightOffset: 0 },
    crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
    handleScroll: false, handleScale: false,
  }));
  const series = chart.addCandlestickSeries({ ...candleStyle, priceLineVisible: false, lastValueVisible: false });
  series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  const q = (sel) => el.querySelector(sel);
  return {
    el, chart, series, prevLine: null, last: null,
    price: q('.c-price'), time: q('.c-time'), chgP: q('.c-chg b'), chgA: q('.c-chg span'),
    lo: q('.lo'), hi: q('.hi'), amp: q('.amp'),
    band: q('.band'), seg: q('.seg'), prev: q('.prev'), cur: q('.cur'),
  };
}

function updateCard(s) {
  const c = cards[s.id] || (cards[s.id] = buildCard(s));
  if (s.price == null) return;
  const d = decimals(s);
  const chg = s.prevClose ? s.price - s.prevClose : 0;
  const pct = s.prevClose ? chg / s.prevClose * 100 : 0;

  if (c.last != null && s.price !== c.last) {
    c.el.classList.remove('flash-u', 'flash-d');
    void c.el.offsetWidth;
    c.el.classList.add(s.price > c.last ? 'flash-u' : 'flash-d');
  }
  c.last = s.price;
  c.price.textContent = fmt(s.price, d);
  setDir(c.price, chg);
  c.chgP.textContent = `${sgn(pct)}${pct.toFixed(2)}%`;
  c.chgA.textContent = `${sgn(chg)}${fmt(chg, d)}`;
  setDir(c.chgP, pct);
  c.el.classList.toggle('up', chg > 0);
  c.el.classList.toggle('down', chg < 0);

  if (s.time) {
    const sess = SESSIONS[s.market];
    c.time.textContent = new Date(s.time).toLocaleTimeString('en-GB', { timeZone: sess.tz, hour12: false });
    c.time.classList.toggle('stale', s.isOpen && Date.now() - s.time > 120000);
  }

  // 當日區間條：灰帶＝最低到最高，色條＝昨收到現價，白線＝昨收
  const lo = Math.min(s.low ?? s.price, s.prevClose ?? s.price, s.price);
  const hi = Math.max(s.high ?? s.price, s.prevClose ?? s.price, s.price);
  const pos = (v) => (hi > lo ? (v - lo) / (hi - lo) * 100 : 50);
  const dl = s.low ?? s.price, dh = s.high ?? s.price;
  c.band.style.left = pos(dl) + '%';
  c.band.style.width = (pos(dh) - pos(dl)) + '%';
  if (s.prevClose) {
    const a = pos(Math.min(s.prevClose, s.price)), b = pos(Math.max(s.prevClose, s.price));
    c.seg.style.left = a + '%';
    c.seg.style.width = Math.max(b - a, 0.5) + '%';
    c.seg.style.background = chg >= 0 ? COL.up : COL.down;
    c.seg.style.boxShadow = `0 0 6px ${chg >= 0 ? COL.up : COL.down}`;
    c.prev.style.left = pos(s.prevClose) + '%';
  }
  c.cur.style.left = pos(s.price) + '%';
  c.lo.textContent = 'L ' + fmt(s.low, d);
  c.hi.textContent = 'H ' + fmt(s.high, d);
  const amp = s.prevClose && s.high && s.low ? (s.high - s.low) / s.prevClose * 100 : null;
  c.amp.innerHTML = `<em>振幅</em>${amp == null ? '--' : amp.toFixed(2) + '%'}`;

  // 迷你 5 分 K：補空白到收盤，看得出今天走到哪
  const bars = s.bars || [];
  if (bars.length) {
    const data = bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
    const end = bars[0].t + SESSIONS[s.market].bars * 300;
    for (let t = bars[bars.length - 1].t + 300; t < end; t += 300) data.push({ time: t });
    c.series.setData(data);
    c.chart.timeScale().fitContent();
  }
  if (s.prevClose) {
    if (c.prevLine) c.series.removePriceLine(c.prevLine);
    c.prevLine = c.series.createPriceLine({ price: s.prevClose, color: 'rgba(255,255,255,.35)', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
  }
}

async function pollMarkets() {
  try {
    const r = await fetch('/api/markets', { cache: 'no-store' });
    const d = await r.json();
    for (const s of d.symbols) updateCard(s);
    marketOpen.TW = d.symbols.some((s) => s.market === 'TW' && s.isOpen);
    marketOpen.US = d.symbols.some((s) => s.market === 'US' && s.isOpen);
    setLed('api', d.symbols.every((s) => s.price != null) ? 'ok' : 'err');
  } catch {
    setLed('api', 'err');
  }
}

// ---------------------------------------------------------------- 時鐘與交易時段
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function tzNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { wd: WD[parts.weekday], sec: +parts.hour * 3600 + +parts.minute * 60 + +parts.second, str: `${parts.hour}:${parts.minute}:${parts.second}` };
}
const hms = (s) => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function dhm(s) { const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60; return d ? `${d}天 ${h}時` : `${h}時 ${String(m).padStart(2, '0')}分`; }

function tick() {
  $('clk-tpe').textContent = tzNow('Asia/Taipei').str;
  $('clk-nyc').textContent = tzNow('America/New_York').str;
  $('clk-utc').textContent = tzNow('UTC').str;
  for (const [m, sess] of Object.entries(SESSIONS)) {
    const n = tzNow(sess.tz);
    const badge = $('badge-' + m);
    const weekday = n.wd >= 1 && n.wd <= 5;
    if (marketOpen[m] && weekday && n.sec >= sess.open && n.sec < sess.close) {
      badge.className = 'badge open';
      badge.textContent = `交易中 · 收盤倒數 ${hms(sess.close - n.sec)}`;
      continue;
    }
    let wait;
    if (weekday && n.sec < sess.open) wait = sess.open - n.sec;
    else {
      let days = 1;
      while (((n.wd + days) % 7) === 0 || ((n.wd + days) % 7) === 6) days++;
      wait = 86400 - n.sec + (days - 1) * 86400 + sess.open;
    }
    badge.className = 'badge closed';
    badge.textContent = `休市 · 距開盤 ${dhm(wait)}`;
  }
}

// ---------------------------------------------------------------- 背景粒子
function startBackground() {
  const cv = $('bg'), ctx = cv.getContext('2d');
  let W, H, pts = [], last = 0;
  const resize = () => {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    pts = Array.from({ length: Math.round(W * H / 26000) }, () => ({
      x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
    }));
  };
  resize(); addEventListener('resize', resize);
  const draw = (t) => {
    requestAnimationFrame(draw);
    if (document.body.classList.contains('no-bg') || t - last < 50) return; // 約 20fps，省電
    last = t;
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d2 = dx * dx + dy * dy;
        if (d2 < 16000) {
          ctx.strokeStyle = `rgba(0,229,255,${0.16 * (1 - d2 / 16000)})`;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(0,229,255,.55)';
      ctx.fillRect(pts[i].x - 1, pts[i].y - 1, 2, 2);
    }
  };
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- 開機畫面
function boot() {
  const lines = [
    ['> INIT MARKET//TICKER v1.0', ''],
    ['> LINK BINANCE STREAM .......... ', 'OK'],
    ['> LINK TWSE MIS FEED ........... ', 'OK'],
    ['> LINK NYSE/NASDAQ FEED ........ ', 'OK'],
    ['> CALIBRATING CHARTS ........... ', 'OK'],
    ['> SYSTEM ONLINE', ''],
  ];
  const box = $('boot-lines');
  lines.forEach(([a, b], i) => {
    const d = document.createElement('div');
    d.style.animationDelay = i * 160 + 'ms';
    d.innerHTML = `${a}<b>${b}</b>`;
    box.appendChild(d);
  });
  setTimeout(() => {
    $('boot').classList.add('done');
    document.body.classList.replace('booting', 'ready');
    setTimeout(() => $('boot').remove(), 800);
  }, lines.length * 160 + 500);
}

// ---------------------------------------------------------------- 長時間顯示：防休眠、防烙印、快捷鍵
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch { /* 不支援就算了，caffeinate 會處理 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

// 每 3 分鐘整個畫面微移幾個像素
setInterval(() => {
  const r = () => Math.round((Math.random() - 0.5) * 6);
  $('app').style.transform = `translate(${r()}px, ${r()}px)`;
}, 180000);

if (store.get('noBg', false)) document.body.classList.add('no-bg');
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  if (k === 'c') { store.set('colorMode', colorMode === 'tw' ? 'intl' : 'tw'); location.reload(); }
  if (k === 'b') store.set('noBg', document.body.classList.toggle('no-bg'));
});
addEventListener('dblclick', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); });

// ---------------------------------------------------------------- 啟動
boot();
startBackground();
views.forEach((v) => v.load());
connect();
pollMarkets();
setInterval(pollMarkets, 5000);
tick();
setInterval(tick, 1000);
keepAwake();
requestAnimationFrame(frame);
