# 附录 · 用安卓手机做国内出口（通用做法）

> 📎 **通用做法，我们家没在用**：这篇是 Chatty 最早整理的通用写法，跟我们家日用的那套不一样，也没在全新环境里从头到尾跑通过，留给想自己折腾的人参考。照我们家的做法搭，请回[首页](../../README.md)。

我们实际使用的是 **一加 8T、Android 14、已有 Root 的环境**。隧道只是手机上的一个网络进程，网站登录保存在服务器浏览器里。

**反向 SOCKS5 本身不要求 Root。**我们的 Root 用于已有的开机运行和 DNS 配置；不要为了这份教程先去解锁、刷机。

## 无 Root 可选路线：Termux

这条路线依据 Termux 官方包配置整理，**本仓库没有在一台干净的无 Root 手机上完成端到端实测**。先前台连接、验出口和目标域名，再考虑长期运行。

从 [Termux 官方安装说明](https://github.com/termux/termux-app#installation)选择安装来源。在 Termux 中安装工具：

```bash
pkg update
pkg install golang ca-certificates resolv-conf openssh
go install github.com/jpillora/chisel@v1.12.0
"$HOME/go/bin/chisel" --version
```

使用 Termux 的 Go 在手机本地编译，是为了使用它针对 Android 的适配；官方 Go 包的配置包含 DNS 路径修正，见 [Termux golang 包定义](https://github.com/termux/termux-packages/blob/master/packages/golang/build.sh)。如果 Go 提示模块需要更新的工具链，先更新 Termux 的 Go 包，避免自动换成不带 Termux 适配的普通 Linux 工具链。

按[隧道教程](tunnel.md#2-海外服务器建立认证文件与固定密钥)把 `client.env` 传进 Termux 私有目录 `~/.config/home-exit/`，设置目录权限 `700`、文件权限 `600`。随后在 Termux 的 Bash 中：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
set -a
. "$HOME/.config/home-exit/client.env"
set +a
"$HOME/go/bin/chisel" client \
  --fingerprint 'REPLACE_WITH_SERVER_FINGERPRINT' \
  --keepalive 25s \
  http://cloud.example.com:9310 \
  R:127.0.0.1:1080:socks
```

使用 HTTPS 分支时换成自己的 HTTPS URL。服务器上的出口检查和目标网页检查都通过后，再接浏览器。

前台可用以后，可以按 [Termux:Boot 官方步骤](https://github.com/termux/termux-boot#usage)配置启动脚本。Termux 与附加应用应来自兼容的同一安装来源；首次打开 Boot，脚本放入 `~/.termux/boot/`。需要待机运行时可使用 `termux-wake-lock`，并在系统设置允许 Termux 后台活动与自启动。

不同厂商对后台进程的限制不同。重启一次、断网重连一次、熄屏一段时间以后都要从服务器重验；锁定最近任务卡片不等于已经验证保活。

## 我们这台已有 Root 的一加怎么跑

日用环境把 chisel ARM64 二进制、认证文件和日志放在专用目录，由 Magisk 的 `service.d` 脚本启动。脚本负责进程退出后重新拉起；chisel 负责连接断开时重连。

曾经遇到两个彼此独立的问题：

| 症状 | 实际原因与处理方向 |
| --- | --- |
| HTTPS 报 `x509: unknown authority` | 静态 Linux 二进制没找到安卓证书目录；我们的环境通过 `SSL_CERT_DIR=/system/etc/security/cacerts` 解决。其他 Android 版本需要核实实际证书位置。 |
| `lookup … [::1]:53 … refused` | Go 没找到可用的 DNS 配置。我们通过已有 Magisk 模块提供 resolver 配置；随手把 Linux ARM64 包丢进手机，不保证目标域名能解析。 |

用服务器 IP 连接隧道、为 HTTPS 指定正确的 SNI，可以解决**隧道服务器域名**的解析问题，但小红书等**目标网站域名**仍要能在手机端解析。两项都要验证。

这份教程提供可移植的连接方法，不分发我们手机的系统模块。已有 Root 的读者可以把验证成功的客户端命令接入自己的进程管理；无 Root 的读者优先试前面的 Termux 路线。

## 手机在国内，出口却在海外

这是我们实际踩过的坑：手机上的另一套 VPN / 代理把隧道进程的流量也接走了。手机仍在国内，服务器借到的出口却成了海外。

检查代理应用的分应用规则，让 **chisel 或 Termux 发往目标网站的连接**使用预期的国内网络。只把“连接云服务器”的地址加进直连名单，并不能证明目标网站连接也直出了。

调整分流、切换 Wi-Fi / 移动网络以后，从服务器重新执行出口与目标网站检查。用手机 App 的 IP 属地判断另一进程的网络路径，也可能判断错。

手机负责开门时需要联网、进程存活。常驻网页正常以后，一部分操作可以少依赖手机；手机断线并不会让所有后续操作都必然可用，边界见[浏览器说明](browser.md)。
