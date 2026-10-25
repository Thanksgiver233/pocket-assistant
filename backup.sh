#!/usr/bin/env bash
#
# backup.sh — 每日把「机器级授权 + 工作区状态」打包上传 OSS，并清理过期备份。
#
# 为什么只备份这两处：
#   /var/lib/pa/home/.pi/pa    grants.json + vault.enc（丢了就要重新授权）
#   /var/lib/pa/ws/.pi         profile（策略）+ pa-state（journal/audit/memory）
# 备份不含任何 OSS 凭证；凭证由 ossutil 的配置文件提供（root 0600）。
#
# 用法（root crontab）：
#   15 3 * * * /opt/pa/deploy/backup.sh >> /var/log/pa-backup.log 2>&1
#
set -euo pipefail

DATA_DIR="/var/lib/pa"
BUCKET="${PA_BUCKET:-oss://pa-backup-REPLACE-ME}"
KEEP_DAYS="${PA_BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ossutil >/dev/null 2>&1 || { echo "缺少 ossutil，见 docs/11 §6" >&2; exit 1; }

# 1. 打包（不跟随符号链接，避免把别处的密钥带进来）
tar -czf "$WORK/pa-$STAMP.tar.gz" -C "$DATA_DIR" \
  --exclude='*.sock' \
  --exclude='*.log' \
  home/.pi/pa \
  ws/.pi

# 2. 本地校验：能解开才算备份成功
tar -tzf "$WORK/pa-$STAMP.tar.gz" >/dev/null

# 3. 上传
ossutil cp -f "$WORK/pa-$STAMP.tar.gz" "$BUCKET/daily/pa-$STAMP.tar.gz" >/dev/null

# 4. 清理：先删远端，再删本地（本地只保留 3 份）
CUTOFF="$(date -d "-${KEEP_DAYS} days" +%Y%m%d)"
ossutil ls "$BUCKET/daily/" | awk '{print $NF}' | grep -E 'pa-[0-9]{8}-' | while read -r key; do
  day="$(basename "$key" | sed -E 's/pa-([0-9]{8})-.*/\1/')"
  [[ "$day" < "$CUTOFF" ]] && ossutil rm -f "$key" >/dev/null || true
done

ls -1t /var/backups/pa-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
install -d -m 0700 /var/backups
cp "$WORK/pa-$STAMP.tar.gz" "/var/backups/pa-$STAMP.tar.gz"

echo "[pa-backup] ok $STAMP $(du -h "$WORK/pa-$STAMP.tar.gz" | cut -f1)"
