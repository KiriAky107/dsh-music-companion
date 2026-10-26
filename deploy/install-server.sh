#!/usr/bin/env bash
# 在服务器上安装并启动 music-hub（幂等，可重复跑）
#
#   bash install-server.sh
#
# 假设代码已经在 /opt/music-companion，node 在 /usr/local/bin/node。

set -euo pipefail

APP_DIR=/opt/music-companion
NODE_BIN=/usr/local/bin/node
TOKEN_FILE="$APP_DIR/hub-token"
ENV_FILE=/etc/music-hub.env

echo "==> 1/5 目录与依赖"
mkdir -p "$APP_DIR/data"
cd "$APP_DIR/packages/mcp-music"
npm install --omit=dev --no-audit --no-fund

echo "==> 2/5 生成 token（已存在则保留）"
if [ ! -s "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "    已生成新 token"
else
  echo "    复用已有 token"
fi

echo "==> 3/5 写环境文件"
cat > "$ENV_FILE" <<ENV
MUSIC_HUB_TOKEN=$(cat "$TOKEN_FILE")
ENV
chmod 600 "$ENV_FILE"

echo "==> 4/5 写 systemd unit"
cat > /etc/systemd/system/music-hub.service <<UNIT
[Unit]
Description=music-hub for dsh-music-companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=MUSIC_HUB_PORT=8787
Environment=MUSIC_HUB_HOST=0.0.0.0
Environment=MUSIC_HUB_DATA=$APP_DIR/data
Environment=TZ=Asia/Shanghai
ExecStart=$NODE_BIN $APP_DIR/packages/music-hub/src/hub.mjs
Restart=always
RestartSec=5
StandardOutput=append:/var/log/music-hub.log
StandardError=append:/var/log/music-hub.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable music-hub >/dev/null

echo "==> 5/5 启动并自检"
systemctl restart music-hub
sleep 2
systemctl is-active music-hub

echo
echo "--- health ---"
curl -sf "http://127.0.0.1:8787/health" || echo "health 失败，看 /var/log/music-hub.log"
echo
echo "--- token（桌面端 watcher 要填这个）---"
cat "$TOKEN_FILE"
echo
echo
echo "--- 监听 ---"
ss -lntp | grep 8787 || true
