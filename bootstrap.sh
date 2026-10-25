#!/usr/bin/env bash
#
# bootstrap.sh — 在全新的阿里云轻量应用服务器上把 PIA 跑起来。
#
# 目标：一条命令、幂等、失败即停。假设：
#   · Ubuntu 22.04/24.04（阿里云轻量默认镜像）
#   · 已把本仓库放到 /tmp/pa-src（scp / git clone 均可）
#
# 它做五件事：建用户与目录 → 装 Node → 装代码 → 生成令牌并装服务 → 初始化工作区。
# 不做的事：装 Nginx 证书（见 docs/11 §5）、备案、开安全组（控制台操作）。
#
set -euo pipefail

SRC="${SRC:-/tmp/pa-src}"
APP_DIR="/opt/pa"
DATA_DIR="/var/lib/pa"
CONF_DIR="/etc/pa"
SERVICE_USER="pa"
NODE_MAJOR_MIN=22

log() { printf '\033[1;36m[pa]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[pa] 失败:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（或 sudo bash deploy/bootstrap.sh）"
[[ -d "$SRC/packages/personal" ]] || die "找不到源码：$SRC/packages/personal（用 SRC=... 指定）"

# ── 1. 用户与目录 ────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "创建系统用户 $SERVICE_USER"
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/ws" "$DATA_DIR/home"
install -d -m 0750 "$CONF_DIR"

# ── 2. Node ──────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -p 'process.versions.node')"
else
  NODE_VER="0.0.0"
fi
NODE_MAJOR="${NODE_VER%%.*}"
if (( NODE_MAJOR < NODE_MAJOR_MIN )); then
  log "安装 Node 22（当前 ${NODE_VER}）"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  NODE_VER="$(node -p 'process.versions.node')"
fi
log "Node 版本：$NODE_VER"
(( ${NODE_VER%%.*} >= NODE_MAJOR_MIN )) || die "Node 版本不足，需要 >= ${NODE_MAJOR_MIN}"

# ── 3. 代码 ──────────────────────────────────────────────────────────────
log "同步代码到 $APP_DIR"
install -d -m 0755 "$APP_DIR"
rsync -a --delete \
  --exclude '.tmp' --exclude 'node_modules' --exclude '.git' \
  "$SRC/" "$APP_DIR/"

# ── 4. 令牌 + systemd ────────────────────────────────────────────────────
if [[ ! -f "$CONF_DIR/pa.env" ]]; then
  TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
  umask 077
  printf 'PA_TOKEN=%s\n' "$TOKEN" > "$CONF_DIR/pa.env"
  umask 022
  log "已生成访问令牌（只显示这一次）：$TOKEN"
else
  log "沿用已有令牌：$CONF_DIR/pa.env"
fi
chown root:"$SERVICE_USER" "$CONF_DIR/pa.env"
chmod 0640 "$CONF_DIR/pa.env"

install -m 0644 "$APP_DIR/deploy/systemd/pa.service" /etc/systemd/system/pa.service
systemctl daemon-reload
systemctl enable pa.service >/dev/null

# ── 5. 初始化工作区 ──────────────────────────────────────────────────────
if [[ ! -f "$DATA_DIR/ws/.pi/pa-profile.json" ]]; then
  log "初始化个人工作区"
  sudo -u "$SERVICE_USER" env HOME="$DATA_DIR" \
    node "$APP_DIR/packages/personal/bin/pa-init.mjs" "$DATA_DIR/ws" --persona-name "随身" >/dev/null
else
  log "工作区已初始化，跳过"
fi

systemctl restart pa.service
sleep 1

# ── 6. 冒烟 ──────────────────────────────────────────────────────────────
if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
  log "健康检查通过：http://127.0.0.1:8787/healthz"
else
  die "服务未起来，查看：journalctl -u pa -n 80 --no-pager"
fi

cat <<'EOF'

下一步：
  1) 配 Nginx（deploy/nginx/pa.conf）并申请证书（docs/11 §5）
  2) 安全组只放 22/80/443；8787 不要对公网开放
  3) 浏览器打开 https://<你的域名>/，粘贴上面的令牌

常用命令：
  systemctl status pa
  journalctl -u pa -f
  node /opt/pa/deploy/budget-check.mjs
EOF
