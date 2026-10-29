# NOTICE

本目录的 20 个文件（13 条命令 + 7 个它们共用的辅助文件）分三类。每个文件第一行都加了一行中文说明，写明它属于哪一类、按什么许可证公开。

OpenCLI（<https://github.com/jackwener/opencli>，npm 包 `@jackwener/opencli`）按 Apache License 2.0 发布。本目录的 [LICENSE](LICENSE) 是 OpenCLI 1.8.7 包里 LICENSE 的原样副本，末尾的版权行是 OpenCLI 作者的；我们自己写的文件（下面「我们家自己写的」那 5 个）版权归本仓库作者（落落、Claude、Chatty），也按同一份 Apache License 2.0 公开。

对照基准：OpenCLI 1.8.7 包里 `clis/xiaohongshu/` 下的同名文件。

## 我们家自己写的（5 个）

| 文件 | 是什么 |
|---|---|
| `comment.js` | 发评论；`--reply-to <评论ID>` 回复指定的某条评论。在常驻页里页内打开帖子、填字发送，再核对发送回执。 |
| `mentions.js` | 读「评论和@」通知，保留用户 ID / 帖子 ID / xsec_token / 评论 ID（官方 `notifications` 的输出里没有这些）。 |
| `notification-helpers.js` | 通知页工具：从首页点进通知页、切回「评论和@」那一栏。 |
| `resident-helpers.js` | 常驻页工具：判断常驻页能不能接着用、页内回首页、页内打开帖子 / 搜索 / 刷新推荐，往 stderr 报这轮用没用上常驻页。 |
| `short-link.js` | App 分享短链（xhslink.com / xhslink.cn）：不开网页，只问短链跳去哪个帖子。 |

## 改自官方 1.8.7（9 个）

| 文件 | 改了什么 |
|---|---|
| `collection-helpers.js` | 登录墙判断放宽：已登录、或页面上已经有笔记卡片时，不再因为页面文字里有「登录后」之类的字就判成没登录。 |
| `comments.js` | 整页打开帖子改成在常驻页里页内打开（打不开才整页打开）；加了 `--timeout`（默认 120 秒）；安全限制 / 登录墙改用 `note-helpers.js` 的 `inspectNoteAccess` 判断；滚动、展开回复、取数拆成由 node 一步一步驱动的短脚本（页面里不等待；已经在底时先往上挪一下再滚到底；有评论区滚动层就只滚它，不滚后面的首页），滚动和展开各按 `--timeout` 的一定比例截止；只有图片、没有文字的评论不占 `--limit` 的名额；滚不出更多或时间到了还没拿够，stderr 写一行 `[xhs-comments] short: …`。 |
| `download.js` | 整页打开帖子改成常驻页页内打开；App 分享短链先只问跳转地址（`short-link.js`），不整页打开；页内打开时只在帖子详情弹层里找图片和视频，免得拿到常驻页上别的帖子的；加了 `--timeout`（默认 120 秒）。 |
| `draft-utils.js` | 草稿列表的正文和更新时间先读小红书现在用的字段（`draftStore.desc`、`timeStamp`），读不到再用官方原来的字段。 |
| `feed.js` | 整页打开首页改成在常驻页里页内点「刷新」、从 store 取数，`--limit` 超出时页内往下滚；页内不成才照官方原来的做法整页打开 `/explore`。参数和输出跟官方一样。 |
| `note-helpers.js` | 短链识别加上 `xhslink.cn`，并导出 `isShortLink`；新增 `inspectNoteAccess`：先确认帖子真的加载出来，再认安全限制 / 登录墙 / 帖子不存在，免得正文里出现这些字被误判。 |
| `note.js` | 整页打开帖子改成常驻页页内打开（打不开才整页打开）；加了 `--timeout`（默认 120 秒）；访问状态改用 `inspectNoteAccess` 判断。 |
| `publish.js` | 加了 `--emojis`（按名字精确选站内表情）；话题改成等候选出来、名字一字不差才按话题编号点选，点完读回核对，对不上就报错并列出看到的候选，不会带着普通 `#文字` 发出去；开始写话题时那下回车改发带 keyCode 13 的按键（官方 `pressKey` 发出去 keyCode 是 0，网站不认）；发布页加载最多等 30 秒，没加载出来就报错，不把空白页当成图文入口。 |
| `search.js` | 整页打开搜索页改成在常驻页里页内搜索、从 store 取数，`--limit` 超出时页内往下滚；页内搜不成才照官方原来的做法整页打开搜索页读 DOM。参数和输出跟官方一样。 |

## 与官方 1.8.7 相同（6 个）

放在这里是为了覆盖目录完整。除第一行的来源说明外，和官方原文逐字节相同。

| 文件 |
|---|
| `draft-delete.js` |
| `draft-open.js` |
| `drafts.js` |
| `liked.js` |
| `saved.js` |
| `user-helpers.js` |
