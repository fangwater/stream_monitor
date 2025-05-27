#!/bin/bash

# 确保脚本在出错时退出
set -e

# 日志文件
LOG_FILE="monitor.log"


echo "启动监控服务器..."
# 使用nohup运行node monitor.js，并重定向标准输出和标准错误到日志文件
nohup node monitor.js >> "$LOG_FILE" 2>&1 &