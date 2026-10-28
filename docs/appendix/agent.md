# 附录 · 用 browser 命令接着操作这张页面（通用做法）

> 📎 **通用做法，我们家没在用**：这篇是 Chatty 最早整理的通用写法，跟我们家日用的那套不一样，也没在全新环境里从头到尾跑通过，留给想自己折腾的人参考。照我们家的做法搭，请回[首页](../../README.md)。

网络出口、浏览器、操作工具是三层东西。让 chisel 通了，只完成了第一层；让 agent 每次接着使用同一张页面，还要明确第三层的使用方式。

## OpenCLI：使用公开版可复现的接口

以下命令按 **OpenCLI 2.0.2** 的官方源码核对。这个版本需要 Node.js ≥20.18.1；对应源码中的 Browser Bridge 版本为 1.0.26。安装扩展与连接方法以[该版本官方指南](https://github.com/jackwener/OpenCLI/blob/v2.0.2/docs/guide/browser-bridge.md)为准。

在服务器上安装 CLI，扩展装进前一篇创建的那个浏览器资料目录。若已完成[无头浏览器搭建](headless-browser.md)，沿用那里的安装与连接即可：

```bash
node --version
npm install -g @jackwener/opencli@2.0.2
opencli --version
opencli doctor
```

CLI、daemon、扩展应连接到同一套浏览器。这里固定版本是为了让命令能和文档对上，**未在本仓库中重新安装并运行整套 2.0.2 浏览器环境**；首次使用请跑通下面几步再扩大任务。

## 1. 手动打开并绑定

在云端 Chrome 中手动打开小红书、完成登录，**把这张标签页切到前台**。然后在服务器终端执行：

```bash
opencli browser --session xhs bind
opencli browser --session xhs get url
opencli browser --session xhs state
```

`bind` 绑定最后聚焦窗口里的活动标签，因此读回 URL 和页面内容很重要：确认绑的是小红书，才让 agent 继续操作。

这种 **bound** 会话使用用户已经打开的标签，扩展不为它设置普通 owned 会话的闲置回收计时。手动关页、浏览器重启仍会让它失效；连接状态丢失时重新确认页面并绑定。依据：[Bridge 生命周期实现](https://github.com/jackwener/OpenCLI/blob/v2.0.2/extension/src/background.ts#L429)。

另一种写法 `opencli browser --session xhs open <网址>` 会导航 / 新建工具管理的页面，不能直接当成同一种长期绑定方案；该版本的普通 owned 会话有默认闲置回收。

## 2. 从当前页面选目标，再执行一个动作

让 agent 先读 `state`。假设**刚刚那次输出**里要点的帖子编号是 `12`，才执行：

```bash
opencli browser --session xhs click 12
opencli browser --session xhs state
```

`12` 是示意值，不能原样反复点击。页面变化后重新取状态，再选下一步目标。搜索则从当前页定位输入框，使用该版本的 `fill` / `type` 和 `click` 命令；具体参数用对应命令的 `--help` 查。

日常采用 **读取当前页 → 一个动作 → 核对新内容** 的循环。整个过程都用 `--session xhs`，不在每个动作前再执行 `open`。

需要解除工具对页面的绑定时：

```bash
opencli browser --session xhs unbind
```

`unbind` 保留用户原有的标签页。准确命令接口见 [v2.0.2 browser 命令源码](https://github.com/jackwener/OpenCLI/blob/v2.0.2/src/commands/browser.ts#L573)。

## 3. 站点适配器是另一条路

`opencli xiaohongshu ... --site-session persistent` 可以让适配器复用站点会话，但**不能阻止适配器内部调用 `page.goto()` 重新导航**。`goto()` 本身仍会发起导航，见 [Page 实现](https://github.com/jackwener/OpenCLI/blob/v2.0.2/src/browser/page.ts#L92)。

也不能认为绑定了 `browser --session xhs` 以后，普通 `opencli xiaohongshu ...` 命令就自动使用那张绑定页：browser 会话和 adapter 会话是不同的入口。

我们日用的适配器额外实现了页面健康检查、页内操作、内容核对和任务排队。这些是本地定制，**本仓库没有发布它们，也不把它们说成安装公开版后自动拥有的能力**。

本教程可直接采用前面“绑定现有页面 + browser 命令点击和读取”的路线。如果你想改造站点适配器，需要另外确认它的实际导航行为。

## 4. 多个任务共用页面时排队

即使都是“只读”任务，也可能相互影响：A 在读一篇帖子，B 搜索了别的东西，A 下一步就可能读到 B 的结果。

同一张常驻页一次交给一个任务。使用自己的任务队列或进程锁，让锁覆盖**读状态、点击、等待、核对和提取**的完整过程。只给每条命令分别上锁，仍然可能在两条命令之间串页。

## 给 agent 的运行约定

下面这段可以放入自己的浏览器使用说明：

> 访问小红书时，先获取这张常驻页面的独占使用权。读取真实页面位置、登录状态和可见内容。页面正常则在同一个绑定会话里操作，不为每个动作重新打开网址。需要搜索或进入帖子时，使用当前页面可见控件；页面变化后重新读取状态，核对关键词、作者、标题或帖子编号，确认读的是本次目标。页面失效时检查国内出口，重新打开主站，必要时请我完成登录，然后重新绑定。结束任务时释放独占权，保留标签页。维护清理任务保留此页；浏览器重启后重新建立会话。告诉我此次是复用页面还是重新打开，发生失败时报告具体停在哪一步。

这段约定只安排浏览。发布、评论、点赞等动作是否执行，由使用者另行交代。
