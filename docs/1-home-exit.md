# 第 1 步：借家里的网

> 这一步做完：服务器上多出一个 `127.0.0.1:1080` 的口子，从这个口子出去查到的 IP 是你家的。

## 为什么要借

海外 IP 打开 `www.xiaohongshu.com`，小红书会直接把你送去海外版（`rednote.com`）。登录态在那边不认，页面当你是游客，一条通知都读不到。我们家 2026 年 10 月 27 日起就是这样。

所以要让浏览器**打开主站网页的时候**从国内出门。我们家借的是一台放家里的一加手机的网：手机主动连到服务器，在服务器上开一个口子（`127.0.0.1:1080`），浏览器打开主站就走这个口子。

只有主站网页走手机。数据接口、图片、创作中心这些服务器直接出门就能用，不用都绕一遍手机（第 2 步的 PAC 规则管这个）。

## 两边各跑一个 chisel

[chisel](https://github.com/jpillora/chisel) 是一个很小的隧道程序。服务器上跑 **server**，手机上跑 **client**。连接方向是**手机连服务器**，所以手机不需要公网 IP，家里路由器也不用开端口。

我们家的结构：

```
手机上的 chisel client ──HTTPS──▶ 服务器 nginx（你的域名/home-exit/）──▶ 服务器本机 chisel server（127.0.0.1:9310）
                                                                        └──▶ 开出口子 127.0.0.1:1080（SOCKS5）
```

隧道藏在 nginx 的一个路径后面，走的是你本来就有的 HTTPS，不用给服务器多开端口。**前提是你的服务器有一个带证书的域名**（我们家用的是 Let's Encrypt）。没有域名的，[附录](appendix/tunnel.md)里有直接开端口的写法，我们家没用过。

---

## 开始之前：把仓库拿到服务器上

后面所有命令里的 `examples/...`、`opencli-xiaohongshu/...` 都是相对仓库根目录的路径。小机先：

```bash
git clone https://github.com/lllq-123/cloud-browser-home-exit.git ~/cloud-browser-home-exit
cd ~/cloud-browser-home-exit
```

（手机那一段是你在自己电脑上做的，要用的几个文件到时候在电脑上另下一份，那一段会说。）

另外，这份教程里 `systemctl --user ...` 会出现很多次。有些 SSH 环境下它会报「Failed to connect to bus」，先在那个终端里执行一次 `export XDG_RUNTIME_DIR=/run/user/$(id -u)` 就好。

## 服务器这边（小机来做）

### 1. 装 chisel

我们用的版本是 **1.12.0**。从官方发布页下载、核对校验值，服务器用的 amd64 版放到 `~/.local/bin/`；手机用的 arm64 版也解压一份到 `~/chisel-arm64`，只用来算个校验值，手机那段拿它对一下：

```bash
(
set -e
V=1.12.0
cd "$(mktemp -d)"
curl -fLO "https://github.com/jpillora/chisel/releases/download/v${V}/chisel_${V}_linux_amd64.gz"
curl -fLO "https://github.com/jpillora/chisel/releases/download/v${V}/chisel_${V}_linux_arm64.gz"
curl -fLO "https://github.com/jpillora/chisel/releases/download/v${V}/chisel_${V}_checksums.txt"
command grep -E "chisel_${V}_linux_(amd64|arm64).gz" "chisel_${V}_checksums.txt" | sha256sum -c -
gzip -dc "chisel_${V}_linux_amd64.gz" > chisel
gzip -dc "chisel_${V}_linux_arm64.gz" > "$HOME/chisel-arm64"
install -Dm755 chisel "$HOME/.local/bin/chisel"
"$HOME/.local/bin/chisel" --version
sha256sum "$HOME/chisel-arm64"
)
```

**做完你会看到**：倒数第二行打印 `1.12.0`，最后一行是 arm64 文件的校验值（记下来，手机上要对）。

### 2. 生成密码

隧道用一个「用户名:密码」做认证。随机生成一个，存在 `~/.config/home-exit/auth.env`，只有一行：

```bash
mkdir -p "$HOME/.config/home-exit"
printf 'AUTH=homeexit:%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" > "$HOME/.config/home-exit/auth.env"
chmod 600 "$HOME/.config/home-exit/auth.env"
```

这个文件手机上也要放一份一模一样的（下面会说）。**它是密码：只在你和小机之间私下传，别发到任何公开的地方，别进 git。**

### 3. 装成后台服务

把 [examples/server/home-exit-tunnel.service](../examples/server/home-exit-tunnel.service) 复制到用户的 systemd 目录，启动：

```bash
mkdir -p "$HOME/.config/systemd/user"
cp examples/server/home-exit-tunnel.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now home-exit-tunnel.service
systemctl --user status home-exit-tunnel.service --no-pager | head -5
```

它跑的是 `chisel server --host 127.0.0.1 --port 9310 --reverse --keepalive 30s`，密码从 `auth.env` 读，只听本机，不对外。服务挂了 5 秒后自动拉起。

再让这个用户的后台服务在你退出 SSH、甚至服务器重启以后也继续跑（这一条要 sudo）：

```bash
sudo loginctl enable-linger "$USER"
```

**做完你会看到**：`ss -ltn | grep 9310` 有一行 `127.0.0.1:9310`。

### 4. nginx 开一个路径

把 [examples/server/nginx-home-exit.conf](../examples/server/nginx-home-exit.conf) 那一块放进你 HTTPS 站点的 `server { ... }` 里，然后检查、重载。路径 `/home-exit/` 可以自己改个名字，改了就要三处一起改：这个 nginx 块、下面那条检查命令、手机脚本里的网址。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**做完你会看到**：`curl -s https://你的域名/home-exit/health` 打印 `OK`。

---

## 手机这边（你来做，小机把东西准备好）

### 要准备什么

- 一台 **root 过的安卓手机**（我们是一加 8T + Android 14 + Magisk 30）。root 是为了开机自启和改 DNS；隧道本身不需要 root，但没 root 的做法我们没试过。
- 它要常年插着电、连着家里的 WiFi。手机不在线的时候，小红书主站就打不开（这是故意的，下面会说）。

### 放进手机的四样东西

| 放哪 | 是什么 |
|---|---|
| `/data/adb/home-exit/chisel` | arm64 版 chisel（官方发布页下载，到手机上再解压），`chmod 755` |
| `/data/adb/home-exit/auth.env` | 和服务器上一模一样的那一行密码，`chmod 600` |
| `/data/adb/service.d/home-exit.sh` | 开机脚本 [examples/phone/home-exit.sh](../examples/phone/home-exit.sh)，里面的服务器 IP、域名在下面的命令里换成你的，`chmod 755` |
| `/data/adb/modules/home-exit-dns/` | Magisk 模块 [examples/phone/home-exit-dns/](../examples/phone/home-exit-dns/)——两个文件（`module.prop` 和 `system/etc/resolv.conf`），**放成和仓库里一样的目录结构** |

### 怎么放进去

这一段在**你自己的电脑**上做：数据线连着手机，用 `adb`（root 手机的时候你用过的那套工具）。分四步，**第 ④ 步的命令小机会把值都替你填好，你照着贴**。

**① 电脑上准备 4 个文件，放进同一个文件夹**

- 在本仓库的 GitHub 页面点 **Code → Download ZIP**，解压，取出这三个：
  - `examples/phone/home-exit.sh`
  - `examples/phone/home-exit-dns/module.prop`
  - `examples/phone/home-exit-dns/system/etc/resolv.conf`
- 到 [chisel 1.12.0 的发布页](https://github.com/jpillora/chisel/releases/tag/v1.12.0) 下载 `chisel_1.12.0_linux_arm64.gz`，**不用解压**，手机上解。

用 Download ZIP 就好。Windows 上用 `git clone` 有可能把脚本的换行改成 Windows 格式，手机上就跑不起来了。

**② 推到手机的临时目录**

在电脑的终端里进到这个文件夹，执行：

```bash
adb push home-exit.sh module.prop resolv.conf chisel_1.12.0_linux_arm64.gz /data/local/tmp/
```

提示 pushed、没有报错就行。

**③ 进手机的 root shell**

还是在电脑的终端里，先敲 `adb shell` 进到手机，再敲：

```sh
su
id -u
```

第一次敲 `su`，手机上 Magisk 会弹窗问要不要给「Shell」超级用户权限，点允许。`id -u` 打印 `0` 才算进了 root shell。

**第 ④ 步每一条都在这个 root shell 里敲。**别图省事在电脑上敲 `adb shell su -c '…'` 这种一行式：电脑的终端会先把引号吃掉，`>`、`&&` 后面那半截就跑到 root 外面去了，密码文件写不进去。

**④ 在 root shell 里依次执行**（小机给你的版本里 `<...>` 都已经填好）

```sh
T=/data/local/tmp
mkdir -p /data/adb/home-exit /data/adb/service.d /data/adb/modules/home-exit-dns/system/etc
/data/adb/magisk/busybox gunzip -c $T/chisel_1.12.0_linux_arm64.gz > /data/adb/home-exit/chisel
chmod 755 /data/adb/home-exit/chisel
sha256sum /data/adb/home-exit/chisel
printf 'AUTH=homeexit:<密码>\n' > /data/adb/home-exit/auth.env
chmod 600 /data/adb/home-exit/auth.env
cp $T/home-exit.sh /data/adb/service.d/home-exit.sh
sed -i -e 's|^SERVER_IP=.*|SERVER_IP=<服务器公网 IP>|' -e 's|^DOMAIN=.*|DOMAIN=<你的域名>|' /data/adb/service.d/home-exit.sh
chmod 755 /data/adb/service.d/home-exit.sh
cp $T/module.prop /data/adb/modules/home-exit-dns/module.prop
cp $T/resolv.conf /data/adb/modules/home-exit-dns/system/etc/resolv.conf
rm $T/home-exit.sh $T/module.prop $T/resolv.conf $T/chisel_1.12.0_linux_arm64.gz
ls -l /data/adb/home-exit /data/adb/service.d /data/adb/modules/home-exit-dns/system/etc
grep -E '^(SERVER_IP|DOMAIN)=' /data/adb/service.d/home-exit.sh
```

解压用的是 Magisk 自带的 busybox，装了 Magisk 就一定有。nginx 路径要是改过（不是 `/home-exit/`），小机会在 `sed` 那行再加一段 `-e 's|/home-exit/|/你的路径/|'`。密码就是服务器上 `auth.env` 里那一行，小机私下发给你，别发到别处。

全部执行完，敲两次 `exit`，退出 root shell 和 adb。

**做完你会看到**：

- `sha256sum` 打印的校验值和小机在服务器上第 1 节最后一行算的一样（不一样就是下错了文件，删掉重下）；
- `ls -l` 列出 `chisel`、`auth.env`、`home-exit.sh`、`resolv.conf`；
- 最后两行是你的服务器 IP 和域名。

这组命令是按我们家手机上的最终状态整理的（我们当时是用自己的工具一条条写进去的），没有用 adb 从头跑过一遍。

### 为什么要那个 DNS 模块、为什么要证书路径

这两个是我们当时真踩到的坑，脚本里都已经处理了：

- **安卓没有 `/etc/resolv.conf`**，chisel 这种静态编译的 Go 程序找不到 DNS，会报 `lookup ... [::1]:53 connection refused`。隧道连服务器用的是 IP、不用解析，但浏览器通过隧道访问小红书的时候，域名是在手机这边解析的，没有 DNS 就全失败。所以用 Magisk 模块往 `/system/etc/` 塞一个 `resolv.conf`（阿里和腾讯的公共 DNS）。**重启手机才生效。**
- **Go 程序也找不到安卓的证书目录**，连 HTTPS 会报 `x509: unknown authority`。启动时带上 `SSL_CERT_DIR=/system/etc/security/cacerts` 就好，脚本里已经写了。

### 开机脚本做什么

[home-exit.sh](../examples/phone/home-exit.sh) 很短：开机后等 20 秒，然后一直循环——读密码，带上证书路径启动 chisel client 连服务器，断了就等 10 秒重连。日志在 `/data/adb/home-exit/client.log`，超过 1MB 自动清空。

它用服务器的 **IP** 连，再用 `--hostname` 和 `--sni` 带上你的域名过 nginx 和证书，所以连服务器这一下不依赖手机的 DNS。

### 放好以后

重启一次手机。然后让小机在服务器上看：

```bash
ss -ltn | grep 1080
env -i PATH="$PATH" curl -s --socks5-hostname 127.0.0.1:1080 https://api.bilibili.com/x/web-interface/zone
```

**做完你会看到**：第一条有一行 `127.0.0.1:1080`；第二条返回的 JSON 里 `province` / `isp` 是你家所在的省和运营商。

两点说明：

- 第二条前面的 `env -i` 是把当前终端里的代理变量清掉。服务器上要是设了 `https_proxy`，不清掉量到的就是别的出口。
- `--socks5-hostname` 让域名在手机那边解析，浏览器走 PAC 的时候就是这个模式。

---

## 手机上的梯子和隧道怎么共处

我们家手机上还开着一个代理 App 给别的 App 用。要知道的是：隧道是 root 进程，它的流量走不走那个代理 App，取决于代理 App 的分应用设置怎么对待 root 进程。我们 10 月 17 日就撞过一次（那天正在试整站走手机）：改了它的分应用设置，整条隧道的出口跑到了海外，小红书照样跳海外版。改回去就好了。

所以：**每次改过手机上代理 App 的设置，都让小机重跑一遍上面那条 `curl`，看 `province` 还是不是你家。**

## 手机不在线的时候

PAC 规则里，走家里口子的那几个域名**不接兜底**：手机断了，主站就打不开，浏览器不会悄悄换回服务器自己的海外 IP 去开。这是故意的——宁可打不开，也别让小红书看到两个 IP 换来换去。

手机没电、不在家、或者代理 App 把出口带偏了，主站网页就打不开，常驻页一旦要整页重开就会失败。已经开着的常驻页在页里点来点去（比如读通知）可能还照常，因为数据接口本来就是服务器直接出门的——所以「通知还读得到」不等于手机在线。查手机：`pidof chisel` 还在不在，`client.log` 最后几行写了什么。

## 一条可能收到的告警

云厂商的主机安全可能把 chisel 报成「黑客工具」给你发邮件——它常被拿来做内网穿透，特征名命中而已。我们家收到过，核对文件的 sha256 和官方发布一致，就忽略了。

---

下一步：[服务器上的浏览器](2-browser.md)。
