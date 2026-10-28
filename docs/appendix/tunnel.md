# 附录 · 把国内设备的网络出口借给云服务器（通用做法）

> 📎 **通用做法，我们家没在用**：这篇是 Chatty 最早整理的通用写法，跟我们家日用的那套不一样，也没在全新环境里从头到尾跑通过，留给想自己折腾的人参考。照我们家的做法搭，请回[首页](../../README.md)。

这里先用两台 Linux 设备说明。海外服务器运行 **server**，国内电脑运行 **client**；国内设备主动连接服务器。安卓的一加实例见 [android.md](android.md)。

文中的 `cloud.example.com`、`clouduser`、指纹占位符都要替换成自己的值。所有命令标明了在哪一侧运行。

## 1. 两端安装 chisel

示例固定为 **1.12.0**，与我们核对过的本地服务器版本一致。下载入口及校验文件来自 [chisel v1.12.0 官方发布](https://github.com/jpillora/chisel/releases/tag/v1.12.0)。下面用于 Linux amd64 / arm64，在两端各执行一次；macOS、Windows 从同一发布页选对应包。

```bash
(
set -e
CHISEL_VERSION=1.12.0
case "$(uname -m)" in
  x86_64) CHISEL_ARCH=amd64 ;;
  aarch64|arm64) CHISEL_ARCH=arm64 ;;
  *) echo '请从官方发布页选择适合此架构的文件'; exit 1 ;;
esac
CHISEL_DOWNLOAD_DIR=$(mktemp -d)
cd "$CHISEL_DOWNLOAD_DIR"
CHISEL_ASSET="chisel_${CHISEL_VERSION}_linux_${CHISEL_ARCH}.gz"
CHISEL_RELEASE="https://github.com/jpillora/chisel/releases/download/v${CHISEL_VERSION}"
curl -fLO "$CHISEL_RELEASE/$CHISEL_ASSET"
curl -fLO "$CHISEL_RELEASE/chisel_${CHISEL_VERSION}_checksums.txt"
awk -v name="$CHISEL_ASSET" '$2 == name { print }' \
  "chisel_${CHISEL_VERSION}_checksums.txt" > selected-checksum.txt
test -s selected-checksum.txt
sha256sum -c selected-checksum.txt
gzip -dc "$CHISEL_ASSET" > chisel
install -Dm755 chisel "$HOME/.local/bin/chisel"
"$HOME/.local/bin/chisel" --version
)
```

官方发布页的 `.apk` 是 Alpine Linux 包，**不是安卓安装包**。安卓请按下一篇选择运行方式。

## 2. 海外服务器：建立认证文件与固定密钥

先检查 `~/.config/home-exit` 是否已有自己的配置；以下代码遇到已有目录会停下，避免覆盖正在使用的密钥。此步骤需要 Python 3。

```bash
set -e
umask 077
python3 - <<'PY'
import json
import secrets
from pathlib import Path

config = Path.home() / ".config" / "home-exit"
config.parent.mkdir(parents=True, exist_ok=True)
config.mkdir(mode=0o700, exist_ok=False)
auth = "homeexit:" + secrets.token_hex(24)
# 只允许这个客户端在服务器的回环地址创建指定的反向端口。
(config / "users.json").write_text(json.dumps({
    auth: [r"^R:127\.0\.0\.1:1080$"]
}) + "\n")
(config / "client.env").write_text("AUTH=" + auth + "\n")
for name in ("users.json", "client.env"):
    (config / name).chmod(0o600)
print("已创建认证文件；密码没有打印到终端。")
PY
"$HOME/.local/bin/chisel" server \
  --keygen "$HOME/.config/home-exit/server.key"
chmod 600 "$HOME/.config/home-exit/server.key"
```

`users.json` 与 `server.key` 留在服务器。`client.env` 通过自己的 SSH / SFTP 传给国内设备，保存在那一侧的 `~/.config/home-exit/client.env`，权限设为 `600`。例如在**国内 Linux 电脑**上：

```bash
install -d -m700 "$HOME/.config/home-exit"
scp 'clouduser@cloud.example.com:.config/home-exit/client.env' \
  "$HOME/.config/home-exit/client.env"
chmod 600 "$HOME/.config/home-exit/client.env"
```

这些文件放在仓库之外。不要把真实密码填进教程、截图或发给 agent 的聊天正文。

## 3. 海外服务器：前台启动

先让云安全组和主机防火墙允许国内设备连接 **TCP 9310**。**1080 不开放到公网**，它稍后只监听本机地址。

```bash
env -u AUTH -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  "$HOME/.local/bin/chisel" server \
  --host 0.0.0.0 --port 9310 \
  --reverse --keepalive 30s \
  --authfile "$HOME/.config/home-exit/users.json" \
  --keyfile "$HOME/.config/home-exit/server.key"
```

保留这个终端。从**自己可信的服务器终端**记下启动日志中的完整 `Fingerprint`，下一步填入客户端；它不是密码。固定密钥让服务器重启后仍能使用同一指纹。

本最小示例的 URL 使用 HTTP 传输外层，chisel 内部使用加密的 SSH 隧道；客户端同时使用账号认证和服务器指纹校验。若网络不允许这个端口，或已有 HTTPS 入口，直接使用文末的 HTTPS 变体。参数含义见 [chisel 官方用法与认证说明](https://github.com/jpillora/chisel#usage)。

## 4. 国内电脑：前台连接

在国内设备的 Bash 终端中运行，先把地址与指纹替换好：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
set -a
. "$HOME/.config/home-exit/client.env"
set +a
"$HOME/.local/bin/chisel" client \
  --fingerprint 'REPLACE_WITH_SERVER_FINGERPRINT' \
  --keepalive 25s \
  http://cloud.example.com:9310 \
  R:127.0.0.1:1080:socks
```

此时云服务器的 `127.0.0.1:1080` 才出现。浏览器连这个端口，目标请求由国内客户端发出；两端的方向不要写反。

chisel 自身能在网络断开后重连。如果进程被系统结束，还需要后面的进程管理来重新拉起。

## 5. 海外服务器：验出口，再验网站

另开一个服务器终端。先看监听，再通过 SOCKS 查询出口：

```bash
ss -ltn 'sport = :1080'
env -i PATH="$PATH" curl --fail --show-error --silent --max-time 25 \
  --socks5-hostname 127.0.0.1:1080 \
  https://api.bilibili.com/x/web-interface/zone
```

期望监听地址是 `127.0.0.1:1080`；查询结果的地区应与国内设备网络相符。查询服务也可能失败，不能把它的单次失败直接等同于隧道故障。

接着验证目标站实际能否取回响应：

```bash
env -i PATH="$PATH" curl --show-error --silent --max-time 30 \
  --socks5-hostname 127.0.0.1:1080 \
  --output /dev/null --dump-header - \
  https://www.xiaohongshu.com/explore
```

看状态码和 `Location`，尤其有没有被导去 `rednote.com`。curl 与浏览器的行为可能不同，**最终仍要用浏览器检查**，下一篇会做。

这里用了 `--socks5-hostname`，让目标域名在国内设备一侧解析；普通 `--socks5` 会在服务器一侧解析。`env -i` 用来排除当前终端已有的代理环境变量，避免测到了另一条出口。

## 6. 前台通了，再做常驻

海外服务器可使用 [home-exit-server.service](../../examples/appendix/home-exit-server.service)，国内 Linux 电脑可使用 [home-exit-client.service](../../examples/appendix/home-exit-client.service)。先编辑客户端示例中的地址与指纹，再在**对应设备**上安装相应的一个服务。

先回到本教程仓库根目录。服务器示例：

```bash
mkdir -p "$HOME/.config/systemd/user"
cp examples/appendix/home-exit-server.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now home-exit-server.service
journalctl --user -u home-exit-server.service -n 30 --no-pager
```

执行前先在前台终端按 Ctrl-C 停掉同一侧的测试进程，避免端口占用。国内 Linux 端照此安装 `home-exit-client.service`。需要退出登录后继续运行、开机自动启动时，由管理员为这个专用用户启用 linger：

```bash
sudo loginctl enable-linger "$USER"
```

安卓无需照搬 systemd，见 [安卓说明](android.md)。

## 可选：换成我们日用的 HTTPS 入口

我们的日用结构是 `国内设备 → HTTPS nginx → 服务器回环地址上的 chisel`。下面是给**已经有正常 HTTPS 站点和证书**的服务器使用的变体。

1. 在正确的 HTTPS `server` 块中加入 [nginx-location.conf](../../examples/appendix/nginx-location.conf)。
2. 把 chisel server 的 `--host` 改成 `127.0.0.1`，仍监听 9310。
3. 运行 `sudo nginx -t`，通过后 `sudo systemctl reload nginx`。
4. 客户端 URL 改成 `https://cloud.example.com/home-exit/`；认证文件和指纹保留。
5. 应用两端的进程配置，关闭公网 TCP 9310 的入站规则，只通过现有 HTTPS 入口连接，再重验出口。

若已安装 systemd 服务，编辑服务器实际安装的 `home-exit-server.service`，把 `ExecStart` 的监听地址改为 `127.0.0.1`；在国内设备实际安装的 `home-exit-client.service` 中把 URL 换成 HTTPS 地址。随后在各自设备上应用配置：

```bash
# 海外服务器
systemctl --user daemon-reload
systemctl --user restart home-exit-server.service
```

```bash
# 国内 Linux 设备
systemctl --user daemon-reload
systemctl --user restart home-exit-client.service
```

前台运行的则停止旧进程，用修改后的命令重新启动。用 `ss -ltn 'sport = :9310'` 确认服务器只监听 `127.0.0.1:9310`，再复测客户端连接和国内出口。

`proxy_pass` 后面的 `/` 用于去掉路径前缀；WebSocket upgrade 和较长的超时要保留。

证书应由正常受信任的签发方提供，私有 CA 则配置对应信任链。不要把跳过证书校验当成安装步骤。

接下来：[给浏览器分流](browser.md)。
