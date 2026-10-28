# 附录 · 从只有 SSH 的服务器搭起浏览器（通用做法）

> 📎 **通用做法，我们家没在用**：这篇是 Chatty 最早整理的通用写法，跟我们家日用的那套不一样，也没在全新环境里从头到尾跑通过，留给想自己折腾的人参考。照我们家的做法搭，请回[首页](../../README.md)。

这一章补齐云端 Chrome 的安装、无头运行、扩展、可视登录、后台常驻，以及常被叫作“无头伪装”的环境设置。示例面向 **Ubuntu 22.04 / 24.04、普通用户、Linux x86_64**；其他发行版的依赖与沙箱支持要另行确认。

我们的日用配置采用完整浏览器的新无头模式，设置屏幕、窗口、语言和 Linux UA。公开脚本把这些设置拆开，让你能看到每一项究竟改变了什么。**这里能配置并检查浏览器环境，不能保证网站无法识别自动化。**

顺序：先按[隧道教程](tunnel.md)接通国内出口，再安装本章浏览器，最后回到[分流与常驻页](browser.md)和 [agent 使用](agent.md)。浏览器从 `about:blank` 启动，手机暂时离线也不妨碍检查浏览器本身。

## 1. 安装完整 Chromium 和字体

现代 Chrome 的 headless 与有界面模式共用完整实现；旧的 `chrome-headless-shell` 是另一套精简程序。要使用浏览器扩展，按 [Playwright 的扩展指南](https://playwright.dev/python/docs/chrome-extensions)选择其配套完整 Chromium。品牌版 Chrome / Edge 对命令行侧载扩展有不同限制，不能随便换一个二进制后沿用相同假设。

本章用 Playwright **1.64.1** 下载浏览器，再直接启动其完整可执行文件；Playwright 在这里负责安装，不负责每次创建测试上下文。该版本的官方清单对应 Chrome for Testing **156.0.8078.4**，见 [browsers.json](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/browsers.json)。

在服务器上执行：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv curl unzip git fontconfig fonts-noto-cjk fonts-noto-color-emoji
python3 -m venv "$HOME/.local/share/xhs-browser/venv"
"$HOME/.local/share/xhs-browser/venv/bin/pip" install --index-url https://pypi.org/simple 'playwright==1.64.1'
"$HOME/.local/share/xhs-browser/venv/bin/python" -m playwright install --with-deps --no-shell chromium
```

`--no-shell` 只省掉旧 headless shell 的下载，保留完整浏览器；不要写成 `--only-shell`。系统依赖安装可能请求 sudo。安装与更新规则见 [Playwright 浏览器说明](https://playwright.dev/python/docs/browsers)。以后更新 Playwright 后，要重新执行浏览器安装，不能假设旧缓存就是新版本。

把实际可执行路径写入自己的配置目录：

```bash
install -d -m700 "$HOME/.config/xhs-browser"
"$HOME/.local/share/xhs-browser/venv/bin/python" - <<'PY' > "$HOME/.config/xhs-browser/chrome-path"
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)
PY
fc-match 'Noto Sans CJK SC'
fc-match 'Noto Color Emoji'
```

字体会影响截图、中文排版和 emoji 显示。字体缺字造成的方块或空白，与正文字符有没有传进去是两项检查；我们在实际发帖时遇到过这种差别。

## 2. 准备 Browser Bridge 扩展

这一组合固定为 **OpenCLI 2.0.2 + Browser Bridge 1.0.26**。从官方 release 下载并核验，解压后的目录应直接含 `manifest.json`：

```bash
(
set -e
XHS_SETUP_DIR="$HOME/.config/xhs-browser"
test ! -e "$XHS_SETUP_DIR/extension" || { echo 'extension 已存在；升级时先备份并正常停止浏览器'; exit 1; }
curl -fL \
  'https://github.com/jackwener/OpenCLI/releases/download/v2.0.2/opencli-extension-v1.0.26.zip' \
  -o "$XHS_SETUP_DIR/opencli-bridge.zip"
cd "$XHS_SETUP_DIR"
printf '%s\n' '2b2eff46fe4a21a0b02516e743005066e6317b48f15455c1c7b07f69ad7af211  opencli-bridge.zip' | sha256sum -c -
unzip -q opencli-bridge.zip -d extension
test -f extension/manifest.json
)
```

该校验值对应 [v2.0.2 官方发布](https://github.com/jackwener/OpenCLI/releases/tag/v2.0.2)中的文件，不是我们家的补丁包。我们日用扩展另有前台标签补丁，本仓库没有把它混进官方安装步骤。

## 3. 安装启动脚本

如果尚未取到教程仓库：

```bash
git clone https://github.com/lllq-123/cloud-browser-home-exit.git
cd cloud-browser-home-exit
```

在仓库根目录执行：

```bash
install -Dm755 examples/appendix/start-browser.sh "$HOME/.local/bin/xhs-browser"
if [ ! -e "$HOME/.config/xhs-browser/browser.env" ]; then
  install -m600 examples/appendix/xhs-browser.env.example "$HOME/.config/xhs-browser/browser.env"
