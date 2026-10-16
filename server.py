#!/usr/bin/env python3
"""Market Ticker 本機伺服器。

- 提供 public/ 底下的網頁
- /api/markets：台股（證交所 MIS 即時 + Yahoo 5 分 K 補歷史）與美股（Yahoo）報價

只用 Python 標準函式庫，不用裝任何套件。
"""
import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT = "127.0.0.1", 8686
PUBLIC = Path(__file__).resolve().parent / "public"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TPE = timezone(timedelta(hours=8))
BAR_SEC = 300  # 迷你圖用 5 分 K

SYMBOLS = [
    # id, 顯示名稱, 代號, 市場, Yahoo 代號, MIS 代號
    ("TAIEX", "加權指數", "TAIEX", "TW", "^TWII", "tse_t00.tw"),
    ("2330", "台積電", "2330", "TW", "2330.TW", "tse_2330.tw"),
    ("0050", "元大台灣50", "0050", "TW", "0050.TW", "tse_0050.tw"),
    ("2454", "聯發科", "2454", "TW", "2454.TW", "tse_2454.tw"),
    ("SPY", "S&P 500 ETF", "SPY", "US", "SPY", None),
    ("QQQ", "Nasdaq 100 ETF", "QQQ", "US", "QQQ", None),
]

state = {
    sid: {
        "id": sid, "name": name, "code": code, "market": mkt,
        "price": None, "prevClose": None, "open": None, "high": None, "low": None,
        "time": None, "period": None, "yahooBars": [], "liveBars": {}, "error": None,
    }
    for sid, name, code, mkt, _, _ in SYMBOLS
}
lock = threading.Lock()


