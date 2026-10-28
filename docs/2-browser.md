# 第 2 步：服务器上的浏览器

> 这一步做完：服务器后台跑着一个无头 Chromium，带着我们家那套启动参数和分流规则，打开小红书主站不再被送去海外版。

小机看不见屏幕，所以用的是**无头浏览器**——没有窗口，但该有的都有。它由一个后台服务拉起，崩了自动重启，退出 SSH 也一直跑着。

这一步全部由小机在服务器上做。

## 1. 装浏览器和字体

我们家用的是 Playwright 下载的完整版 Chromium（不是精简的 headless shell）：**147.0.7727.15**，目录名 `chromium-1217`。下面的命令把 Playwright 钉在 **1.59.1**，它装出来的就是这一版，和我们家一模一样。

先要 Node.js（后面装 OpenCLI 也要）。我们用 nvm 装的 Node 22：

```bash
# 先按 nvm 官方说明装 nvm：https://github.com/nvm-sh/nvm#installing-and-updating
# nvm 是一组 shell 函数，装完在同一个终端里要先加载一次（小机跑命令的环境常常不会自动加载，每次都带上这两行最稳）：
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm alias default 22
node --version
```

然后装 Chromium（`--with-deps` 会装系统依赖，要 sudo）和中文字体：

```bash
npx --yes playwright@1.59.1 install --with-deps chromium
sudo apt-get install -y fonts-noto-cjk fonts-noto-cjk-extra
ls ~/.cache/ms-playwright/
```

第一条一开头会打印一个大大的 WARNING 方框，说没先装项目依赖——我们只是借它下浏览器，不用管。

**做完你会看到**：`ls` 列出 `chromium-1217`、`chromium_headless_shell-1217`、`ffmpeg-1011`。我们只用第一个，真正的可执行文件是 `~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`。

给它做一个固定的软链接，启动脚本认这个名字：

```bash
ln -sfn ~/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome ~/.local/bin/opencli-chrome
~/.local/bin/opencli-chrome --version
```

**做完你会看到**：打印 `Google Chrome for Testing 147.0.7727.15`。Playwright 现在下的「Chromium」其实是谷歌给自动化测试出的这一版 Chrome，所以名字这么写；目录名和这份教程里都管它叫 Chromium。

第 4 节启动脚本里的 UA 写的正是 `Chrome/147.0.0.0`，对得上，不用改。以后要是换了浏览器版本，记得把 UA 里的 147 一起改掉，让浏览器的「自我介绍」和它本人对得上（为什么，见[第 7 篇](7-browse-like-a-person.md)）。

字体不装的话，截图里中文是方块、emoji 是空白。注意：**截图里 emoji 空白不等于字没发出去**，我们发帖时撞到过这个误会。

## 2. 分流规则（PAC）

PAC 是一小段 JavaScript，浏览器每次发请求前问它「这个网址走哪」。我们家的规则只做一件事：

- `www.xiaohongshu.com`（主站网页）和 `sns-creator-preview.xhscdn.com`（发帖时创作中心的图片预览，服务器直连会 400）→ 走家里的口子 `SOCKS5 127.0.0.1:1080`
- 其他所有网址 → 服务器直接出门

规则在 [examples/browser/proxy.pac](../examples/browser/proxy.pac)，放到浏览器的资料目录里：

```bash
mkdir -p ~/.cache/opencli-chrome-data
cp examples/browser/proxy.pac ~/.cache/opencli-chrome-data/proxy.pac
```

两个细节：

- 走家里口子的那几条**故意不接 `; DIRECT` 兜底**。手机断了就打不开，不悄悄换回海外 IP。
- Chromium 147 的无头模式**不认 `file://` 的 PAC**，所以启动脚本每次启动把这个文件转成 `data:` 网址再传给浏览器。改了 PAC 要重启浏览器服务才生效。

## 3. 浏览器扩展（Browser Bridge）加我们的补丁

OpenCLI 靠一个浏览器扩展操作页面。我们用的是官方 **1.0.26**，它挂在 OpenCLI v2.0.1 的发布页上，配第 3 步装的 OpenCLI 1.8.7 用——这个组合就是我们家每天在跑的，不是写错了。下载、核对校验值、解压到固定目录（v2.0.2 的发布页也有一个 1.0.26，打包不同所以校验值不同，[附录](appendix/headless-browser.md)用的是那份；补丁脚本只认校验值对得上的后台脚本，我们核过的是 v2.0.1 这份）：

```bash
(
set -e
mkdir -p ~/.cache/opencli-extension && cd ~/.cache/opencli-extension
curl -fL -o ext.zip https://github.com/jackwener/OpenCLI/releases/download/v2.0.1/opencli-extension-v1.0.26.zip
echo '1c2dad07f6c668d29d1727169c06be2ae72cb69bdc915e07a3f43c4ee3e15f0a  ext.zip' | sha256sum -c -
unzip -q -o ext.zip && rm ext.zip
test -f manifest.json
)
```

