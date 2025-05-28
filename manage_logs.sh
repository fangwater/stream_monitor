#!/bin/bash

WORKING_DIR="/root/project/stream_monitor"
LOG_DIR="$WORKING_DIR"
ARCHIVE_DIR="$WORKING_DIR"

# 日志管理函数
manage_logs() {
    # 获取当前时间戳
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    
    # 检查是否存在旧的日志文件
    if [ -f "$LOG_DIR/output.log" ] || [ -f "$LOG_DIR/error.log" ]; then
        # 删除之前的归档文件（保留最新的一个）
        LATEST_ARCHIVE=$(ls -t $ARCHIVE_DIR/logs_*.tar.gz 2>/dev/null | head -n1)
        if [ -n "$LATEST_ARCHIVE" ]; then
            # 删除除了最新的归档外的所有归档
            ls -t $ARCHIVE_DIR/logs_*.tar.gz | tail -n +2 | xargs rm -f 2>/dev/null
        fi
        
        # 创建新的归档文件
        tar -czf "$ARCHIVE_DIR/logs_$TIMESTAMP.tar.gz" -C "$LOG_DIR" output.log error.log 2>/dev/null
        
        # 删除原始日志文件
        rm -f "$LOG_DIR/output.log" "$LOG_DIR/error.log"
    fi
}

manage_logs