def fetch_json(url, referer=None, ua=UA):
    headers = {"User-Agent": ua, "Accept": "application/json"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def num(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


# ---------- Yahoo：當日 5 分 K、昨收、交易時段 ----------

def poll_yahoo(sid, ysym):
    sym = urllib.parse.quote(ysym)
    data = None
    for rng in ("1d", "5d"):
        d = fetch_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=5m&range={rng}", ua="Mozilla/5.0")
        data = d["chart"]["result"][0]
        if data.get("timestamp"):
            break
    meta = data["meta"]
    ts = data.get("timestamp") or []
    q = (data.get("indicators", {}).get("quote") or [{}])[0]
    bars = []
    for i, t in enumerate(ts):
        o, h, l, c = (q.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close"))
        if None in (o, h, l, c):
            continue
        bars.append({"t": t, "o": o, "h": h, "l": l, "c": c})
    # range=5d 時只保留最後一個交易日
    if bars:
        gmt = meta.get("gmtoffset", 0)
        last_day = (bars[-1]["t"] + gmt) // 86400
        bars = [b for b in bars if (b["t"] + gmt) // 86400 == last_day]

    period = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    with lock:
        s = state[sid]
        s["yahooBars"] = bars
        s["period"] = {"start": period.get("start"), "end": period.get("end")}
        # 台股昨收以證交所 MIS 為準；Yahoo 夜間偶爾給錯的前收，只在 MIS 還沒資料時當備用
        if not (s["market"] == "TW" and s.get("misPrev")):
            s["prevClose"] = meta.get("chartPreviousClose") or meta.get("previousClose")
        if s["market"] == "US" or s["price"] is None:
            s["price"] = meta.get("regularMarketPrice")
            s["high"] = meta.get("regularMarketDayHigh")
            s["low"] = meta.get("regularMarketDayLow")
            s["open"] = bars[0]["o"] if bars else None
            s["time"] = (meta.get("regularMarketTime") or 0) * 1000
        s["error"] = None


# ---------- 證交所 MIS：台股即時（約 5 秒一筆） ----------

def poll_mis():
    chs = "|".join(m for *_, m in SYMBOLS if m)
    d = fetch_json(
        f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={chs}&json=1&delay=0&_={int(time.time() * 1000)}",
        referer="https://mis.twse.com.tw/stock/index.jsp",
    )
    by_ch = {m: sid for sid, *_, m in SYMBOLS if m}
    for row in d.get("msgArray", []):
        sid = by_ch.get(f"{row.get('ex')}_{row.get('ch')}")
        if not sid:
            continue
        price = num(row.get("z"))
        if price is None:
            price = num((row.get("trade") or {}).get("z"))
        if price is None:
            bid = num((row.get("b") or "").split("_")[0])
            ask = num((row.get("a") or "").split("_")[0])
            price = (bid + ask) / 2 if bid and ask else (bid or ask)
        if price is None:
            continue
        tlong = int(row.get("tlong") or 0)
        hhmm = (row.get("t") or "00:00:00")[:5]
        with lock:
            s = state[sid]
            s["price"] = price
            if num(row.get("y")):
                s["prevClose"] = num(row.get("y")); s["misPrev"] = True
            s["open"] = num(row.get("o")) or s["open"]
            s["high"] = num(row.get("h")) or s["high"]
            s["low"] = num(row.get("l")) or s["low"]
            s["time"] = tlong
            s["error"] = None
            # 盤中自己累積 5 分 K，補上 Yahoo 延遲的那段
            if "09:00" <= hhmm <= "13:30" and tlong:
                bt = (tlong // 1000) // BAR_SEC * BAR_SEC
                bar = s["liveBars"].get(bt)
                if bar is None:
                    s["liveBars"][bt] = {"t": bt, "o": price, "h": price, "l": price, "c": price}
                else:
                    bar["h"] = max(bar["h"], price)
                    bar["l"] = min(bar["l"], price)
                    bar["c"] = price
                # 只留當天
                day0 = int(datetime.fromtimestamp(tlong / 1000, TPE).replace(hour=0, minute=0, second=0).timestamp())
                for k in [k for k in s["liveBars"] if k < day0]:
                    del s["liveBars"][k]


def merged_bars(s):
    bars = [dict(b) for b in s["yahooBars"]]
    last_t = bars[-1]["t"] if bars else 0
    for t in sorted(s["liveBars"]):
        lb = s["liveBars"][t]
        if t > last_t:
            bars.append(dict(lb))
        elif t == last_t:
            b = bars[-1]
            b["h"], b["l"], b["c"] = max(b["h"], lb["h"]), min(b["l"], lb["l"]), lb["c"]
    if bars and s["price"] and s["market"] == "US":
        b = bars[-1]
        b["c"] = s["price"]
        b["h"], b["l"] = max(b["h"], s["price"]), min(b["l"], s["price"])
    return bars


def tw_hot():
    now = datetime.now(TPE)
    return now.weekday() < 5 and "08:30" <= now.strftime("%H:%M") <= "14:00"


def is_open(s):
    p = s.get("period") or {}
    now = time.time()
    return bool(p.get("start") and p.get("end") and p["start"] <= now < p["end"])


def loop(name, fn, interval_fn):
    while True:
        try:
            fn()
        except Exception as e:  # 網路錯誤就下一輪再試
            print(f"[{datetime.now():%H:%M:%S}] {name} 失敗：{e}", flush=True)
        time.sleep(interval_fn())


def start_pollers():
    def mis_interval():
        return 5 if tw_hot() else 60

    threading.Thread(target=loop, args=("MIS", poll_mis, mis_interval), daemon=True).start()
    threading.Thread(target=yahoo_worker, daemon=True).start()


def yahoo_worker():
    """Yahoo 同時打太多會回 429，所以排隊一支一支抓，被擋就退避。"""
    due = {sid: 0.0 for sid, *_ in SYMBOLS}
    backoff = 0
    while True:
        now = time.time()
        sid, ysym, mkt = min(((s, y, m) for s, _, _, m, y, _ in SYMBOLS), key=lambda x: due[x[0]])
        if due[sid] > now:
            time.sleep(min(due[sid] - now, 1))
            continue
        try:
            poll_yahoo(sid, ysym)
            backoff = 0
            with lock:
                open_now = is_open(state[sid])
            if mkt == "US":
                due[sid] = time.time() + (10 if open_now else 180)
            else:
                due[sid] = time.time() + (90 if open_now else 600)
        except Exception as e:
            print(f"[{datetime.now():%H:%M:%S}] Yahoo {ysym} 失敗：{e}", flush=True)
            if "429" in str(e):
                backoff = min(max(backoff * 2, 30), 600)
                time.sleep(backoff)
            else:
                due[sid] = time.time() + 30
        time.sleep(1.5)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/api/markets":
            with lock:
                out = []
                for sid, *_ in SYMBOLS:
                    s = state[sid]
                    out.append({
                        k: s[k] for k in ("id", "name", "code", "market", "price", "prevClose", "open", "high", "low", "time")
                    } | {"isOpen": is_open(s), "bars": merged_bars(s)})
            body = json.dumps({"serverTime": int(time.time() * 1000), "symbols": out}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    start_pollers()
    server = ThreadingHTTPServer((HOST, PORT), partial(Handler, directory=str(PUBLIC)))
    print(f"Market Ticker 已啟動：http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
