# 第 3 步：装 OpenCLI 和我们家的小红书命令

> 这一步做完：小机敲 `opencli xiaohongshu feed --limit 3` 能跑通（没登录的话提示需要登录，也算通）。

[OpenCLI](https://github.com/jackwener/OpenCLI) 是一个开源工具：命令行 → 本机一个小 daemon → 浏览器扩展 → 页面。它自带一百多个网站的「站点命令」，小红书是其中之一。我们家在它的小红书命令上改了一些、加了两条，放在本仓库的 [`opencli-xiaohongshu/`](../opencli-xiaohongshu/) 里。

这一步全部由小机做。

## 1. 装 OpenCLI 1.8.7

我们家用的是 **1.8.7**，这些命令只在这个版本上跑过。新版本（2.x）改了不少东西，我们没跟进，**别装 latest**：

```bash
nvm use default
npm install -g @jackwener/opencli@1.8.7
opencli --version
```

OpenCLI 的用户目录是 `~/.opencli/`。放在里面的自定义命令要能找到 OpenCLI 本体，需要一个软链接指向全局装的包：

```bash
mkdir -p ~/.opencli/node_modules/@jackwener
ln -sfn "$(npm root -g)/@jackwener/opencli" ~/.opencli/node_modules/@jackwener/opencli
ls -l ~/.opencli/node_modules/@jackwener/
```

**做完你会看到**：`opencli --version` 打印 `1.8.7`；`ls -l` 显示那个软链接指向 nvm 目录下的 `@jackwener/opencli`。

## 2. 放进我们家的命令

把 `opencli-xiaohongshu/` 整个目录复制到家目录下（入口脚本默认到这里找），然后跑安装脚本。它只是把目录里的 `.js`（连同 `LICENSE`、`NOTICE.md` 两份说明）复制到 `~/.opencli/clis/xiaohongshu/`：

```bash
mkdir -p ~/opencli-xiaohongshu && cp -r opencli-xiaohongshu/. ~/opencli-xiaohongshu/
bash ~/opencli-xiaohongshu/install.sh --no-verify
ls ~/.opencli/clis/xiaohongshu/
```

13 条命令是什么、哪些改自官方、改了什么，见 [`opencli-xiaohongshu/NOTICE.md`](../opencli-xiaohongshu/NOTICE.md)。

**为什么要留着 `~/opencli-xiaohongshu/` 这份**：OpenCLI 一升级，`~/.opencli/clis/` 里凡是官方有更新的站点目录会被整个删掉，自定义命令必丢。下一节的入口脚本每次运行前会检查，发现少了就从这份自动补回来。

## 3. 入口脚本

我们家不直接调 OpenCLI 本体，而是经过一个 bash 入口脚本 [examples/opencli/opencli](../examples/opencli/opencli)。它做五件事：

1. 指定用哪个 Node。公开版默认取当前环境里的 `node`；**建议把脚本开头的 `NODE_BIN_DIR` 写死成 nvm 里 Node 22 的 bin 目录**（我们家就是写死的），这样定时任务、没加载 nvm 的环境里也能跑。
2. 把终端里的代理环境变量清掉——OpenCLI 自己下载图片、查短链这些请求要从服务器直接出门，不该跟着小机进程的代理走。
3. 默认设一个浏览器调试端口的变量（`OPENCLI_CDP_ENDPOINT`，指向 `127.0.0.1:9222`），给需要它的地方用。
4. **自愈**：发现 `~/.opencli/clis/` 里缺了我们家的命令，就自动从 `~/opencli-xiaohongshu/` 重新复制一遍。
5. **排队**：小红书那 7 条共用常驻页的命令（`feed`、`search`、`note`、`comments`、`download`、`comment`、`mentions`）一次只能跑一条。两条同时跑会互相把页面换走、静默读错。排队最多等 3 分钟，等不到报「小红书页忙」退出码 75；单条最长跑 10 分钟。

装到 `~/.local/bin/`，并确认它排在 nvm 的 bin 前面：

```bash
install -Dm755 examples/opencli/opencli ~/.local/bin/opencli
hash -r
which opencli
```

**做完你会看到**：`which opencli` 打印 `~/.local/bin/opencli`（不是 nvm 目录下那个）。如果不是，把 `export PATH="$HOME/.local/bin:$PATH"` 加进 `~/.bashrc`。

脚本开头有两处可以改：`NODE_BIN_DIR`（建议直接改成你 nvm 里 Node 22 的 bin 目录，比如 `$HOME/.nvm/versions/node/v22.x.x/bin`；也可以用环境变量 `OPENCLI_NODE_BIN_DIR` 指定）和正本目录（默认 `~/opencli-xiaohongshu`，放别处就设环境变量 `OPENCLI_CUSTOM_SRC`）。

## 4. 让它和浏览器接上

daemon 不用你管，第一条需要浏览器的命令会自动把它拉起来；扩展会自己连上 daemon。检查一下：

```bash
opencli doctor
```

**做完你会看到**：daemon 和 extension 都是 connected。只看到 9222 端口能访问不算，这里要看到扩展真的接上了。

然后开一张小红书页，看会不会被送去海外版——这一条同时验证了第 1 步的隧道和第 2 步的 PAC。`opencli browser <会话名> <动作>` 是 OpenCLI 直接操作一张页面的通用命令，`t` 是随便起的会话名，三条命令用同一个名字就是同一张页；`OPENCLI_BROWSER_IDLE_TIMEOUT` 是这张页空闲多少秒后自动回收：

```bash
OPENCLI_BROWSER_IDLE_TIMEOUT=120 opencli browser t open https://www.xiaohongshu.com/explore
opencli browser t get url
opencli browser t close
```

**做完你会看到**：`get url` 打印的仍然是 `www.xiaohongshu.com/...`，没有变成 `rednote.com`。变了就回第 1 步查出口。

## 5. 试一条真命令

还没登录也能先跑一下，看命令本身通不通：

```bash
CI=1 opencli xiaohongshu feed --limit 3 -f json
```

**做完你会看到**：要么是一个 JSON 数组、三条帖子（标题、作者、链接），要么是一句「需要登录」。两种都说明命令本身通了；没登录是下一步的事。

两个写法以后一直这样用：`CI=1` 让它别输出交互式的花哨东西，`-f json` 让输出是小机好解析的 JSON。

## 6. 别随手升级

`npm install -g @jackwener/opencli@latest` 会：①把我们家的命令目录清掉（入口脚本会补回，但新版本能不能跑这些命令，我们没试过）；②换掉扩展的匹配版本。登录态不受影响（在浏览器资料目录里）。想升就先在别的机器上试。

---

下一步：[登录](4-login.md)。
