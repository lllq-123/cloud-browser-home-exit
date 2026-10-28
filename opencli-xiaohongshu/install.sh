#!/usr/bin/env bash
# 把本目录的小红书自定义 opencli 命令（*.js，连同 LICENSE / NOTICE.md）装到 ~/.opencli/clis/xiaohongshu/。
# 触发场景：第一次装，以及每次 opencli 升级(npm install -g)后都要跑 —— 不是"万一丢了"，是必丢。
# 用法：bash install.sh
# 原理：运行位 ~/.opencli/clis/ 保不住——upstream postinstall 的 scripts/fetch-adapters.js
#       把它当"稀疏覆盖层"，凡官方 adapter 有更新的站点就整个 rmSync 删掉(不查 eject 标记)。
#       本脚本从本目录重新装回去。(升级到 OpenCLI 1.8.6 时实测确认过)
# 参数：--no-verify 跳过末尾的 opencli 验证（入口脚本自愈时用，避免绕回来再起一个 node）
set -euo pipefail
VERIFY=1
[ "${1:-}" = "--no-verify" ] && VERIFY=0
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.opencli/clis/xiaohongshu"
sources=("$SRC"/*.js)
if [ ! -f "${sources[0]}" ]; then
  echo "❌ $SRC 里没有 .js 文件，什么都没装" >&2
  exit 1
fi
mkdir -p "$DEST"
cp "${sources[@]}" "$DEST/"
# 许可证和修改说明也带上：命令文件头的注释指向它们（OpenCLI 只加载 .js，多放这两个不影响）
for f in LICENSE NOTICE.md; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$DEST/"; fi
done
echo "✅ 已安装 xiaohongshu/: $(ls "$SRC"/*.js | xargs -n1 basename | tr '\n' ' ')"
if [ "$VERIFY" = "1" ]; then
  echo "验证自定义命令："
  CI=1 opencli xiaohongshu comment --help 2>&1 | head -3 || echo "（opencli 不在 PATH，请手动验证）"
fi
