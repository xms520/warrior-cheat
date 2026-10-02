#!/bin/sh
# 推送工程到 GitHub（不打印 token）
set -e
cd /var/minis/workspace/warrior/proj
TOKEN=$(gh auth token)
git config user.email "xms520@users.noreply.github.com" >/dev/null 2>&1 || true
git config user.name "xms520" >/dev/null 2>&1 || true
if ! git remote | grep -q origin; then
  git remote add origin "https://x-access-token:${TOKEN}@github.com/xms520/warrior-cheat.git"
else
  git remote set-url origin "https://x-access-token:${TOKEN}@github.com/xms520/warrior-cheat.git"
fi
git checkout -B main >/dev/null 2>&1 || true
git add -A
git commit -m "$1" >/dev/null 2>&1 || echo "(nothing to commit)"
git push -u origin main 2>&1 | tail -5