然后打我们家的一个小补丁。官方扩展操作页面的时候，有些动作要求那张标签页在「前台」，无头浏览器里后台标签会直接报错。补丁只做一件事：在接管一张交互标签页之前，先把它切到前台。它只认官方 1.0.26 原文件的校验值，拿到别的版本会直接拒绝，不会乱改：

```bash
python3 examples/browser/opencli_extension_patch.py \
  --input ~/.cache/opencli-extension/dist/background.js \
  --output ~/.cache/opencli-extension/dist/background.js
```

**做完你会看到**：脚本打印两行——第一行是状态和输出路径，第二行 `SHA256 b0c6c8e8...`（补丁后文件的校验值，以 `b0c6c8e8` 开头）。

## 4. 启动脚本和后台服务

[examples/browser/opencli-chrome-launch.sh](../examples/browser/opencli-chrome-launch.sh) 就是我们家每天启动浏览器的那条命令，参数一个没改。每个参数为什么这么设，见[第 7 篇](7-browse-like-a-person.md)。这里只说它做了什么：

- 无头模式（`--headless=new`），加载上面那个扩展，用 `~/.cache/opencli-chrome-data` 当资料目录
- 把 PAC 转成 `data:` 网址传进去
- 把自己装扮成一台普通的 Linux 桌面 Chrome：固定的 UA、1920×1080 的屏幕、中文
- 开一个只听本机的调试端口 `127.0.0.1:9222`，给第 4 步灌 cookie 和平时排障用
- 还有几个杂务参数：`--no-first-run`、`--no-default-browser-check`（别弹首次运行向导和「设为默认浏览器」）、`--disable-extensions-except`（只允许我们那一个扩展）、`--remote-allow-origins=*`（调试端口接受本机脚本的连接，灌 cookie 要用）、`--disable-features=DialMediaRouteProvider`（关掉局域网投屏探测）
- 从一张空白页启动

装脚本和后台服务 [examples/browser/opencli-chrome.service](../examples/browser/opencli-chrome.service)：

```bash
install -Dm755 examples/browser/opencli-chrome-launch.sh ~/.local/bin/opencli-chrome-launch.sh
mkdir -p ~/.config/systemd/user ~/.cache/opencli-logs
cp examples/browser/opencli-chrome.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencli-chrome.service
sleep 3
curl --noproxy '*' -s http://127.0.0.1:9222/json/version
```

**做完你会看到**：一段 JSON，`Browser` 字段是你装的 Chromium 版本，`User-Agent` 是脚本里写的那个普通 Linux Chrome。

服务挂了 5 秒后自动拉起，日志追加在 `~/.cache/opencli-logs/chrome.log`。第 1 步开过 linger，退出 SSH 它也接着跑。

## 5. 打开扩展的「开发者模式」

解压装进去的扩展，要资料目录里开了开发者模式才会被启用。这个开关在 profile 的 `Preferences` 文件里。第一次启动服务已经生成了这个文件，现在停掉服务、改一个键、再启动：

```bash
systemctl --user stop opencli-chrome.service
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".cache/opencli-chrome-data/Default/Preferences"
d = json.loads(p.read_text())
d.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
p.write_text(json.dumps(d))
PY
systemctl --user start opencli-chrome.service
python3 -c 'import json, pathlib; p = pathlib.Path.home() / ".cache/opencli-chrome-data/Default/Preferences"; print(json.loads(p.read_text())["extensions"]["ui"]["developer_mode"])'
```

**做完你会看到**：最后一行打印 `True`。扩展有没有真的接上，要等第 3 步装好 OpenCLI 再看。

## 6. 常驻页是怎么回事

第 3 步装的那些小红书命令，会在浏览器里留一张小红书页面不关，后面的搜索、看帖、看通知都在这张页里点来点去（点左上角 logo 回首页、点侧栏进通知、在搜索框里填字再点搜索），**不反复整页打开**。整页打开才会经过手机，页内点来点去不会。

什么时候才重新整页打开：页面空了、被送去了别的站、掉了登录、点 logo 回不到首页。这时手机必须在线。

我们家凌晨 3 点有一个整理脚本，把除了常驻页以外的标签页都关掉（它从看门狗的状态文件里读常驻页的编号，所以没公开）。整个浏览器平时占七八百 MB 内存。没有整理脚本的话，内存涨上去了就挑夜里重启一次浏览器，别频繁。

## 7. 什么时候重启、怎么重启

白天非必要别重启。重启以后常驻页没了，第一条小红书命令可能报 `no_pinia`，再跑一次就好。登录态在资料目录里，重启不丢。

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user restart opencli-chrome.service
```

第一行是在某些 SSH 环境里 `systemctl --user` 找不到用户会话时要加的。

改了 PAC、改了启动脚本，都要重启才生效。

---

下一步：[装 OpenCLI 和我们家的小红书命令](3-opencli.md)。