fi
if [ ! -e "$HOME/.config/xhs-browser/proxy.pac" ]; then
  install -m600 examples/appendix/xhs.pac "$HOME/.config/xhs-browser/proxy.pac"
fi
"$HOME/.local/bin/xhs-browser"
```

默认使用独立资料目录 `~/.config/xhs-browser/profile`、回环调试端口 `9222`、完整 Chromium 新无头模式，以及前文的 PAC。首次创建资料目录时，脚本会开启这个目录的扩展开发者模式；发现已有 Preferences 没开时会停下提示，不覆盖已有配置。

另开 SSH 终端检查：

```bash
ss -ltn 'sport = :9222'
curl --noproxy '*' --fail --silent http://127.0.0.1:9222/json/version
curl --noproxy '*' --fail --silent http://127.0.0.1:9222/json/list
```

确认监听在回环地址，版本是你安装的浏览器，列表有 `about:blank`。调试端口能控制登录后的浏览器，因此通过下一节的 SSH 转发访问，云安全组无需开放 9222。Chrome 136 起对默认资料目录的调试开关有额外限制，独立目录也避免撞上原有浏览器；见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。

## 4. 让它退出 SSH 后继续运行

前台检查通过后，在启动浏览器的终端按 Ctrl-C 正常结束它，再从仓库根目录安装用户服务：

```bash
mkdir -p "$HOME/.config/systemd/user"
cp examples/appendix/xhs-browser.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now xhs-browser.service
journalctl --user -u xhs-browser.service -n 30 --no-pager
```

需要登出后继续运行及开机启动时，由管理员为该用户启用 linger：

```bash
sudo loginctl enable-linger "$USER"
```

服务的 `Restart=always` 能重新拉起意外退出的浏览器；失败限流避免配置错误时无休止重启。它不恢复自动化工具的旧绑定，也不保证原页面会被原样保留。修改 `browser.env` 后正常重启这个服务，再重新确认页面和绑定。

## 5. 无头浏览器也可以让本人看见、登录

在**自己的电脑**上建立转发，窗口保持打开：

```bash
ssh -N -L 127.0.0.1:19222:127.0.0.1:9222 clouduser@cloud.example.com
```

随后在自己电脑的 Chrome 中：

1. 打开 `chrome://inspect/#devices`，开启发现网络目标。
2. 点 Configure，加入 `127.0.0.1:19222`。
3. 在 Remote Target 中找到云端标签页，点 inspect。DevTools 的页面 live view 可以展示并操作无头页面。
4. 在远程目标区域使用 Open 打开 `https://www.xiaohongshu.com/explore`，或选择已经打开的该站标签。
5. 在云端页面完成本人登录及网页要求的验证。不要把登录二维码、Cookies 或整个 profile 提交到仓库。

