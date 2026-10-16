// 共用 Canvas 繪圖：K 線 / 折線 / 面積 / 點陣，各方案用參數換風格
(function () {
  function fit(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function ema(values, n) {
    const k = 2 / (n + 1); let prev = null;
    return values.map((v) => (prev = prev == null ? v : v * k + prev * (1 - k)));
  }

  function candles(cv, bars, o = {}) {
    const { ctx, w, h } = fit(cv);
    if (!bars || !bars.length || !w || !h) return null;
    const n = Math.min(o.count || bars.length, bars.length);
    const all = bars.slice(-(n + 60)); // 多拿一點給 EMA 暖身
    const data = all.slice(-n);
    const pad = Object.assign({ t: 10, r: 10, b: 10, l: 10 }, o.pad);
    let hi = -Infinity, lo = Infinity;
    for (const b of data) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    const span = hi - lo || 1;
    hi += span * (o.headroom ?? 0.08); lo -= span * (o.footroom ?? 0.08);
    const slots = n + (o.rightGap ?? 2);
    const cw = (w - pad.l - pad.r) / slots;
    const X = (i) => pad.l + cw * (i + 0.5);
    const Y = (p) => pad.t + (hi - p) / (hi - lo) * (h - pad.t - pad.b);

    if (o.grid) {
      ctx.save();
      ctx.strokeStyle = o.grid.color; ctx.lineWidth = o.grid.width || 1;
      if (o.grid.dash) ctx.setLineDash(o.grid.dash);
      const rows = o.grid.rows || 4;
      for (let i = 0; i <= rows; i++) {
        const y = Math.round(pad.t + (h - pad.t - pad.b) * i / rows) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      }
      if (o.grid.cols) {
        for (let i = 0; i <= o.grid.cols; i++) {
          const x = Math.round(pad.l + (w - pad.l - pad.r) * i / o.grid.cols) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (o.volume) {
      let mv = 0; for (const b of data) mv = Math.max(mv, b.v);
      const vh = (h - pad.t - pad.b) * (o.volume.h || 0.16);
      ctx.save();
      data.forEach((b, i) => {
        const bh = mv ? b.v / mv * vh : 0;
        ctx.fillStyle = b.c >= b.o ? o.volume.up : o.volume.down;
        ctx.fillRect(X(i) - cw * 0.35, h - pad.b - bh, Math.max(1, cw * 0.7), bh);
      });
      ctx.restore();
    }

    const mode = o.mode || 'candle';
    ctx.save();
    if (o.glow) { ctx.shadowBlur = o.glow; }
    if (mode === 'candle' || mode === 'ohlc') {
      const bw = Math.max(1, cw * (o.body ?? 0.62));
      data.forEach((b, i) => {
        const up = b.c >= b.o;
        const col = up ? o.up : o.down;
        ctx.strokeStyle = ctx.fillStyle = col;
        if (o.glow) ctx.shadowColor = col;
        const x = Math.round(X(i)) + 0.5;
        ctx.lineWidth = o.wick || 1;
        if (mode === 'ohlc') {
          ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l));
          ctx.moveTo(x - bw / 2, Y(b.o)); ctx.lineTo(x, Y(b.o));
          ctx.moveTo(x, Y(b.c)); ctx.lineTo(x + bw / 2, Y(b.c)); ctx.stroke();
          return;
        }
        ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
        const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
        const bh = Math.max(1, y2 - y1);
        if ((up && o.hollowUp) || (!up && o.hollowDown)) {
          ctx.fillStyle = o.hollowFill || '#000';
          ctx.fillRect(x - bw / 2, y1, bw, bh);
          ctx.lineWidth = 1; ctx.strokeRect(x - bw / 2 + 0.5, y1 + 0.5, bw - 1, bh - 1);
        } else ctx.fillRect(x - bw / 2, y1, bw, bh);
      });
    } else if (mode === 'line' || mode === 'area') {
      ctx.beginPath();
      data.forEach((b, i) => (i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c))));
      if (mode === 'area') {
        ctx.save();
        ctx.lineTo(X(n - 1), h - pad.b); ctx.lineTo(X(0), h - pad.b); ctx.closePath();
        const g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
        g.addColorStop(0, o.areaTop); g.addColorStop(1, o.areaBottom || 'transparent');
        ctx.fillStyle = g; ctx.shadowBlur = 0; ctx.fill();
        ctx.restore();
        ctx.beginPath();
        data.forEach((b, i) => (i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c))));
      }
      ctx.strokeStyle = o.line; ctx.lineWidth = o.lineWidth || 1.5; ctx.lineJoin = 'round';
      if (o.glow) ctx.shadowColor = o.line;
      ctx.stroke();
    } else if (mode === 'dots') {
      // 點陣：每根 K 棒用一串方點表示高低，實體段點亮
      const step = o.dot || 4;
      data.forEach((b, i) => {
        const up = b.c >= b.o;
        const x = Math.round(X(i) - step / 2);
        const yh = Y(b.h), yl = Y(b.l), y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
        for (let y = Math.floor(yh / step) * step; y <= yl; y += step) {
          const body = y + step / 2 >= y1 - 1 && y <= y2 + 1;
          ctx.fillStyle = body ? (up ? o.up : o.down) : o.dim;
          ctx.fillRect(x, y, step - 1, step - 1);
        }
      });
    }
    ctx.restore();

    if (o.ema) {
      const closes = all.map((b) => b.c);
      for (const e of o.ema) {
        const vals = ema(closes, e.n).slice(-n);
        ctx.save();
        ctx.beginPath();
        vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
        ctx.strokeStyle = e.color; ctx.lineWidth = e.width || 1;
        if (e.dash) ctx.setLineDash(e.dash);
        ctx.stroke(); ctx.restore();
      }
    }

    if (o.axis) {
      ctx.save();
      ctx.font = o.axis.font; ctx.fillStyle = o.axis.color; ctx.textBaseline = 'middle';
      ctx.textAlign = o.axis.side === 'left' ? 'left' : 'right';
      const ticks = o.axis.ticks || 4;
      for (let i = 0; i <= ticks; i++) {
        const p = hi - (hi - lo) * i / ticks;
        const y = Y(p);
        const x = o.axis.side === 'left' ? 4 : w - 4;
        ctx.fillText((o.axis.fmt || ((v) => v.toFixed(0)))(p), x, y);
      }
      ctx.restore();
    }

    const last = data[n - 1];
    const lx = X(n - 1), ly = Y(last.c);
    if (o.lastLine) {
      ctx.save();
      ctx.strokeStyle = o.lastLine.color; ctx.lineWidth = 1;
      ctx.setLineDash(o.lastLine.dash || [3, 3]);
      ctx.beginPath(); ctx.moveTo(o.lastLine.full ? pad.l : lx, Math.round(ly) + 0.5); ctx.lineTo(w - (o.lastLine.toEdge ? 0 : pad.r), Math.round(ly) + 0.5); ctx.stroke();
      ctx.restore();
    }
    return { X, Y, cw, n, hi, lo, w, h, last: { x: lx, y: ly, c: last.c } };
  }

  // 迷你圖：slots 是整個交易時段的格數，空白代表還沒走完
  function spark(cv, bars, o = {}) {
    const { ctx, w, h } = fit(cv);
    if (!bars || !bars.length || !w || !h) return null;
    const pad = Object.assign({ t: 4, r: 2, b: 4, l: 2 }, o.pad);
    const slots = Math.max(o.slots || bars.length, bars.length);
    let hi = -Infinity, lo = Infinity;
    for (const b of bars) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); }
    if (o.base != null) { hi = Math.max(hi, o.base); lo = Math.min(lo, o.base); }
    const span = hi - lo || 1; hi += span * 0.05; lo -= span * 0.05;
    const X = (i) => pad.l + (w - pad.l - pad.r) * (i + 0.5) / slots;
    const Y = (p) => pad.t + (hi - p) / (hi - lo) * (h - pad.t - pad.b);
    if (o.base != null) {
      ctx.save(); ctx.strokeStyle = o.baseColor || 'rgba(255,255,255,.3)'; ctx.setLineDash(o.baseDash || [2, 3]); ctx.lineWidth = 1;
      const y = Math.round(Y(o.base)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.restore();
    }
    const mode = o.mode || 'line';
    if (mode === 'candle') {
      const cw = (w - pad.l - pad.r) / slots, bw = Math.max(1, cw * 0.6);
      bars.forEach((b, i) => {
        const col = b.c >= b.o ? o.up : o.down;
        ctx.strokeStyle = ctx.fillStyle = col;
        const x = Math.round(X(i)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
        const y1 = Y(Math.max(b.o, b.c));
        ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, Y(Math.min(b.o, b.c)) - y1));
      });
    } else {
      ctx.save();
      if (mode === 'area' && o.fill) {
        ctx.beginPath();
        bars.forEach((b, i) => (i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c))));
        const baseY = o.base != null ? Y(o.base) : h - pad.b;
        ctx.lineTo(X(bars.length - 1), baseY); ctx.lineTo(X(0), baseY); ctx.closePath();
        ctx.fillStyle = o.fill; ctx.fill();
      }
      ctx.beginPath();
      bars.forEach((b, i) => (i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c))));
      ctx.strokeStyle = o.line; ctx.lineWidth = o.lineWidth || 1.5; ctx.lineJoin = 'round';
      if (o.glow) { ctx.shadowBlur = o.glow; ctx.shadowColor = o.line; }
      ctx.stroke();
      ctx.restore();
    }
    const lb = bars[bars.length - 1];
    if (o.dot) {
      ctx.save(); ctx.fillStyle = o.dot; ctx.shadowBlur = 8; ctx.shadowColor = o.dot;
      ctx.beginPath(); ctx.arc(X(bars.length - 1), Y(lb.c), o.dotR || 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    return { X, Y, w, h };
  }

  window.Draw = { fit, ema, candles, spark };
})();
