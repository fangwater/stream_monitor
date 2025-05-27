#!/bin/bash

# 确保以 root 权限运行
if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 或 root 用户运行此脚本！"
  exit 1
fi

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d "v" -f 2 | cut -d "." -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "错误：需要 Node.js 版本 20 或更高版本"
  echo "当前版本: $(node -v)"
  exit 1
fi

# 配置变量
SERVICE_NAME="monitor"                  # 服务名称
USER_NAME=$(logname)                    # 当前登录用户（非root）
WORKING_DIR=$(pwd)                      # 脚本所在目录
NODE_PATH=$(which node)                 # Node.js 路径
MONITOR_SCRIPT="monitor.js"             # 你的监控脚本
LOG_DIR="/var/log/$SERVICE_NAME"        # 日志目录
ARCHIVE_DIR="$WORKING_DIR/logs"         # 日志归档目录（改为当前目录下的logs文件夹）

# 创建必要的目录
mkdir -p "$LOG_DIR"
mkdir -p "$ARCHIVE_DIR"
chown -R "$USER_NAME":"$USER_NAME" "$LOG_DIR"
chown -R "$USER_NAME":"$USER_NAME" "$ARCHIVE_DIR"

# 安装依赖
echo "正在安装依赖..."
npm install ws express

# 创建日志管理脚本
LOG_MANAGER_SCRIPT="$WORKING_DIR/manage_logs.sh"
cat > "$LOG_MANAGER_SCRIPT" <<'EOF'
#!/bin/bash

LOG_DIR="/var/log/monitor"
ARCHIVE_DIR="$(pwd)/logs"

# 日志管理函数
manage_logs() {
    # 获取当前时间戳
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    
    # 检查是否存在旧的日志文件
    if [ -f "$LOG_DIR/output.log" ] || [ -f "$LOG_DIR/error.log" ]; then
        # 创建新的归档文件
        tar -czf "$ARCHIVE_DIR/logs_$TIMESTAMP.tar.gz" -C "$LOG_DIR" output.log error.log 2>/dev/null
        
        # 删除原始日志文件
        rm -f "$LOG_DIR/output.log" "$LOG_DIR/error.log"
        
        # 删除超过1天前的归档
        find "$ARCHIVE_DIR" -name "logs_*.tar.gz" -mtime +1 -delete
    fi
}

manage_logs
EOF

# 设置日志管理脚本权限
chmod +x "$LOG_MANAGER_SCRIPT"
chown "$USER_NAME":"$USER_NAME" "$LOG_MANAGER_SCRIPT"

# 创建定时重启服务
TIMER_NAME="${SERVICE_NAME}-restart"
TIMER_FILE="/etc/systemd/system/${TIMER_NAME}.timer"
TIMER_SERVICE_FILE="/etc/systemd/system/${TIMER_NAME}.service"

# 创建定时器服务文件
cat > "$TIMER_SERVICE_FILE" <<EOF
[Unit]
Description=Restart Monitor Service Daily

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ${SERVICE_NAME}.service
ExecStartPost=$LOG_MANAGER_SCRIPT
EOF

# 创建定时器文件
cat > "$TIMER_FILE" <<EOF
[Unit]
Description=Daily Monitor Service Restart Timer

[Timer]
OnCalendar=*-*-* 00:00:00
Unit=${TIMER_NAME}.service

[Install]
WantedBy=timers.target
EOF

# 设置权限
chmod 644 "$TIMER_FILE" "$TIMER_SERVICE_FILE"

# 创建 Systemd 服务文件
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Node.js Monitor Service
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$WORKING_DIR
ExecStart=$NODE_PATH $MONITOR_SCRIPT
ExecStartPre=$LOG_MANAGER_SCRIPT
Restart=always
RestartSec=5
StandardOutput=file:$LOG_DIR/output.log
StandardError=file:$LOG_DIR/error.log

[Install]
WantedBy=multi-user.target
EOF

# 设置权限
chmod 644 "$SERVICE_FILE"

# 重载 Systemd
systemctl daemon-reload

# 启用并启动服务和定时器
systemctl enable "$SERVICE_NAME"
systemctl enable "${TIMER_NAME}.timer"
systemctl start "${TIMER_NAME}.timer"
systemctl start "$SERVICE_NAME"

# 检查状态
echo -e "\n服务已部署！状态如下："
systemctl status "$SERVICE_NAME" --no-pager

# 输出日志路径
echo -e "\n日志文件："
echo "输出日志: $LOG_DIR/output.log"
echo "错误日志: $LOG_DIR/error.log"
echo "日志归档: $ARCHIVE_DIR"
echo -e "\n管理命令："
echo "启动服务: sudo systemctl start $SERVICE_NAME"
echo "停止服务: sudo systemctl stop $SERVICE_NAME"
echo "查看日志: sudo journalctl -u $SERVICE_NAME -f"
echo "查看定时器状态: sudo systemctl status ${TIMER_NAME}.timer"