这是 [Chrome 官方支持的 headless 调试方式](https://developer.chrome.com/docs/automation-and-testing/debug-headless)。SSH 转发传的是浏览器控制连接，网页仍按**云端浏览器的 PAC**出网；在本地电脑另开一个普通小红书页，不是在给云端浏览器登录。

如果网站验证在这个界面无法完成，可以在已有图形桌面中，停止专用服务后使用同一资料目录运行：

```bash
XHS_BROWSER_MODE=headed "$HOME/.local/bin/xhs-browser"
```

这条命令要求真实的 DISPLAY / Wayland 桌面，不能在普通 SSH 窗口中凭空显示 GUI。不要同时启动两个进程抢同一 profile；有界面实例退出后再恢复服务。是否通过网站验证，以实际页面为准。

## 6. 接上 OpenCLI

按[官方安装说明](https://github.com/jackwener/OpenCLI/blob/v2.0.2/README.md#quick-start)准备 Node.js ≥20.18.1，安装 CLI，再让它与扩展连接：

```bash
npm install -g @jackwener/opencli@2.0.2
opencli daemon restart
opencli doctor
```

2.0.2 的 `daemon restart` 在原来没有 daemon 时也会启动它；已有其他任务共用 daemon 时，先协调时机。CLI 和扩展应在这台服务器上使用同一个本地 daemon。默认桥接端口是 19825；无需开放到公网。`doctor` 应显示 daemon、扩展均连接正常。只看到 9222 可访问，不能证明 Browser Bridge 已接上。

接着按 [agent 说明](agent.md)绑定当前小红书标签，并读回 URL、登录状态和正文。在 headless 中，“前台标签”仍有活动状态；远程 inspect 看到的那一张不一定恰好是 bind 选中的那一张，必须核对返回内容。

## 7. 屏幕、窗口与语言：消除自相矛盾

| 设置 | 改变什么 | 需要核对什么 |
| --- | --- | --- |
| `--headless=new` | 运行完整浏览器而不显示本地窗口 | 二进制不是旧 headless shell，扩展实际加载 |
| `--screen-info={0,0 1920x1080}` | 虚拟显示器的大小与位置 | `screen.width/height`、可用区域 |
| `--window-size=1920,1040` | 初始浏览器窗口大小 | `outerWidth/outerHeight` 与页面 viewport |
| `--force-device-scale-factor=1` | 设备缩放比例 | `devicePixelRatio` 与截图 / CSS 坐标换算 |
| `--accept-lang=zh-CN,zh,en-US,en` | 网页语言偏好与请求 Accept-Language | `navigator.language/languages`、Network 请求头 |
| `--lang=zh-CN` | 请求界面语言 | Linux 上还受实际系统 locale 影响，不能单靠它判断网页语言 |

我们曾遇到虚拟屏幕只有 800×600，窗口却更大的情况。日用脚本用过 `--ozone-override-screen-size`；公开示例使用当前官方文档中的 `--screen-info`。屏幕和窗口是不同设置，viewport 通常还要扣掉浏览器界面部分。不能要求这三组数完全相同。参考 [Chrome 虚拟屏幕说明](https://developer.chrome.com/docs/automation-and-testing/headless-screen-config)。

语言列表传语言代码即可，HTTP 中的权重由浏览器生成，不把 `;q=0.9` 当作语言代码塞进去。Linux 界面语言需配合系统已安装的 locale，相关区别见 [Chromium 的语言开关定义](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/base/ui_base_switches.h)。

配置了四项偏好，也不应硬断言每个页面都会公开四项。此次隔离测试中，profile 确实保存四项，但 `navigator.languages` 为 `["zh-CN"]`，请求头为 `zh-CN,zh;q=0.9`；造成该差异的具体机制未继续追查。检查首选语言、合法语言代码、保存的偏好和实际请求即可；不要为了凑齐列表盲改其他浏览器功能。

OpenCLI 或其他工具新建窗口时可能调整窗口大小；首次启动和工具实际操作后的页面都检查一次。保持真实时区即可，不为了“像国内设备”把所有环境属性都改掉。

## 8. UA：我们家怎么配，以及它的边界

UA 是浏览器发送的身份字符串。原生 headless UA 可能含 `HeadlessChrome`。我们日用配置曾把它改成普通 Linux Chrome 的字符串，同时保留真实 Linux 平台；没有把 Linux 浏览器写成 Windows。

公开脚本默认 `XHS_UA_MODE=native`，保留浏览器原生 UA 和 Client Hints。需要对照我们家这项做法时，在 `browser.env` 改为：

```bash
XHS_UA_MODE=linux-desktop
```

随后重启专用浏览器并重新检查。脚本会从实际 `chrome --version` 取得主版本，生成类似 `Chrome/156.0.0.0` 的缩减版 Linux UA，不把旧版本号永久写死。这个示例只接受 Linux x86_64；ARM 机器不要冒用 x86_64 字符串。

**UA 字符串、`navigator.platform`、UA Client Hints 是不同接口。**覆盖 `--user-agent` 不等于同步设置所有身份信息；某些版本的 Client Hints 还会因此变空。Chrome 官方也明确，改 UA 不会改变浏览器内部实现，见 [UA 覆盖说明](https://developer.chrome.com/docs/devtools/device-mode/override-user-agent)。

本次 Chrome 156 隔离实测中，覆盖后基础 Client Hints 仍显示 Linux / Chromium 156，但高熵字段 `architecture`、`bitness` 和 `fullVersionList` 变空了；原生 UA 模式下这些字段有值。这也是示例默认保留原生 UA、将覆盖作为可选对照的原因。

如果另一个自动化框架采用 CDP 的 `Network.setUserAgentOverride`，应另外考虑 `platform`、`acceptLanguage` 和 `userAgentMetadata`，并检查新标签、请求头是否沿用预期设置；不能只在一张页里改个 JavaScript 属性就宣布全浏览器一致。字段定义见 [CDP 协议](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-setUserAgentOverride)。

`navigator.webdriver` 的值也应实读；单独把它改为 false 不能证明网站认不出自动化。WebGL、字体、行为、会话及网站自身策略都是另外的因素。这里提供的是能检查的运行配置，没有把这些参数包装成“必过风控”的开关。

## 9. 在实际页面检查环境

在自己云端页面的 DevTools Console 运行 [inspect-environment.js](../../examples/appendix/inspect-environment.js)。它只读 UA、平台、语言、屏幕、窗口、DPR、时区、webdriver 和 Client Hints，不改页面。UA Client Hints 要在支持该 API 的安全上下文中检查，例如 HTTPS 页面或 localhost；普通 `data:` 页面缺少它，不等于配置有问题。

重点看：实际 Linux 平台、UA 主版本与浏览器主版本是否相符；语言列表是否是有效语言代码；窗口是否适合当前屏幕；覆盖 UA 后 Client Hints 是否缺失或矛盾。再到 Network 面板检查真正发出去的 User-Agent / Accept-Language / Sec-CH-UA 请求头。

这一步检查环境，前文的 SOCKS 出口检查验证网络路径，主站页面检查验证网站实际行为。三项分别通过以后，再进入常驻页流程。

## 常见启动问题

| 现象 | 处理 |
| --- | --- |
| 缺 `.so` / 浏览器立即退出 | 使用对应 Playwright 的 `install --with-deps --no-shell chromium`，看退出日志 |
| `No usable sandbox` / user namespace 被拒 | 使用普通用户，按宿主系统支持的方式配置 Chromium 沙箱；Ubuntu 23.10+ 可从 [Chromium 的 AppArmor 排障说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)定位，避免直接关闭全机限制 |
| 明确决定在受控隔离环境中禁用浏览器沙箱 | 可显式设置 `XHS_NO_SANDBOX=1`。它关闭了保护，不会帮助隐藏无头模式；我们的旧日用环境用了该兼容项，公开脚本默认关闭 |
| 容器 `/dev/shm` 太小导致 renderer 崩溃 | 优先给容器足够共享内存；`XHS_SMALL_SHM=1` 可改用临时文件路径，通常有性能代价 |
| 扩展目录在，doctor 仍未连接 | 核对 manifest 目录、开发者模式、运行中的扩展版本与 daemon；不是只看 zip 文件名 |
| 已有 profile 开发者模式关闭 | 正常停止专用浏览器，备份 `Default/Preferences`，仅将现有 JSON 中 `extensions.ui.developer_mode` 设为 true，保留其他内容，再启动 |
| profile 被占用 / SingletonLock | 查同一用户的旧浏览器和服务是否仍运行，正常停止对应实例；不要自动删锁后启动第二个进程 |
| 调整参数后毫无变化 | 旧进程可能仍接管该 profile；修改环境文件后重启对应专用服务，再读实际值 |
| 登录能显示，但验证码或验证仍不通过 | 由本人处理当前站点要求；无头配置和国内出口都不是账号验证的替代品 |

完整脚本见 [start-browser.sh](../../examples/appendix/start-browser.sh)，可用 `--print-args` 查看将使用的参数。该选项仍会准备专用目录及首次 Preferences，但不会启动浏览器。实际验证范围见 [verification.md](verification.md)。
