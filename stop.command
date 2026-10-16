#!/bin/zsh
lsof -ti tcp:8686 | xargs kill 2>/dev/null && echo "Market Ticker 已停止"
