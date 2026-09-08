#!/usr/bin/env bash
set -euo pipefail

echo "=== OpenLeaf ==="
du -sh /mnt/c/Users/yinzh/Projects/OpenLeaf
ls /mnt/c/Users/yinzh/Projects/OpenLeaf | head -30
if [ -d /mnt/c/Users/yinzh/Projects/OpenLeaf/.git ]; then
  git -C /mnt/c/Users/yinzh/Projects/OpenLeaf rev-parse --is-inside-work-tree 2>/dev/null || echo "git metadata present but may be broken on /mnt/c"
  git -C /mnt/c/Users/yinzh/Projects/OpenLeaf remote -v 2>/dev/null || true
  git -C /mnt/c/Users/yinzh/Projects/OpenLeaf status -sb 2>/dev/null || true
fi

echo
echo "=== NeoTODO windows git ==="
git -C /mnt/c/Users/yinzh/Projects/NeoTODO status -sb 2>/dev/null || echo "windows git status failed"
echo
echo "=== NeoTODO linux git ==="
git -C /home/yinzh/Projects/NeoTODO status -sb 2>/dev/null || echo "linux git status failed"
git -C /home/yinzh/Projects/NeoTODO remote -v 2>/dev/null || true
