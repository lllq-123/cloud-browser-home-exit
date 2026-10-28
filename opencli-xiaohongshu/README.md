# opencli-xiaohongshu

我们家日常在用的一套小红书 [OpenCLI](https://github.com/jackwener/opencli) 命令：自己写的 `comment`（发评论 / 回复指定评论）、`mentions`（读「评论和@」通知），加上为了「常驻页」改过的官方命令（`feed`、`search`、`note`、`comments`、`download`、`publish` 等）。哪些是自己写的、哪些改自官方、改了什么，见 [NOTICE.md](NOTICE.md)。

只在 OpenCLI **1.8.7** 上用过，别的版本没试过。

## 怎么装

1. `~/.opencli/node_modules/@jackwener/opencli` 必须是指向全局 OpenCLI 包的软链（这些命令文件里的 `import '@jackwener/opencli/…'` 要靠它找到官方包）：

   ```bash
   mkdir -p ~/.opencli/node_modules/@jackwener && ln -sfn "$(npm root -g)/@jackwener/opencli" ~/.opencli/node_modules/@jackwener/opencli
   ```

2. 在本目录跑：

   ```bash
   bash install.sh
   ```

   它把本目录的 `*.js` 复制到 `~/.opencli/clis/xiaohongshu/`，最后跑一次 `CI=1 opencli xiaohongshu comment --help` 看命令认不认；加 `--no-verify` 跳过这一步。

## 升级 OpenCLI 之后

升级 OpenCLI 会清掉 `~/.opencli/clis/xiaohongshu/`，要重跑 `bash install.sh`（用 [`examples/opencli/opencli`](../examples/opencli/opencli) 这个入口脚本的话，它会自动补）。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。
