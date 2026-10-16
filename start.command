#!/bin/zsh
# 雙擊這個檔案就會啟動：本機伺服器（含防休眠）＋ Chrome 全螢幕視窗
cd "$(dirname "$0")"
URL=http://127.0.0.1:8686

if ! lsof -ti tcp:8686 >/dev/null 2>&1; then
  # caffeinate -d：伺服器跑著的期間螢幕不會休眠
  nohup caffeinate -dis python3 server.py >> ticker.log 2>&1 &
  sleep 2
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --start-fullscreen --user-data-dir="$HOME/.market-ticker-chrome"
else
  open "$URL"
fi
