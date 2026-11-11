#!/usr/bin/env bash
# 在本地抓一张操作台截图，输出到 docs/console.png。
#
#   ./scripts/screenshot.sh            # 默认 http://localhost:8787/
#   PORT=9000 ./scripts/screenshot.sh
#
# 先另开一个终端跑 `npm run serve`，再执行本脚本。
# 没有任何 Chromium 系浏览器时会直接退出并提示，不假装成功。

set -euo pipefail

PORT="${PORT:-8787}"
OUT="docs/console.png"
URL="http://localhost:${PORT}/"

CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  "$(command -v google-chrome || true)"
  "$(command -v chromium || true)"
)

BROWSER=""
for candidate in "${CANDIDATES[@]}"; do
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    BROWSER="${candidate}"
    break
  fi
done

if [[ -z "${BROWSER}" ]]; then
  echo "找不到 Chromium 系浏览器，跳过截图。" >&2
  echo "可以手动打开 ${URL} 截图后存为 ${OUT}。" >&2
  exit 1
fi

if ! curl -fsS --max-time 3 "${URL}" > /dev/null; then
  echo "服务没起来：先执行 npm run serve（或 node src/api/http.ts）" >&2
  exit 1
fi

PROFILE="$(mktemp -d)"
trap 'rm -rf "${PROFILE}"' EXIT

echo "使用 ${BROWSER}"
"${BROWSER}" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --user-data-dir="${PROFILE}" \
  --window-size=1440,1280 \
  --virtual-time-budget=4000 \
  --screenshot="$(pwd)/${OUT}" \
  "${URL}"

if [[ -f "${OUT}" ]]; then
  echo "已生成 ${OUT}"
else
  echo "截图失败，未生成 ${OUT}" >&2
  exit 1
fi
