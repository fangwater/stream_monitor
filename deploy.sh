#!/bin/bash

# 配置变量
SERVICE_NAME="monitor"                  # 服务名称
TIMER_NAME="${SERVICE_NAME}-restart"    # 定时器名称
USER_NAME=$(logname || echo $SUDO_USER || echo $USER)  # 获取实际用户名
WORKING_DIR=$(pwd)                      # 脚本所在目录
NODE_PATH=$(which node)                 # Node.js 路径
MONITOR_SCRIPT="monitor.js"             # 你的监控脚本
LOG_DIR="$WORKING_DIR"                  # 日志目录
ARCHIVE_DIR="$WORKING_DIR"              # 日志归档目录

# 错误处理函数
handle_error() {
    echo "错误: $1"
    exit 1
}

# 检查必要的命令
command -v node >/dev/null 2>&1 || handle_error "未找到 node 命令"
command -v npm >/dev/null 2>&1 || handle_error "未找到 npm 命令"
command -v systemctl >/dev/null 2>&1 || handle_error "未找到 systemctl 命令"

# 确保以 root 权限运行
if [ "$(id -u)" -ne 0 ]; then
    handle_error "请使用 sudo 或 root 用户运行此脚本"
fi

echo "开始部署监控服务..."
echo "用户: $USER_NAME"
echo "工作目录: $WORKING_DIR"
echo "Node路径: $NODE_PATH"

# 清理旧的服务和定时器
echo "清理旧的服务和定时器..."
systemctl stop $SERVICE_NAME 2>/dev/null || true
systemctl stop ${TIMER_NAME}.timer 2>/dev/null || true
systemctl disable $SERVICE_NAME 2>/dev/null || true
systemctl disable ${TIMER_NAME}.timer 2>/dev/null || true
rm -f /etc/systemd/system/${SERVICE_NAME}.service 2>/dev/null || true
rm -f /etc/systemd/system/${TIMER_NAME}.service 2>/dev/null || true
rm -f /etc/systemd/system/${TIMER_NAME}.timer 2>/dev/null || true

echo "重新加载 systemd 配置..."
systemctl daemon-reload || handle_error "重新加载 systemd 配置失败"

# 创建必要的目录
echo "创建必要的目录..."
mkdir -p "$LOG_DIR" || handle_error "创建日志目录失败"
mkdir -p "$ARCHIVE_DIR" || handle_error "创建归档目录失败"
chown -R "$USER_NAME":"$USER_NAME" "$LOG_DIR" || handle_error "设置日志目录权限失败"
chown -R "$USER_NAME":"$USER_NAME" "$ARCHIVE_DIR" || handle_error "设置归档目录权限失败"

# 创建日志管理脚本
echo "创建日志管理脚本..."
LOG_MANAGER_SCRIPT="$WORKING_DIR/manage_logs.sh"
cat > "$LOG_MANAGER_SCRIPT" <<EOF || handle_error "创建日志管理脚本失败"
#!/bin/bash

WORKING_DIR="$WORKING_DIR"
LOG_DIR="\$WORKING_DIR"
ARCHIVE_DIR="\$WORKING_DIR"

# 日志管理函数
manage_logs() {
    # 获取当前时间戳
    TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
    
    # 检查是否存在旧的日志文件
    if [ -f "\$LOG_DIR/output.log" ] || [ -f "\$LOG_DIR/error.log" ]; then
        # 删除之前的归档文件（保留最新的一个）
        LATEST_ARCHIVE=\$(ls -t \$ARCHIVE_DIR/logs_*.tar.gz 2>/dev/null | head -n1)
        if [ -n "\$LATEST_ARCHIVE" ]; then
            # 删除除了最新的归档外的所有归档
            ls -t \$ARCHIVE_DIR/logs_*.tar.gz | tail -n +2 | xargs rm -f 2>/dev/null
        fi
        
        # 创建新的归档文件
        tar -czf "\$ARCHIVE_DIR/logs_\$TIMESTAMP.tar.gz" -C "\$LOG_DIR" output.log error.log 2>/dev/null
        
        # 删除原始日志文件
        rm -f "\$LOG_DIR/output.log" "\$LOG_DIR/error.log"
    fi
}

manage_logs
EOF

# 设置日志管理脚本权限
echo "设置脚本权限..."
chmod +x "$LOG_MANAGER_SCRIPT" || handle_error "设置日志管理脚本权限失败"
chown "$USER_NAME":"$USER_NAME" "$LOG_MANAGER_SCRIPT" || handle_error "设置日志管理脚本所有者失败"

# 创建定时器服务文件
echo "创建定时器服务文件..."
cat > "/etc/systemd/system/${TIMER_NAME}.service" <<EOF || handle_error "创建定时器服务文件失败"
[Unit]
Description=Restart Monitor Service Daily

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ${SERVICE_NAME}.service
ExecStartPost=$LOG_MANAGER_SCRIPT

[Install]
WantedBy=multi-user.target
EOF

# 创建定时器文件
echo "创建定时器文件..."
cat > "/etc/systemd/system/${TIMER_NAME}.timer" <<EOF || handle_error "创建定时器文件失败"
[Unit]
Description=Daily Monitor Service Restart Timer

[Timer]
OnCalendar=*-*-* 00:00:00
Unit=${TIMER_NAME}.service

[Install]
WantedBy=timers.target
EOF

# 创建服务文件
echo "创建服务文件..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF || handle_error "创建服务文件失败"
[Unit]
Description=Node.js Monitor Service
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$WORKING_DIR
Environment="NODE_OPTIONS=--max-old-space-size=2048"
ExecStart=$NODE_PATH $MONITOR_SCRIPT >> $LOG_DIR/output.log 2>> $LOG_DIR/error.log
ExecStartPre=$LOG_MANAGER_SCRIPT
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

[Install]
WantedBy=multi-user.target
EOF

# 设置文件权限
echo "设置服务文件权限..."
chmod 644 "/etc/systemd/system/${SERVICE_NAME}.service" || handle_error "设置服务文件权限失败"
chmod 644 "/etc/systemd/system/${TIMER_NAME}.service" || handle_error "设置定时器服务文件权限失败"
chmod 644 "/etc/systemd/system/${TIMER_NAME}.timer" || handle_error "设置定时器文件权限失败"

# 重新加载 systemd
echo "重新加载 systemd 配置..."
systemctl daemon-reload || handle_error "重新加载 systemd 配置失败"

# 启用并启动服务和定时器
echo "启用并启动服务和定时器..."
systemctl enable "$SERVICE_NAME" || handle_error "启用服务失败"
systemctl enable "${TIMER_NAME}.timer" || handle_error "启用定时器失败"
systemctl start "${TIMER_NAME}.timer" || handle_error "启动定时器失败"
systemctl start "$SERVICE_NAME" || handle_error "启动服务失败"

# 检查状态
echo -e "\n服务状态："
systemctl status "$SERVICE_NAME" --no-pager
echo -e "\n定时器状态："
systemctl status "${TIMER_NAME}.timer" --no-pager

# 输出信息
echo -e "\n日志文件："
echo "输出日志: $LOG_DIR/output.log"
echo "错误日志: $LOG_DIR/error.log"
echo "日志归档: $ARCHIVE_DIR"
echo -e "\n管理命令："
echo "启动服务: sudo systemctl start $SERVICE_NAME"
echo "停止服务: sudo systemctl stop $SERVICE_NAME"
echo "查看日志: sudo journalctl -u $SERVICE_NAME -f"
echo "查看定时器状态: sudo systemctl status ${TIMER_NAME}.timer"