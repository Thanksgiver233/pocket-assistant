#!/bin/sh
# 容器入口：首次启动自动初始化工作区，然后交给 pa-serve。
set -eu

WS="${PA_WORKSPACE:-/data/ws}"
HOME_DIR="${PA_HOME:-/data/home}"

if [ -z "${PA_TOKEN:-}" ]; then
  echo "pa-entrypoint: 缺少 PA_TOKEN（≥16 字符）" >&2
  exit 1
fi
if [ "${#PA_TOKEN}" -lt 16 ]; then
  echo "pa-entrypoint: PA_TOKEN 至少 16 字符" >&2
  exit 1
fi

mkdir -p "$WS" "$HOME_DIR"

if [ ! -f "$WS/.pi/pa-profile.json" ]; then
  echo "pa-entrypoint: 初始化工作区 $WS"
  node /app/packages/personal/bin/pa-init.mjs "$WS" --persona-name "${PA_PERSONA:-随身}" >/dev/null
fi

exec node /app/packages/personal/bin/pa-serve.mjs "$WS" \
  --home "$HOME_DIR" \
  --port 8787 \
  --host 0.0.0.0
