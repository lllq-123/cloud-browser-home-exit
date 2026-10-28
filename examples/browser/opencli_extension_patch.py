#!/usr/bin/env python3
"""给官方 OpenCLI 扩展 1.0.26 添加前台交互标签激活补丁。

显式指定 background.js 的输入和输出；本脚本不下载、不重启、不自动部署。
仅接受固定的官方原始字节或本补丁的完整结果；未知基线直接报错。
示例：python3 opencli_extension_patch.py --input 官方/dist/background.js \
    --output 暂存/dist/background.js
输出目录须已存在；输入输出可以相同，写入以原子替换完成。
"""

import argparse
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile


OFFICIAL_SHA256 = "3a8ce85002e7a993227cb942105ec3f20ddd688a7a53f861855479db8e17b5f7"
ANCHOR = b'''  const sessionWindowId = group?.windowId ?? tab.windowId;
  if (tab.windowId !== sessionWindowId) tab = await chrome.tabs.get(tabId);
  setLeaseSession(leaseKey, {
'''
ACTIVATION = b'''  if (role === "interactive" && getWindowMode(leaseKey) === "foreground") {
    await chrome.tabs.update(tabId, { active: true });
  }
'''
PATCHED_ANCHOR = ANCHOR.replace(b"  setLeaseSession", ACTIVATION + b"  setLeaseSession")


def patch_background(source: bytes) -> bytes:
    """校验完整基线后补丁；已经补过的相同字节直接返回。"""
    if hashlib.sha256(source).hexdigest() == OFFICIAL_SHA256:
        if source.count(ANCHOR) != 1:
            raise ValueError("官方基线中的补丁锚点不唯一，已停止")
        return source.replace(ANCHOR, PATCHED_ANCHOR, 1)
    if source.count(PATCHED_ANCHOR) == 1:
        restored = source.replace(PATCHED_ANCHOR, ANCHOR, 1)
        if hashlib.sha256(restored).hexdigest() == OFFICIAL_SHA256:
            return source
    raise ValueError("未知 background.js 基线：仅接受固定官方 SHA256 或本补丁完整结果")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="输入 background.js 路径")
    parser.add_argument("--output", required=True, type=Path, help="输出 background.js 路径")
    args = parser.parse_args()
    temporary = None
    try:
        source = args.input.read_bytes()
        patched = patch_background(source)
        if args.input.resolve() != args.output.resolve() or source != patched:
            with tempfile.NamedTemporaryFile(
                prefix=f".{args.output.name}.", dir=args.output.parent, delete=False
            ) as stream:
                temporary = Path(stream.name)
                stream.write(patched)
                os.fchmod(stream.fileno(), stat.S_IMODE(args.input.stat().st_mode))
            os.replace(temporary, args.output)
            temporary = None
        status = "已补丁（幂等）" if source == patched else "已添加前台交互标签激活补丁"
        print(f"{status}：{args.output}\nSHA256 {hashlib.sha256(patched).hexdigest()}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"补丁失败：{exc}", file=sys.stderr)
        return 1
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
