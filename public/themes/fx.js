// 共用交互層：查數據（十字線＋提示框、指標詳情）、即時事件動效（大單漣漪、24H 新高低、爆倉）、視差與按壓回饋
// 各主題用 FX.theme() 給顏色，再把自己的圖表、卡片、價格元素接上來
(function () {
  const { S, fmt } = Feed;
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hoverable = matchMedia('(hover: hover)').matches;
  let lastTouch = 0;
  addEventListener('touchstart', () => { lastTouch = Date.now(); }, { capture: true, passive: true });
  const fromTouch = () => Date.now() - lastTouch < 900;   // 觸控後瀏覽器補送的滑鼠事件不算

  // ---------------------------------------------------------------- 樣式
  const style = document.createElement('style');
  style.textContent = `
:root { --fx-bg: rgba(14,14,16,.92); --fx-fg: #f4f4f5; --fx-mute: #a1a1aa; --fx-line: rgba(255,255,255,.55); --fx-accent: #f7931a; --fx-up: #f7931a; --fx-down: #8b8b94;
  --fx-radius: 12px; --fx-font: inherit; --fx-shadow: 0 12px 40px rgba(0,0,0,.35); --fx-sheet: #141416; --fx-border: rgba(255,255,255,.08); }
.fx-zone { touch-action: pan-y; }
.fx-ov { position: fixed; pointer-events: none; z-index: 40; display: none; }
.fx-tip { position: fixed; z-index: 41; pointer-events: none; opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s;
  background: var(--fx-bg); color: var(--fx-fg); border-radius: var(--fx-radius); padding: 8px 11px; font: 500 12px/1.45 var(--fx-font); box-shadow: var(--fx-shadow);
  font-variant-numeric: tabular-nums; white-space: nowrap; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.fx-tip.on { opacity: 1; transform: none; }
.fx-tip b { display: block; font-weight: 600; margin-bottom: 3px; }
.fx-tip .fx-r { display: flex; justify-content: space-between; gap: 14px; } .fx-tip .fx-r span { color: var(--fx-mute); }
.fx-tip .fx-up { color: var(--fx-up); } .fx-tip .fx-down { color: var(--fx-down); }
[data-fx] { cursor: pointer; transition: transform .22s cubic-bezier(.2,.8,.2,1), filter .2s; -webkit-tap-highlight-color: transparent; }
[data-fx]:active { transform: scale(.965); }
@media (hover: hover) { [data-fx]:hover { filter: brightness(1.06); } }
.fx-back { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.38); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); opacity: 0; transition: opacity .25s;
  display: flex; align-items: center; justify-content: center; padding: 16px; }
.fx-back.on { opacity: 1; }
.fx-sheet { width: min(560px, 100%); max-height: calc(100% - 24px); overflow: auto; background: var(--fx-sheet); color: var(--fx-fg); border-radius: calc(var(--fx-radius) + 8px);
  box-shadow: 0 30px 80px rgba(0,0,0,.45), inset 0 0 0 1px var(--fx-border); padding: 20px 22px 18px; font-family: var(--fx-font); transform: translateY(16px) scale(.98); transition: transform .3s cubic-bezier(.2,.8,.2,1); }
.fx-back.on .fx-sheet { transform: none; }
.fx-sheet .fx-hd { display: flex; align-items: baseline; gap: 10px; }
.fx-sheet .fx-hd h2 { margin: 0; font-size: 19px; font-weight: 700; }
.fx-sheet .fx-hd small { color: var(--fx-mute); font-size: 12px; }
.fx-sheet .fx-x { all: unset; cursor: pointer; margin-left: auto; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: var(--fx-mute); font-size: 18px; }
.fx-sheet .fx-x:hover { background: var(--fx-border); color: var(--fx-fg); }
.fx-sheet .fx-v { font-size: 40px; font-weight: 700; letter-spacing: -.03em; margin-top: 8px; font-variant-numeric: tabular-nums; }
.fx-sheet .fx-c { font-size: 14px; font-weight: 600; margin-top: 2px; } .fx-sheet .fx-up { color: var(--fx-up); } .fx-sheet .fx-down { color: var(--fx-down); }
.fx-sheet .fx-sub { color: var(--fx-mute); font-size: 12.5px; margin-top: 4px; }
.fx-sheet .fx-chart { position: relative; height: 210px; margin: 14px -6px 4px; }
.fx-sheet .fx-chart canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.fx-sheet .fx-cap { font-size: 11px; color: var(--fx-mute); display: flex; justify-content: space-between; }
.fx-sheet .fx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-top: 12px; }
.fx-sheet .fx-grid div { background: var(--fx-border); border-radius: 10px; padding: 8px 10px; font-size: 11.5px; color: var(--fx-mute); }
.fx-sheet .fx-grid b { display: block; color: var(--fx-fg); font-size: 14px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.fx-sheet .fx-p { font-size: 13px; line-height: 1.65; color: var(--fx-mute); margin: 14px 0 0; }
@media (max-width: 640px) { .fx-back { align-items: flex-end; padding: 0; } .fx-sheet { border-radius: 22px 22px 0 0; max-height: 86%; padding-bottom: calc(18px + env(safe-area-inset-bottom)); } .fx-sheet .fx-v { font-size: 34px; } }
.fx-fxc { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 30; }
.fx-pill { position: fixed; z-index: 31; pointer-events: none; padding: 6px 12px; border-radius: 999px; font: 600 12.5px/1 var(--fx-font); color: #fff; white-space: nowrap;
  box-shadow: 0 8px 30px rgba(0,0,0,.25); opacity: 0; transform: translateY(6px); transition: opacity .25s, transform .25s; }
.fx-pill.on { opacity: 1; transform: none; }
.fx-hi { animation: fxGlow 1.6s ease-out; } .fx-lo { animation: fxGlowLo 1.6s ease-out; }
@keyframes fxGlow { 0%, 30% { filter: drop-shadow(0 0 18px var(--fx-up)) brightness(1.15); } 100% { filter: none; } }
@keyframes fxGlowLo { 0%, 30% { filter: drop-shadow(0 0 18px var(--fx-down)) brightness(1.15); } 100% { filter: none; } }
.fx-shake { animation: fxShake .5s cubic-bezier(.36,.07,.19,.97); }
@keyframes fxShake { 10%, 90% { translate: -1px 0; } 20%, 80% { translate: 3px 0; } 30%, 50%, 70% { translate: -5px 0; } 40%, 60% { translate: 5px 0; } }
@media (prefers-reduced-motion: reduce) { .fx-hi, .fx-lo, .fx-shake { animation: none; } }
`;
  document.head.appendChild(style);

  const FX = {};
  FX.theme = (vars) => { for (const k in vars) root.style.setProperty('--fx-' + k, vars[k]); };
  const cssv = (k) => getComputedStyle(root).getPropertyValue('--fx-' + k).trim();
  // 任何 CSS 顏色加透明度（hex 或 rgb 都行）
  const alpha = (c, a) => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; const h = x.fillStyle; if (h[0] === '#') { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; } return h.replace(/rgba?\(([^)]+?)(,\s*[\d.]+)?\)/, `rgba($1,${a})`); };

  // ---------------------------------------------------------------- 格式
  const pad2 = (n) => String(n).padStart(2, '0');
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  FX.time = (t, tf = '1m') => {
    const d = new Date(t * 1000), hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, md = `${d.getMonth() + 1}/${d.getDate()}`;
    if (tf === '1d') return `${md}（${WD[d.getDay()]}）`;
    if (tf === '4h' || tf === '1h') return `${md} ${hm}`;
    return hm;
  };
  const pctTxt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
  FX.pct = pctTxt;

  // ---------------------------------------------------------------- 視差：滑鼠位置（-1..1，平滑），只在有滑鼠的裝置
  FX.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  if (hoverable && !reduce) {
    addEventListener('mousemove', (e) => {
      if (fromTouch()) return;
      FX.pointer.tx = e.clientX / innerWidth * 2 - 1; FX.pointer.ty = e.clientY / innerHeight * 2 - 1;
    });
    document.addEventListener('mouseleave', () => { FX.pointer.tx = 0; FX.pointer.ty = 0; });
    const tick = () => {
      const p = FX.pointer, dx = p.tx - p.x, dy = p.ty - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.0005) {
        p.x += dx * 0.08; p.y += dy * 0.08;
        root.style.setProperty('--fx-px', p.x.toFixed(4)); root.style.setProperty('--fx-py', p.y.toFixed(4));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  // 卡片聚光：游標位置寫進元素自己的 --mx / --my（px）
  FX.spotlight = (sel) => {
    if (!hoverable) return;
    document.addEventListener('mousemove', (e) => {
      const el = e.target.closest && e.target.closest(sel); if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px'); el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  };

  // ---------------------------------------------------------------- 查數據：十字線＋提示框
  // hit(x, y, w, h) → null 或 { x, y, vline, hline, dot, color, title, rows: [[標籤, 值, 'up'|'down']] }
  // o.onEnd：放開／移出時呼叫；o.linger：觸控放開後提示停留毫秒數；hit 回傳 tip:false 時不顯示提示框（主題自己畫）
  FX.inspect = (el, hit, o = {}) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return;
    el.classList.add('fx-zone');
    const ov = document.createElement('canvas'); ov.className = 'fx-ov'; document.body.appendChild(ov);
    const tip = document.createElement('div'); tip.className = 'fx-tip'; document.body.appendChild(tip);
    let active = false, px = 0, py = 0, raf = 0, hideT, lastHtml = '';
    function render() {
      raf = 0;
      if (!active) return;
      const r = el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const h = r.width && r.height ? hit(px, py, r.width, r.height) : null;
      Object.assign(ov.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      if (ov.width !== Math.round(r.width * dpr) || ov.height !== Math.round(r.height * dpr)) { ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr); }
      const ctx = ov.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
      if (!h) { tip.classList.remove('on'); raf = requestAnimationFrame(render); return; }
      const line = h.color || cssv('line');
      ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      if (h.vline !== false) { ctx.beginPath(); ctx.moveTo(Math.round(h.x) + 0.5, 0); ctx.lineTo(Math.round(h.x) + 0.5, r.height); ctx.stroke(); }
      if (h.hline) { ctx.beginPath(); ctx.moveTo(0, Math.round(h.y) + 0.5); ctx.lineTo(r.width, Math.round(h.y) + 0.5); ctx.stroke(); }
      ctx.setLineDash([]);
      if (h.dot !== false) {
        ctx.fillStyle = h.dotColor || cssv('accent'); ctx.strokeStyle = cssv('bg') || '#000'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(h.x, h.y, 4.5, 0, 7); ctx.fill(); ctx.stroke();
      }
      const html = `<b>${h.title || ''}</b>` + (h.rows || []).map(([k, v, c]) => `<div class="fx-r"><span>${k}</span><em class="${c ? 'fx-' + c : ''}" style="font-style:normal">${v}</em></div>`).join('');
      if (html !== lastHtml) { tip.innerHTML = html; lastHtml = html; }
      if (h.tip === false) { tip.classList.remove('on'); raf = requestAnimationFrame(render); return; }
      tip.classList.add('on');
      const tw = tip.offsetWidth, th = tip.offsetHeight, ax = r.left + h.x, ay = r.top + h.y;
      let lx = ax + 14; if (lx + tw > innerWidth - 8) lx = ax - tw - 14; lx = Math.max(8, lx);
      let ly = ay - th - 12; if (ly < 8) ly = ay + 14; ly = Math.min(ly, innerHeight - th - 8);
      tip.style.left = lx + 'px'; tip.style.top = ly + 'px';
      raf = requestAnimationFrame(render);   // 按住時資料仍持續更新
    }
    const at = (cx, cy) => { const r = el.getBoundingClientRect(); px = cx - r.left; py = cy - r.top; active = true; clearTimeout(hideT); if (!raf) raf = requestAnimationFrame(render); };
    const stop = (ms) => { clearTimeout(hideT); hideT = setTimeout(() => { active = false; ov.style.display = 'none'; tip.classList.remove('on'); if (o.onEnd) o.onEnd(); }, ms); };
    el.addEventListener('mousemove', (e) => { if (!fromTouch()) at(e.clientX, e.clientY); });
    el.addEventListener('mouseleave', () => { if (!fromTouch()) stop(0); });
    // 觸控：點一下是叫選單、快速一揮是換主題，所以要按住 0.3 秒或慢慢拖才開始查數據
    let holdT, t0 = 0, sx = 0, sy = 0, lx = 0, ly = 0, armed = false;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; t0 = Date.now(); sx = lx = t.clientX; sy = ly = t.clientY; armed = false;
      clearTimeout(holdT); holdT = setTimeout(() => { armed = true; at(lx, ly); }, 300);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; lx = t.clientX; ly = t.clientY;
      if (!armed && Math.hypot(lx - sx, ly - sy) > 8 && Date.now() - t0 > 180) { armed = true; clearTimeout(holdT); }
      if (armed) at(lx, ly);
    }, { passive: true });
    el.addEventListener('touchend', () => { clearTimeout(holdT); if (armed) stop(o.linger ?? 2200); armed = false; }, { passive: true });
    addEventListener('scroll', () => stop(0), { passive: true });
    return () => { active = false; clearTimeout(hideT); ov.remove(); tip.remove(); };
  };

  // K 線／折線（Draw.candles 回傳的幾何）專用的 hit：getGeo() 給最新一次繪圖結果，getBars() 給資料
  FX.candleHit = (getGeo, getBars, o = {}) => (x) => {
    const g = getGeo(), bars = getBars();
    if (!g || !bars || !bars.length) return null;
    const data = bars.slice(-g.n);
    const i = Math.max(0, Math.min(data.length - 1, Math.round((x - g.X(0)) / g.cw)));
    const b = data[i];
    return { x: g.X(i), y: g.Y(b.c), title: FX.time(b.t, o.tf), rows: FX.rows(b, o) };
  };
  // 一根 K 棒的提示內容：開高低收、漲跌、量；close:true 時只顯示單一數值
  FX.rows = (b, o = {}) => {
    const f = o.fmt || ((v) => fmt(v, o.dec ?? (Math.abs(v) >= 1000 ? 0 : 2)));
    const ch = b.o ? (b.c / b.o - 1) * 100 : 0, cls = ch >= 0 ? 'up' : 'down';
    if (o.close) return [[o.label || '數值', f(b.c), o.color ? o.color(b) : '']];
    const rows = [['開', f(b.o)], ['高', f(b.h)], ['低', f(b.l)], ['收', f(b.c), cls], ['漲跌', pctTxt(ch), cls]];
    if (b.v != null && o.vol !== false) rows.push(['量', (b.v >= 1000 ? (b.v / 1000).toFixed(1) + 'K' : b.v.toFixed(1)) + (o.volUnit || ' BTC')]);
    return rows;
  };

  // ---------------------------------------------------------------- 指標詳情（點卡片）
  const DESC = {
    WHALE: '單筆成交金額 ≥ 10 萬美元的大單（Binance 現貨＋永續合約）。買方主動成交算買入、賣方主動算賣出，數值是近 1 小時的淨買入金額，曲線為每 5 分鐘累計。',
    LIQ: '槓桿倉位被強制平倉的金額（Binance＋Bybit 即時推播）。多單爆倉代表下跌時被迫賣出，空單爆倉代表上漲時被迫買入。沒有免費歷史資料，從開頁開始累積。',
    TAKER: 'Binance 永續合約每 5 分鐘的主動買量 ÷ 主動賣量。大於 1 代表市價買單較多，小於 1 代表市價賣單較多，曲線為近 4 小時。',
    CBP: 'Coinbase BTC-USD 減 Binance BTCUSDT 的價差。正值常被解讀為美國現貨買盤較強，曲線為近 2 小時每分鐘的價差。',
    FNG: 'alternative.me 每日發布的加密市場情緒指數，0 為極度恐懼、100 為極度貪婪，綜合波動、成交量、社群與趨勢等因子，曲線為近 30 日。',
    TREND: '現價相對 200 日簡單移動平均的偏離百分比，正值代表在長期均線之上。RSI(14) 以 4 小時與日線收盤計算，70 以上偏熱、30 以下偏冷。曲線為近 60 日收盤。',
    TAIEX: '臺灣證券交易所發行量加權股價指數。曲線為當日 5 分 K，虛線為昨日收盤。',
    2330: '台積電（TWSE 2330）。曲線為當日 5 分 K，虛線為昨日收盤。',
    '0050': '元大台灣 50 ETF，追蹤台灣市值前 50 大公司。曲線為當日 5 分 K，虛線為昨日收盤。',
    2454: '聯發科（TWSE 2454）。曲線為當日 5 分 K，虛線為昨日收盤。',
    SPY: 'SPDR S&P 500 ETF，追蹤美國標普 500 指數。曲線為當日 5 分 K，虛線為前一交易日收盤。',
    QQQ: 'Invesco QQQ，追蹤 Nasdaq-100 指數。曲線為當日 5 分 K，虛線為前一交易日收盤。',
  };
  const TF = { WHALE: '5m', LIQ: '5m', TAKER: '5m', CBP: '1m', FNG: '1d', TREND: '1d' };
  let sheet = null;
  FX.detail = (id) => {
    if (sheet) sheet.close();
    const back = document.createElement('div'); back.className = 'fx-back';
    back.innerHTML = `<div class="fx-sheet" role="dialog"><div class="fx-hd"><h2></h2><small class="fx-code"></small><button class="fx-x" aria-label="關閉">✕</button></div>
      <div class="fx-v"></div><div class="fx-c"></div><div class="fx-sub"></div><div class="fx-chart"><canvas></canvas></div><div class="fx-cap"><span class="fx-c1"></span><span class="fx-c2"></span></div>
      <div class="fx-grid"></div><p class="fx-p"></p></div>`;
    document.body.appendChild(back);
    const q = (s) => back.querySelector(s), cv = q('canvas');
    let geo = null;
    const paint = () => {
      if (!back.isConnected) return;
      const s = S.markets.find((m) => m.id === id); if (!s) return;
      const cr = s.market === 'CR', up = (s.chg || 0) >= 0;
      q('h2').textContent = s.name; q('.fx-code').textContent = `${s.code} · ${Feed.venue(s)}`;
      q('.fx-v').textContent = Feed.val(s);
      q('.fx-c').textContent = cr ? Feed.chgTxt(s) : `${Feed.chgTxt(s)}　${s.chg >= 0 ? '+' : '−'}${fmt(Math.abs(s.chg || 0), s.dec)}`; q('.fx-c').className = 'fx-c ' + (up ? 'fx-up' : 'fx-down');
      q('.fx-sub').textContent = cr ? Feed.sub(s) : `${s.isOpen ? '交易中' : '已收盤'} · 振幅 ${(s.amp || 0).toFixed(2)}%`;
      q('.fx-p').textContent = DESC[s.id] || '';
      const bars = s.bars || [];
      geo = bars.length ? Draw.candles(cv, bars, cr
        ? { mode: 'area', pad: { t: 10, r: 10, b: 10, l: 10 }, rightGap: 0, line: cssv('accent'), lineWidth: 2, areaTop: alpha(cssv('accent'), 0.22), areaBottom: 'transparent', grid: { color: cssv('border'), rows: 3 } }
        : { mode: 'candle', pad: { t: 10, r: 10, b: 10, l: 10 }, rightGap: Math.max(0, Feed.slots(s) - bars.length), up: cssv('up'), down: cssv('down'), grid: { color: cssv('border'), rows: 3 }, lastLine: s.prevClose ? null : null }) : null;
      if (geo && !cr && s.prevClose) {   // 昨收虛線
        const ctx = cv.getContext('2d'), y = Math.round(geo.Y(s.prevClose)) + 0.5;
        if (y > 0 && y < geo.h) { ctx.save(); ctx.strokeStyle = cssv('mute'); ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(geo.w - 10, y); ctx.stroke(); ctx.restore(); }
      }
      const tf = TF[s.id] || '5m';
      q('.fx-c1').textContent = bars.length ? FX.time(bars[0].t, tf) : '';
      q('.fx-c2').textContent = bars.length ? FX.time(bars[bars.length - 1].t, tf) : '';
      const cells = cr ? [['數值', Feed.val(s)], ['變化', Feed.chgTxt(s)], ['資料源', Feed.venue(s)]]
        : [['開盤', fmt(s.open, s.dec)], ['最高', fmt(s.high, s.dec)], ['最低', fmt(s.low, s.dec)], ['昨收', fmt(s.prevClose, s.dec)]];
      q('.fx-grid').innerHTML = cells.map(([k, v]) => `<div>${k}<b>${v ?? '—'}</b></div>`).join('');
    };
    const s0 = S.markets.find((m) => m.id === id);
    const cr0 = s0 && s0.market === 'CR';
    const dispose = FX.inspect(q('.fx-chart'), FX.candleHit(() => geo, () => (S.markets.find((m) => m.id === id) || {}).bars, cr0
      ? { tf: TF[id], close: true, label: (s0 && s0.name) || '數值', fmt: (v) => (Math.abs(v) >= 1000 ? fmt(v, 0) : (+v).toFixed(Math.abs(v) < 10 ? 2 : 1)) }
      : { tf: '5m', vol: false }));
    Feed.on('markets', paint);
    const close = () => { back.classList.remove('on'); dispose(); setTimeout(() => back.remove(), 260); sheet = null; };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.fx-x')) close(); });
    addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', esc); } });
    sheet = { close };
    paint(); requestAnimationFrame(() => { back.classList.add('on'); paint(); });
    if (navigator.vibrate) navigator.vibrate(8);
  };
  // 點任何帶 data-fx 的元素（指標卡、清單列）就打開詳情
  document.addEventListener('click', (e) => { const el = e.target.closest && e.target.closest('[data-fx]'); if (el && el.dataset.fx) FX.detail(el.dataset.fx); });

  // ---------------------------------------------------------------- 即時事件動效
  // anchor：價格元素（漣漪從它的中心發出、新高低時發光、爆倉時抖動）
  FX.events = (o = {}) => {
    const anchor = () => (typeof o.anchor === 'string' ? document.querySelector(o.anchor) : o.anchor);
    const cv = document.createElement('canvas'); cv.className = 'fx-fxc'; document.body.appendChild(cv);
    const rings = []; let raf = 0, lastRing = 0;
    const center = () => {
      if (o.at) { const v = o.at(); if (v) return v; }
      const a = anchor(); if (!a) return [innerWidth / 2, innerHeight / 3];
      const r = a.getBoundingClientRect(); return [r.left + r.width * (o.ax ?? 0.5), r.top + r.height * (o.ay ?? 0.5)];
    };
    function loop() {
      raf = 0;
      const { ctx, w, h } = Draw.fit(cv), now = performance.now();
      for (let i = rings.length - 1; i >= 0; i--) {
        const g = rings[i], k = (now - g.t0) / g.dur;
        if (k >= 1) { rings.splice(i, 1); continue; }
        const e = 1 - (1 - k) ** 3;
        ctx.globalAlpha = (1 - k) * g.alpha; ctx.strokeStyle = g.color; ctx.lineWidth = g.width * (1 - k * 0.6);
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r0 + (g.r1 - g.r0) * e, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (rings.length) raf = requestAnimationFrame(loop);
    }
    const ring = (color, size, n = 1) => {
      if (reduce || document.hidden) return;
      const [x, y] = center();
      for (let k = 0; k < n; k++) rings.push({ x, y, color, r0: 20, r1: size, width: o.ringWidth || 2, alpha: o.ringAlpha || 0.7, dur: 1400 + size * 3, t0: performance.now() + k * 160 });
      if (!raf) raf = requestAnimationFrame(loop);
    };
    let pillT;
    const pill = (text, color) => {
      const a = anchor(); if (!a) return;
      let p = document.querySelector('.fx-pill'); if (!p) { p = document.createElement('div'); p.className = 'fx-pill'; document.body.appendChild(p); }
      p.textContent = text; p.style.background = color;
      const r = a.getBoundingClientRect(), [cx] = center();
      p.classList.add('on');
      const pw = p.offsetWidth;
      p.style.left = Math.max(8, Math.min(innerWidth - pw - 8, cx - pw / 2)) + 'px';
      p.style.top = Math.max(8, o.pillY ? o.pillY() : r.top - 34) + 'px';
      clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('on'), 2600);
    };
    const flash = (cls) => { const a = o.glow ? document.querySelector(o.glow) : anchor(); if (!a) return; a.classList.remove(cls); void a.offsetWidth; a.classList.add(cls); };
    const money = (v) => '$' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v / 1e3).toFixed(0) + 'K');
    Feed.on('fx', (ev) => {
      if (ev.type === 'big') {
        const t = performance.now(); if (t - lastRing < 600 && ev.usd < 1e6) return; lastRing = t;
        const size = Math.min(260, 70 + 60 * Math.log10(ev.usd / 2e5 + 1) * 2.4);
        ring(ev.side === 'buy' ? cssv('up') : cssv('down'), size, ev.usd >= 1e6 ? 2 : 1);
        if (ev.usd >= 1e6) pill(`${ev.side === 'buy' ? '大單買入' : '大單賣出'} ${money(ev.usd)}`, ev.side === 'buy' ? cssv('up') : cssv('down'));
      } else if (ev.type === 'high' || ev.type === 'low') {
        const hi = ev.type === 'high';
        flash(hi ? 'fx-hi' : 'fx-lo'); ring(hi ? cssv('up') : cssv('down'), 320, 3);
        pill(`創 24H ${hi ? '新高' : '新低'} ${fmt(ev.price, 0)}`, hi ? cssv('up') : cssv('down'));
      } else if (ev.type === 'liq') {
        const a = o.shake ? document.querySelector(o.shake) : anchor();
        if (a && !reduce) { a.classList.remove('fx-shake'); void a.offsetWidth; a.classList.add('fx-shake'); }
        pill(`${ev.side === 'long' ? '多單爆倉' : '空單爆倉'} ${money(ev.usd)}`, ev.side === 'long' ? cssv('down') : cssv('up'));
      }
    });
  };

  // ================================================================ 動效（長時間展示用：輕、連續、不閃爍；減少動態時關閉）
  const mstyle = document.createElement('style');
  mstyle.textContent = `
.fx-ch { display: inline-block; }
.fx-ch.up { animation: fxRollUp .55s cubic-bezier(.2,.8,.2,1); } .fx-ch.dn { animation: fxRollDn .55s cubic-bezier(.2,.8,.2,1); }
@keyframes fxRollUp { 0% { transform: translateY(.42em); opacity: 0; color: var(--fx-up); } 55% { color: var(--fx-up); } 100% { transform: none; opacity: 1; } }
@keyframes fxRollDn { 0% { transform: translateY(-.42em); opacity: 0; color: var(--fx-down); } 55% { color: var(--fx-down); } 100% { transform: none; opacity: 1; } }
.fx-glint { position: absolute; inset: 0; pointer-events: none; z-index: 4; border-radius: inherit; overflow: hidden; }
.fx-glint::before { content: ''; position: absolute; top: -50%; bottom: -50%; width: 38%; left: -60%; transform: rotate(18deg);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,var(--ga, .16)), transparent); animation: fxGlint var(--gp, 14s) ease-in-out infinite; animation-delay: var(--gd, 0s); }
@keyframes fxGlint { 0% { left: -60%; } 16%, 100% { left: 130%; } }
.fx-rip { position: absolute; border-radius: 50%; pointer-events: none; transform: scale(0); opacity: .35; background: currentColor; animation: fxRip .65s ease-out forwards; z-index: 5; }
@keyframes fxRip { to { transform: scale(1); opacity: 0; } }
.fx-tilt { transition: transform .35s cubic-bezier(.2,.8,.2,1); will-change: transform; }
@media (prefers-reduced-motion: reduce) { .fx-ch.up, .fx-ch.dn, .fx-glint::before, .fx-rip { animation: none !important; } }`;
  document.head.appendChild(mstyle);

  // 價格數字滾動：只有變動的位數會從上／下滾入，並短暫染成漲／跌色（保留 <small> 小數的結構）
  const rollState = new WeakMap();
  FX.price = (el, text) => {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return;
    const prev = rollState.get(el);
    if (prev && prev.text === text) return;
    const [ip, dp] = text.split('.');
    const num = (t) => parseFloat(String(t).replace(/,/g, ''));
    const dir = prev ? Math.sign(num(text) - num(prev.text)) : 0;
    const chars = [...ip], decs = dp != null ? ['.', ...dp] : [];
    if (!prev || prev.ip.length !== chars.length || prev.dec.length !== decs.length) {
      el.innerHTML = chars.map((c) => `<span class="fx-ch">${c}</span>`).join('') + (decs.length ? `<small>${decs.map((c) => `<span class="fx-ch">${c}</span>`).join('')}</small>` : '');
    } else if (!reduce && dir) {
      const spans = el.querySelectorAll('.fx-ch'), all = [...chars, ...decs], old = [...prev.ip, ...prev.dec];
      all.forEach((c, i) => { if (c !== old[i] && spans[i]) { const s = spans[i]; s.textContent = c; s.classList.remove('up', 'dn'); void s.offsetWidth; s.classList.add(dir > 0 ? 'up' : 'dn'); } });
    } else {
      const spans = el.querySelectorAll('.fx-ch'); [...chars, ...decs].forEach((c, i) => { if (spans[i]) spans[i].textContent = c; });
    }
    rollState.set(el, { text, ip: chars, dec: decs });
  };

  // 成交粒子：每筆成交從價格冒出一顆，買往上飄、賣往下沉，大小＝金額
  FX.flow = (o = {}) => {
    if (reduce) return;
    const anchor = () => (typeof o.anchor === 'string' ? document.querySelector(o.anchor) : o.anchor);
    const cv = document.createElement('canvas'); cv.className = 'fx-fxc'; cv.style.zIndex = o.z ?? 1; document.body.appendChild(cv);
    const parts = []; let raf = 0, lastT = performance.now(), lastSpawn = 0;
    const loop = (now) => {
      raf = 0; const dt = Math.min(50, now - lastT); lastT = now;
      const { ctx } = Draw.fit(cv); ctx.globalCompositeOperation = o.blend || 'lighter';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.age += dt; if (p.age > p.life) { parts.splice(i, 1); continue; }
        p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vy *= 0.995;
        const k = p.age / p.life, a = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * (o.alpha ?? 0.55);
        ctx.fillStyle = p.c; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (parts.length && !document.hidden) raf = requestAnimationFrame(loop);
    };
    Feed.on('trade', (t) => {
      if (document.hidden) return;
      const now = performance.now(); if (now - lastSpawn < (o.gap ?? 40)) return;   // 每秒最多約 25 顆
      const usd = t.p * t.q; if (usd < (o.min ?? 300) || parts.length > (o.max ?? 90)) return;
      const a = anchor(); if (!a) return; lastSpawn = now;
      const r = a.getBoundingClientRect(), buy = !t.m, size = Math.min(1, Math.log10(usd / 300) / 3.5);
      parts.push({ x: r.left + r.width * (0.08 + Math.random() * 0.84), y: buy ? r.top + r.height * 0.15 : r.bottom - r.height * 0.1,
        vx: (Math.random() - 0.5) * 0.25, vy: (buy ? -1 : 1) * (0.25 + Math.random() * 0.5 + size * 0.5), r: 1.1 + size * 3.2, age: 0, life: 1400 + Math.random() * 1600 + size * 1200,
        c: buy ? (o.up || cssv('up')) : (o.down || cssv('down')) });
      if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(loop); }
    });
  };

  // 卡片：滑鼠移過輕微 3D 傾斜、點擊漣漪（只對夠高的卡片，清單列不傾斜）
  if (hoverable && !reduce) {
    let cur = null;
    document.addEventListener('mousemove', (e) => {
      const el = e.target.closest && e.target.closest('[data-fx]');
      if (cur && cur !== el) { cur.style.transform = ''; cur = null; }
      if (!el || el.offsetHeight < 70 || fromTouch()) return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.classList.add('fx-tilt'); el.style.transform = `perspective(700px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg) translateZ(0)`; cur = el;
    });
    document.addEventListener('mouseleave', () => { if (cur) { cur.style.transform = ''; cur = null; } });
  }
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('[data-fx]'); if (!el || reduce) return;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const r = el.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2, s = document.createElement('span');
    s.className = 'fx-rip'; Object.assign(s.style, { width: d + 'px', height: d + 'px', left: e.clientX - r.left - d / 2 + 'px', top: e.clientY - r.top - d / 2 + 'px' });
    el.appendChild(s); setTimeout(() => s.remove(), 700);
  });

  // 進場：切換到這個主題時，主要區塊依序淡入上浮（分頁看不到時不播，避免卡在透明）
  FX.enter = (sels, o = {}) => {
    if (reduce || document.visibilityState !== 'visible' || !Element.prototype.animate) return;
    const els = sels.flatMap((s) => [...document.querySelectorAll(s)]);
    els.forEach((el, i) => {
      const a = el.animate([{ opacity: 0, transform: 'translateY(14px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        { duration: o.duration || 750, delay: (o.start || 60) + i * (o.step || 55), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      setTimeout(() => a.finish(), 4000);   // 保險：萬一動畫被暫停也一定會出現
    });
  };

  // 光澤：一道柔和的斜光每隔一段時間掃過指定表面
  FX.glint = (sel, o = {}) => {
    if (reduce) return;
    document.querySelectorAll(sel).forEach((el, i) => {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      const g = document.createElement('div'); g.className = 'fx-glint';
      g.style.setProperty('--gp', (o.period || 14) + 's'); g.style.setProperty('--gd', ((o.delay || 2) + i * 1.7) + 's'); g.style.setProperty('--ga', o.alpha ?? 0.16);
      el.appendChild(g);
    });
  };

  window.FX = FX;
})();
