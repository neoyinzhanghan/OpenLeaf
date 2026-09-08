#!/usr/bin/env bash
set -euo pipefail

echo "=== Windows Projects (/mnt/c) ==="
ls -la /mnt/c/Users/yinzh/Projects

echo
echo "=== Linux Projects (~/Projects) ==="
mkdir -p /home/yinzh/Projects
ls -la /home/yinzh/Projects
