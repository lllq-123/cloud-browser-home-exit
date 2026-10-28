#!/usr/bin/env python3
"""把主人从自己浏览器里导出来的 cookie 灌进服务器上的无头 Chromium（走 CDP 的 Network.setCookie）。

用法：
  python3 -m venv /tmp/cdp && /tmp/cdp/bin/pip install -q websocket-client
  /tmp/cdp/bin/python3 inject-cookies.py --domain .xiaohongshu.com --cookies cookies.json

cookies.json 的内容是 {"名字": "值", ...}，例如主站只要 {"web_session": "..."}。
灌进去的 cookie 存在浏览器的 profile 目录里，重启浏览器不丢。
用完把 cookies.json 删掉。
"""
import argparse
import json
import urllib.request

import websocket


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True, help="cookie 的 domain，例如 .xiaohongshu.com")
    ap.add_argument("--cookies", required=True, help="JSON 文件：{名字: 值}")
    ap.add_argument("--cdp", default="http://127.0.0.1:9222", help="浏览器调试端口")
    args = ap.parse_args()

    with open(args.cookies, encoding="utf-8") as f:
        cookies = json.load(f)

    targets = json.load(urllib.request.urlopen(f"{args.cdp}/json"))
    page = next(t for t in targets if t.get("type") == "page")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], origin=args.cdp)
    counter = [0]

    def call(method, params):
        counter[0] += 1
        ws.send(json.dumps({"id": counter[0], "method": method, "params": params}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == counter[0]:
                return msg

    for name, value in cookies.items():
        resp = call("Network.setCookie", {
            "name": name, "value": value,
            "domain": args.domain, "path": "/",
            "secure": True, "httpOnly": True,
            "sameSite": "Lax", "expires": 9999999999,
        })
        ok = resp.get("result", {}).get("success")
        print(f"{name}: {'ok' if ok else resp}")
    ws.close()


if __name__ == "__main__":
    main()
