# 第 4 步：登录

> 这一步做完：主站登上了（`mentions` 第二次跑能接着用那张登录着的页；新号没有通知会报「确认为空」，那不算出错）。要发帖的话再扫一次码，`whoami` 显示小机的账号名（创作中心也登上了）。

小红书网页版有两套登录态：

- **主站**（`www.xiaohongshu.com`）：刷、搜、读帖、读评论、发评论、看通知都在这儿。登录凭证是一条叫 `web_session` 的 cookie。
- **创作中心**（`creator.xiaohongshu.com`）：发帖、看自己的笔记数据在这儿。它是另一套认证，主站登了它不一定登。

我们家两种办法都用过：主站一直是**导 cookie**，创作中心是**扫码**。无头浏览器自己走不了短信、滑块这些登录流程，所以登录永远是人来完成、小机来把凭证装进去。

先用小机的号在你自己的手机 App 上登好——扫码要用它，导 cookie 也要用它。

## 办法一：导 cookie（主站，我们家一直这么登）

**你做：**

1. 在你自己电脑的浏览器里，用小机的号登录 `www.xiaohongshu.com`（扫码或短信都行，这是你的浏览器，随便登）。
2. 按 F12 打开开发者工具 → Application（应用）→ Cookies → `https://www.xiaohongshu.com`。
3. 找到名字叫 `web_session` 的那一行，复制它的值（一长串字母数字）。
4. 把这个值交给小机。**它就是登录本身：只在你和小机之间私下传（你们俩的私聊窗口可以，公开的群、帖子、仓库不行），小机装完要删掉。**

**小机做：**

把值存成一个 JSON 文件（直接用编辑器写，或者让主人把文件传过来；尽量别把值写在命令行里，命令行会留在各种记录里），然后用 [examples/browser/inject-cookies.py](../examples/browser/inject-cookies.py) 通过浏览器的调试端口灌进去：

```bash
# /tmp/cookies.json 的内容：{"web_session": "把值放这里"}
sudo apt-get install -y python3-venv
python3 -m venv /tmp/cdp && /tmp/cdp/bin/pip install -q websocket-client
/tmp/cdp/bin/python3 examples/browser/inject-cookies.py --domain .xiaohongshu.com --cookies /tmp/cookies.json
rm /tmp/cookies.json
```

**做完你会看到**：脚本打印 `web_session: ok`。然后让小机**连跑两次**：

```bash
CI=1 opencli xiaohongshu mentions --limit 5 -f json
CI=1 opencli xiaohongshu mentions --limit 5 -f json
```

第一次是把页面打开，看第二次的输出：

| 看到什么 | 说明 |
|---|---|
| 打印出一串通知 | 登上了 ✅ |
| 有一行 `[xhs-resident] reused` | 登上了 ✅。这一行的意思是「接着用上一次那张页」，而命令只有在页面登录着的时候才会接着用 |
| 有一行 `[xhs-resident] reopened:not_logged_in`，或者报 `AUTH_REQUIRED`（退出码 77） | 没登上 → 重新导一次 cookie |
| 报 `EMPTY_RESULT`（退出码 66），消息里有 `confirmed empty page` | 通知页打开了，「评论和@」确实是空的。新号没被人 @ 过就是这样，**它本身说明不了登没登上**，看同一次输出里有没有上面那行 `reused`。错误下面那行 `help` 说「可能需要登录」，是 OpenCLI 给所有空结果的通用提示，别被它带偏 |
| 别的报错（`COMMAND_EXEC`，退出码 1，比如 `not loaded`、`not reached`） | 页面没加载好，多半是出口的问题 → 隔几分钟再跑；一直这样，回第 1 步查手机 |

第二次是 `reopened:` 加别的原因（不是 `not_logged_in`）的话，再跑一次看。

cookie 存在浏览器资料目录里，重启浏览器不丢。它会过期——我们家一条大概用了四个月。过期以后，读东西的命令会开始报登录错误（`AUTH_REQUIRED`）、出现 `reopened:not_logged_in`，或者页面被送去登录页。重新导一次就好。别和上面「新号通知为空」的 `EMPTY_RESULT` 搞混。

两个别做的：别直接改浏览器资料目录里的 Cookies 数据库（有加密）；别用页面脚本 `document.cookie` 去设（`web_session` 是 HttpOnly，设不进去）。

## 办法二：扫码（创作中心，我们家 9 月 20 日这么登的）

创作中心要的 cookie 有七条，我们家试过只灌两条不够、跳回登录页，最后是扫码救回来的。所以发帖之前，建议直接扫码。

**小机做：**

打开创作中心的登录页，把二维码截下来发给你。会话要带一个「空闲多少秒才回收」的时间，不然页面半分钟就被收走、码就作废了。（下面这几条命令是按我们家当时的做法和 OpenCLI 的用法整理的：我们当时是从页面里取出二维码图发过去的，截图这一步没有原样重跑过。）

```bash
export OPENCLI_BROWSER_IDLE_TIMEOUT=600
opencli browser login open https://creator.xiaohongshu.com/login
opencli browser login state          # 找到「APP扫一扫登录」那个按钮的编号
opencli browser login click <编号>
opencli browser login screenshot /tmp/xhs-login.png
```

然后把 `/tmp/xhs-login.png` 用你们平时传图的方式发给你。

**你做：** 打开登着小机号的小红书 App，扫这张图。图发到了这台手机上、App 也在这台手机上的话，把图在电脑屏幕上打开再扫；或者用 App 扫一扫里的「相册」选这张图（相册这条我们没试过）。二维码一分钟左右会过期，过期了让小机重截一张。

**小机做：** 等你说扫完了，确认并关掉这张页：

```bash
CI=1 opencli xiaohongshu whoami --site-session ephemeral -f json
opencli browser login close
```

`--site-session ephemeral` 让它另开一张一次性页去创作中心看，不动主站那张常驻页。以后发帖前也这么查。

**做完你会看到**：`whoami` 返回 `logged_in: true` 和小机的账号名。

我们没验证过扫码登创作中心会不会顺便把主站也登上。保险的做法：主站用办法一，创作中心用办法二。

## 登录以后还会碰到的一种二维码

发评论的时候，小红书偶尔会弹一个验证（HTTP 461）：登录没掉、读帖照常，只拦发评论，要求用登着小机号的 App 扫一下。我们家撞过两次，扫一下当场就解开，码一分钟失效。小机碰到会把它截下来发给你；扫完以后**不会自动重发**那条评论，让小机重新发一次。

## 什么情况是真的掉登录了

两套登录态分开看：

- **主站**掉了：`mentions`、`comments` 这些报 `AUTH_REQUIRED`（退出码 77），或者输出里出现 `[xhs-resident] reopened:not_logged_in`，或者首页被送去了登录页。→ 重新导 cookie。`mentions` 报 `EMPTY_RESULT`（退出码 66、`confirmed empty page`）**不算**掉登录，那是通知确实是空的。
- **创作中心**掉了：`whoami` 退出码 77、返回 `AUTH_REQUIRED`。只影响发帖，刷、读、评论不受影响。→ 重新扫码。

**不是**掉登录但看起来像的一种情况：页面被送去了海外版——那是出口的问题，回第 1 步查手机。

---

下一步：[日常怎么逛](5-daily.md)。
