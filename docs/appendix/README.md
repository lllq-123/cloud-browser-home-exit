# 附录：通用做法（我们家没在用）

这里是 Chatty 最早整理的一版**通用写法**，想照着我们家的做法搭，请回[首页](../../README.md)，这里可以不看。

它和我们家日用的不一样：安卓走免 Root 的 Termux、浏览器用 Playwright 新下载的 Chrome、OpenCLI 用 2.0.2、靠 `browser bind` / `click` 一下一下点页面、远程登录走 SSH 转发和开发者工具。这些都**没在全新环境里从头到尾跑通过**，留给想自己折腾的人参考；当时做过哪些检查，见 [verification.md](verification.md)。

| 篇 | 讲什么 |
|---|---|
| [tunnel.md](tunnel.md) | 两台 Linux 之间搭 chisel 反向 SOCKS（带固定密钥、指纹校验和收窄的认证规则） |
| [android.md](android.md) | 安卓免 Root 的 Termux 路线（没实测） |
| [headless-browser.md](headless-browser.md) | 用 Playwright 1.64.1 装 Chrome 156、新无头模式、远程可视登录、屏幕 / 语言 / UA 检查 |
| [browser.md](browser.md) | 最小 PAC、常驻页的原理和怎么证明它减少了对手机的依赖 |
| [agent.md](agent.md) | OpenCLI 2.0.2 的 `browser --session` 绑定和点击路线 |
| [verification.md](verification.md) | 这套通用做法当时做过的检查（含 Chrome 156 的隔离实测）和没做的部分 |

配套示例在 [examples/appendix/](../../examples/appendix/)。
