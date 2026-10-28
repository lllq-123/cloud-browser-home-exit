#!/bin/bash
# opencli headless Chromium 启动包装。
# 为什么存在：Chromium 147 headless **忽略 file:// 的 PAC**（表现和「PAC 加载失败→回退 DIRECT」一模一样，
#   所有站都直连，很难察觉）。实测 data: 和 --proxy-server 都被认，file:// 不认。
#   故这里每次启动把 proxy.pac 转成 data: URL 喂进去。
#   → 「编辑 proxy.pac → 重启 opencli-chrome.service」照旧生效，不用手动转。
set -euo pipefail
DATA_DIR="$HOME/.cache/opencli-chrome-data"
PAC_FILE="$DATA_DIR/proxy.pac"
PAC_URL="data:application/x-ns-proxy-autoconfig;base64,$(base64 -w0 "$PAC_FILE")"
# 三项「别自相矛盾」修正——目标是让它像一台普通的 Linux 桌面电脑，不是隐身：
# ① 屏幕尺寸：--headless=new 自己会注入 --ozone-override-screen-size=800,600，
#    于是 screen(800x600) 比 window(1440x1000) 还小 —— 物理上不可能。
#    这里显式传一个覆盖它（Chrome 只在用户没指定时才填默认值）。
# ② UA 说实话：navigator.platform / userAgentData.platform 由 OS 决定、改不掉，永远是 Linux，
#    所以 UA 也写 X11 Linux，三者一致。曾试过写成 Windows，自相矛盾反而更可疑，改回 Linux。
# ③ 语言：原先 navigator.languages 只有 en-US，一个中文用户的浏览器不该这样。
# 实测基线（改之前）：platform=Linux x86_64 / screen=800x600 / window=1440x857 /
#   languages=en-US / webdriver=false。
exec "$HOME/.local/bin/opencli-chrome" \
  --headless=new \
  --window-size=1920,1040 \
  --ozone-override-screen-size=1920,1080 \
  --lang=zh-CN \
  "--accept-lang=zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --proxy-pac-url="$PAC_URL" \
  "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" \
  --user-data-dir="$DATA_DIR" \
  --load-extension="$HOME/.cache/opencli-extension" \
  --disable-extensions-except="$HOME/.cache/opencli-extension" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=DialMediaRouteProvider \
  about:blank
