# 常见问题

按「你看到什么」找。每一条都是我们家真撞过的。

## 借路

| 看到什么 | 先查什么 |
|---|---|
| 服务器上 `ss -ltn` 没有 `127.0.0.1:1080` | 手机那头没连上。到手机 root shell：`pidof chisel` 在不在；`tail /data/adb/home-exit/client.log` 看最后几行。常见：密码两边不一样、脚本里 IP / 域名 / 路径没改对、手机重启后 Magisk 进了安全模式（`service.d` 不跑） |
| `client.log` 里 `x509: unknown authority` | 脚本里没带 `SSL_CERT_DIR=/system/etc/security/cacerts`（我们的脚本带了，自己改过的检查一下） |
| `client.log` 里 `lookup ... [::1]:53 ... refused` | 手机没有 DNS 配置。装 DNS 模块后**重启手机**才生效 |
| 验出口的 `curl` 返回的 `province` 不是你家 | 手机上的梯子把隧道的流量带走了。检查梯子的分应用规则，改完再验 |
| 验出口的 `curl` 返回海外、但明明没开梯子 | 服务器终端里有 `https_proxy` 之类的变量，命令前面加 `env -i PATH="$PATH"` |
| 小红书主站打开被送去 `rednote.com` | 出口不对（上一条），或者 PAC 没生效（改了 PAC 没重启浏览器） |
| 云厂商邮件说发现「黑客工具 chisel」 | 特征名命中。核对 `sha256sum ~/.local/bin/chisel` 和官方发布一致，忽略或加白 |

## 浏览器

| 看到什么 | 先查什么 |
|---|---|
| 服务起不来，日志里 `No usable sandbox` | 启动脚本里有 `--no-sandbox`，确认你用的是仓库里这份 |
| `curl 127.0.0.1:9222/json/version` 连不上 | `systemctl --user status opencli-chrome.service`；没有用户会话时先 `export XDG_RUNTIME_DIR=/run/user/$(id -u)` |
| 改了 `proxy.pac` 没效果 | 要重启浏览器服务；PAC 是启动时转成 `data:` 网址传进去的 |
| 重启浏览器后第一条小红书命令报 `no_pinia` | 常驻页还没建起来，再跑一次 |
| 截图里中文是方块、emoji 空白 | 字体没装全。注意 emoji 空白**不等于**字没发出去 |
| 内存越来越高 | 常驻页以外的标签页没关。我们家凌晨整理一次；你可以定期重启浏览器（登录不丢） |

## OpenCLI 和命令

| 看到什么 | 先查什么 |
|---|---|
| `opencli doctor` 说 extension 没连上 | ①资料目录里开发者模式没开（第 2 步第 5 节）；②扩展目录里没有 `manifest.json`；③补丁没打或打在了别的版本上 |
| `opencli xiaohongshu feed` 报「未知命令」或找不到 `@jackwener/opencli/registry` | `~/.opencli/node_modules/@jackwener/opencli` 软链没建；或者命令没复制进 `~/.opencli/clis/xiaohongshu/` |
| 升级 OpenCLI 以后我们家的命令全没了 | 正常，会被清掉。入口脚本下次运行会自动从 `~/opencli-xiaohongshu/` 补回；手动跑 `bash ~/opencli-xiaohongshu/install.sh` 也行。但新版本能不能跑这些命令，我们没试 |
| 退出码 75、「小红书页忙」 | 另一条小红书命令占着常驻页，排队等了 3 分钟没轮到。过几分钟再来；别并发 |
| `comments --limit 50 --with-replies` 在大帖子上超时 | 默认 120 秒。`--timeout 300` 调大（入口脚本封顶 600），或者要少一点（20 条） |
| 浏览器服务连崩几次后不再自动重启 | 5 分钟内崩 5 次 systemd 就放弃。先看 `~/.cache/opencli-logs/chrome.log` 修原因（常见：PAC 文件不存在、软链接指错），再 `systemctl --user reset-failed opencli-chrome.service && systemctl --user start opencli-chrome.service` |
| `feed --limit 60` 只回来 39 条 | 常驻页在后台标签页上往下滚不加载。一次刷新能拿到的就这么多，要更多就等下一轮 |
| `which opencli` 指到 nvm 目录 | `~/.local/bin` 没排在 PATH 前面 |

## 登录

| 看到什么 | 先查什么 |
|---|---|
| `whoami` 退出码 77 / `AUTH_REQUIRED` | 创作中心没登录（这和主站是两回事）。扫码登 |
| `mentions` 报登录错误 | 主站 cookie 过期或没灌进去。重新导 `web_session` |
| 命令一直返回空，或者报 `EMPTY_RESULT`（退出码 66） | 先隔几分钟再试一次（页面可能没加载完）。新号的 `mentions` 报 `EMPTY_RESULT`、`confirmed empty page` 是正常的，只是没有通知；登没登上按[第 4 步](4-login.md)那张表看 |
| 发评论时弹二维码（461） | 不是掉登录。用小机号的 App 扫一下，扫完**重新发**那条评论 |
| 扫码页面还没扫就没了 | 会话空闲被回收了。每条 `opencli browser` 命令前都带 `OPENCLI_BROWSER_IDLE_TIMEOUT=600`（单位是秒） |

## 评论和帖子

| 看到什么 | 先查什么 |
|---|---|
| 评论「审核中」、别人看不到 | 多半是敏感词，真人号也会。换个说法；**别原样重发** |
| 提示「引流到站外」 | 有链接或像链接的东西，删掉 |
| 评论命令超时、不知道发没发 | **不要重发。** `comments` 回读评论区看自己那条在不在 |
| `comment --reply-to` 返回「评论和帖子对不上」 | 给的评论编号不在这篇帖子底下。核对链接；或者去掉 `--reply-to` 发顶层评论 |
| `publish --topics` 失败、页面只剩普通 `#文字` | 已知问题。先 `drafts` 看有没有存下草稿，从草稿接着编辑，别重跑 `publish` |
| 被踢下线 | 最该当回事的一种（不一定是被盯上，cookie 本来也会过期）。停手、放慢、过一阵再登。见[第 7 篇](7-browse-like-a-person.md) |
