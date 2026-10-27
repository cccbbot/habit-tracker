#!/usr/bin/env bash
# habit-tracker 服务器一次性初始化（在腾讯云服务器上以 root 或有 sudo 的账号执行）
# 用法：
#   sudo bash init-server.sh <DEPLOY_PATH> [DEPLOY_USER]
# 示例：
#   sudo bash init-server.sh /var/www/habit-tracker ubuntu
set -euo pipefail

DEPLOY_PATH="${1:-/var/www/habit-tracker}"
DEPLOY_USER="${2:-root}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_SRC="$SCRIPT_DIR/nginx-habit-tracker.conf"

echo "==> 安装 nginx（如未安装）"
if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx
  else
    echo "未检测到 apt/yum，请手动安装 nginx 后重试"; exit 1
  fi
fi

echo "==> 创建网站根目录：$DEPLOY_PATH"
mkdir -p "$DEPLOY_PATH"

echo "==> 写入 nginx 配置（替换 __DEPLOY_PATH__）"
sed -e "s|__DEPLOY_PATH__|$DEPLOY_PATH|g" "$CONF_SRC" > /etc/nginx/conf.d/habit-tracker.conf

# 避免与默认站点冲突
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
fi

echo "==> 校验并重载 nginx"
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> 设置目录归属给部署用户：$DEPLOY_USER"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_PATH"

echo
echo "DONE. 部署目录: $DEPLOY_PATH"
echo "GitHub Actions 会用 SERVER_SSH_KEY 以 $DEPLOY_USER 登录，并 rsync 同步静态文件到此目录。"
echo "请确保 $DEPLOY_USER 对该目录有写权限（本脚本已 chown）。"
