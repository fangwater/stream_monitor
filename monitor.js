const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const HTTP_PORT = 3000;
const WS_PORT = 3001;
const MAX_WS_CONNECTIONS = 10; // 最大WebSocket连接数限制

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'history.json');
const LOG_DIR = path.join(__dirname, 'data', 'logs');

// 确保数据目录和日志目录存在
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

// 创建新的日志文件，使用日期作为文件名
const currentDate = new Date().toISOString().split('T')[0];
const LOG_FILE = path.join(LOG_DIR, `metrics_${currentDate}.log`);

// 获取本机IP地址
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳过内部IP和非IPv4地址
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0'; // 如果找不到合适的IP，监听所有接口
}

const localIP = getLocalIP();
console.log(`本机IP地址: ${localIP}`);

// 循环缓冲区类
class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.size = 0;
        this.head = 0;
        this.tail = 0;
    }

    push(value) {
        this.buffer[this.tail] = value;
        this.tail = (this.tail + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        } else {
            this.head = (this.head + 1) % this.capacity;
        }
    }

    getData() {
        const result = [];
        for (let i = 0; i < this.size; i++) {
            result.push(this.buffer[(this.head + i) % this.capacity]);
        }
        return result;
    }

    clear() {
        this.size = 0;
        this.head = 0;
        this.tail = 0;
    }
}

// 修改数据点数量计算
const MINUTES_TO_KEEP = 10; // 保存10分钟的数据
const MAX_DATA_POINTS = 40; // 10分钟，每15秒一个点，约40个点

let historyData = {
    timestamps: new CircularBuffer(MAX_DATA_POINTS),
    exchanges: {}, // 存储每个交易所的数据 {exchange: {channel: {msgRates: CircularBuffer, bytesPerSec: CircularBuffer}}}
    signals: new CircularBuffer(5) // 只保留最近5个信号
};

// 存储最新数据的对象
let currentExchangeData = {};

// 添加初始化标志
let isInitialized = false;

// 加载历史数据
function loadHistoryData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            
            // 加载时间戳
            (data.timestamps || []).slice(-MAX_DATA_POINTS).forEach(ts => {
                historyData.timestamps.push(ts);
            });
            
            // 加载交易所数据
            Object.keys(data.exchanges || {}).forEach(exchange => {
                historyData.exchanges[exchange] = {};
                ['trade', 'inc'].forEach(channel => {
                    if (data.exchanges[exchange][channel]) {
                        historyData.exchanges[exchange][channel] = {
                            msgRates: new CircularBuffer(MAX_DATA_POINTS),
                            bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                        };
                        
                        // 加载数据
                        data.exchanges[exchange][channel].msgRates.slice(-MAX_DATA_POINTS).forEach(value => {
                            historyData.exchanges[exchange][channel].msgRates.push(value);
                        });
                        data.exchanges[exchange][channel].bytesPerSec.slice(-MAX_DATA_POINTS).forEach(value => {
                            historyData.exchanges[exchange][channel].bytesPerSec.push(value);
                        });
                    }
                });
            });
            
            // 加载信号数据
            (data.signals || []).slice(-5).forEach(signal => {
                historyData.signals.push(signal);
            });
            
            console.log('已加载历史数据');
        }
    } catch (error) {
        console.error('加载历史数据失败:', error);
        historyData = {
            timestamps: new CircularBuffer(MAX_DATA_POINTS),
            exchanges: {},
            signals: new CircularBuffer(5)
        };
    }
}

// 保存历史数据
function saveHistoryData() {
    try {
        const dataToSave = {
            timestamps: historyData.timestamps.getData(),
            exchanges: {},
            signals: historyData.signals.getData()
        };
        
        // 转换交易所数据
        Object.keys(historyData.exchanges).forEach(exchange => {
            dataToSave.exchanges[exchange] = {};
            Object.keys(historyData.exchanges[exchange]).forEach(channel => {
                dataToSave.exchanges[exchange][channel] = {
                    msgRates: historyData.exchanges[exchange][channel].msgRates.getData(),
                    bytesPerSec: historyData.exchanges[exchange][channel].bytesPerSec.getData()
                };
            });
        });
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave));
    } catch (error) {
        console.error('保存历史数据失败:', error);
    }
}

// 记录指标到日志
function logMetrics(stats) {
    try {
        const logEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...stats
        }) + '\n';
        fs.appendFileSync(LOG_FILE, logEntry);
    } catch (error) {
        console.error('记录指标失败:', error);
    }
}

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 添加根路由处理
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 创建 public 目录
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
}

// 创建前端页面
const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>加密货币数据流监控</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
        }
        .status.running {
            background-color: #d4edda;
            color: #155724;
        }
        .status.stopped {
            background-color: #f8d7da;
            color: #721c24;
        }
        .chart-container {
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
        .signal-list {
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .signal-item {
            padding: 10px;
            border-bottom: 1px solid #eee;
        }
        .signal-item:last-child {
            border-bottom: none;
        }
        .connections-table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background-color: white;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .connections-table th, .connections-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        .connections-table th {
            background-color: #f8f9fa;
            font-weight: bold;
        }
        .connections-table tr:hover {
            background-color: #f5f5f5;
        }
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .status-indicator.running {
            background-color: #28a745;
        }
        .status-indicator.stopped {
            background-color: #dc3545;
        }
        .chart-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .chart-wrapper {
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            height: 400px;
        }
        .chart-title {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 10px;
            color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>加密货币数据流监控</h1>
        <div id="status" class="status">连接中...</div>
        
        <!-- 总带宽图表 -->
        <div class="chart-wrapper">
            <div class="chart-title">总带宽（所有流累加）</div>
            <div id="total-bandwidth-chart" style="width: 100%; height: 350px;"></div>
        </div>

        <!-- 各stream速率图表 -->
        <div id="streamChartsContainer" class="chart-grid"></div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <script>
        // 存储图表实例
        const streamCharts = {};
        let totalBandwidthChart = null;

        // 创建stream速率图表
        function createStreamChart(exchange, channel) {
            const chartId = \`chart-\${exchange}-\${channel}\`;
            const chartWrapper = document.createElement('div');
            chartWrapper.className = 'chart-wrapper';
            chartWrapper.innerHTML = \`
                <div class="chart-title">\${exchange} - \${channel} 消息速率</div>
                <div id="\${chartId}" style="width: 100%; height: 350px;"></div>
            \`;
            document.getElementById('streamChartsContainer').appendChild(chartWrapper);
            const chart = echarts.init(document.getElementById(chartId));
            streamCharts[\`\${exchange}-\${channel}\`] = chart;
            return chart;
        }

        // 创建总带宽图表
        function createTotalBandwidthChart() {
            totalBandwidthChart = echarts.init(document.getElementById('total-bandwidth-chart'));
        }

        // 更新stream速率图表
        function updateStreamCharts(data) {
            if (!data || !data.history || !data.history.exchanges) return;
            const timestamps = data.history.timestamps || [];
            const signals = (data.history.signals || []).filter(s => s.type && s.type !== 'periodic');
            for (const [exchange, channels] of Object.entries(data.history.exchanges)) {
                for (const [channel, stats] of Object.entries(channels)) {
                    const chartKey = \`\${exchange}-\${channel}\`;
                    if (!streamCharts[chartKey]) {
                        createStreamChart(exchange, channel);
                    }
                    const chart = streamCharts[chartKey];
                    // 消息速率数据
                    const msgRates = stats.msgRates || [];
                    // 标记signal点
                    const markPoints = signals.filter(s => s.exchange === exchange && s.channel === channel).map(s => ({
                        name: s.type,
                        value: s.type,
                        xAxis: timestamps.indexOf(s.time),
                        yAxis: msgRates[timestamps.indexOf(s.time)] || 0,
                        itemStyle: { color: s.type === 'SIGINT' ? 'red' : 'orange' }
                    }));
                    const option = {
                        tooltip: { trigger: 'axis' },
                        grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
                        xAxis: {
                            type: 'category',
                            data: timestamps.map(ts => new Date(ts).toLocaleTimeString()),
                            axisLabel: { rotate: 45 }
                        },
                        yAxis: {
                            type: 'value',
                            name: '消息/秒',
                            axisLabel: { formatter: v => v }
                        },
                        series: [{
                            name: '消息速率',
                            type: 'line',
                            data: msgRates,
                            smooth: true,
                            showSymbol: false,
                            markPoint: { data: markPoints }
                        }]
                    };
                    chart.setOption(option);
                }
            }
        }

        // 更新总带宽图表
        function updateTotalBandwidthChart(data) {
            if (!data || !data.history || !data.history.exchanges) return;
            const timestamps = data.history.timestamps || [];
            // 累加所有stream的bytesPerSec
            const totalBytes = timestamps.map((_, idx) => {
                let sum = 0;
                for (const channels of Object.values(data.history.exchanges)) {
                    for (const stats of Object.values(channels)) {
                        sum += stats.bytesPerSec[idx] || 0;
                    }
                }
                return sum;
            });
            const mbps = totalBytes.map(b => (b * 8) / (1024 * 1024));
            const option = {
                tooltip: { trigger: 'axis' },
                grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
                xAxis: {
                    type: 'category',
                    data: timestamps.map(ts => new Date(ts).toLocaleTimeString()),
                    axisLabel: { rotate: 45 }
                },
                yAxis: {
                    type: 'value',
                    name: '总带宽(Mbps)',
                    axisLabel: { formatter: v => v.toFixed(2) }
                },
                series: [{
                    name: '总带宽',
                    type: 'line',
                    data: mbps,
                    smooth: true,
                    showSymbol: false
                }]
            };
            totalBandwidthChart.setOption(option);
        }

        // 连接WebSocket
        const ws = new WebSocket('ws://' + window.location.hostname + ':${WS_PORT}/ws/metrics');

        ws.onopen = () => {
            document.getElementById('status').textContent = '已连接';
            document.getElementById('status').className = 'status running';
        };

        // WebSocket 消息处理
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (!totalBandwidthChart) createTotalBandwidthChart();
                updateTotalBandwidthChart(data);
                updateStreamCharts(data);
            } catch (error) {
                console.error('处理WebSocket消息时出错:', error);
                console.error('原始消息:', event.data);
            }
        };

        ws.onclose = () => {
            document.getElementById('status').textContent = '断开连接';
            document.getElementById('status').className = 'status stopped';
        };

        // 窗口大小改变时调整图表大小
        window.addEventListener('resize', () => {
            Object.values(streamCharts).forEach(chart => chart.resize());
        });

        ws.onerror = (error) => {
            console.error('WebSocket 连接错误:', error);
            document.getElementById('status').textContent = '连接错误';
            document.getElementById('status').className = 'status stopped';
        };
    </script>
</body>
</html>
`;

// 写入 HTML 文件
fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), htmlContent);

// 创建 HTTP 服务器
const server = app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP服务器运行在 http://${localIP}:${HTTP_PORT}`);
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
    port: WS_PORT,
    path: '/ws/metrics'
});

wss.on('listening', () => {
    console.log(`WebSocket服务器运行在 ws://${localIP}:${WS_PORT}/ws/metrics`);
});

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`新的监控客户端连接，IP: ${clientIP}`);

    // 检查连接数量限制
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
        console.log('达到最大连接数限制，拒绝新连接');
        ws.close(1008, '达到最大连接数限制');
        return;
    }

    // 发送当前完整历史数据给新连接的客户端
    const fullData = {
        history: {
            timestamps: historyData.timestamps.getData(),
            exchanges: {},
            signals: historyData.signals.getData()
        },
        current: currentExchangeData
    };

    // 转换历史数据
    Object.keys(historyData.exchanges).forEach(ex => {
        fullData.history.exchanges[ex] = {};
        Object.keys(historyData.exchanges[ex]).forEach(ch => {
            fullData.history.exchanges[ex][ch] = {
                msgRates: historyData.exchanges[ex][ch].msgRates.getData(),
                bytesPerSec: historyData.exchanges[ex][ch].bytesPerSec.getData()
            };
        });
    });

    console.log('发送给新客户端的初始数据:', JSON.stringify(fullData, null, 2));

    try {
        ws.send(JSON.stringify(fullData));
        console.log('已发送初始数据到新客户端');
    } catch (error) {
        console.error('发送初始数据失败:', error);
    }

    // 设置心跳检测
    const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
                console.log('发送心跳ping');
            } catch (error) {
                console.error('发送心跳失败:', error);
                clearInterval(heartbeat);
                ws.terminate();
            }
        }
    }, 30000);

    ws.on('pong', () => {
        console.log('收到心跳pong响应');
    });

    ws.on('message', (message) => {
        try {
            console.log('收到消息:', message.toString());
            const stats = JSON.parse(message);
            if (!stats.exchange || !stats.channel) {
                console.error('消息缺少必要字段:', stats);
                return;
            }

            const exchange = stats.exchange.toString();
            const channel = stats.channel.toString();
            
            console.log(`处理数据: 交易所=${exchange}, 通道=${channel}`);
            
            // 记录指标到日志
            logMetrics(stats);
            
            // 更新历史数据
            const timestamp = new Date(stats.timestamp).toISOString();
            
            // 添加时间戳
            historyData.timestamps.push(timestamp);
            
            // 确保数据结构存在
            if (!historyData.exchanges[exchange]) {
                historyData.exchanges[exchange] = {};
            }
            if (!historyData.exchanges[exchange][channel]) {
                historyData.exchanges[exchange][channel] = {
                    msgRates: new CircularBuffer(MAX_DATA_POINTS),
                    bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                };
            }
            
            // 更新历史数据
            const msgRate = Math.round(stats.msg_sec || 0);
            const bytesPerSec = Math.round(stats.bytes_sec || 0);
            
            historyData.exchanges[exchange][channel].msgRates.push(msgRate);
            historyData.exchanges[exchange][channel].bytesPerSec.push(bytesPerSec);

            // 更新当前数据
            if (!currentExchangeData[exchange]) {
                currentExchangeData[exchange] = {};
            }
            if (!currentExchangeData[exchange][channel]) {
                currentExchangeData[exchange][channel] = {
                    msg_rate: msgRate,
                    bytes_per_sec: bytesPerSec,
                    status: stats.status || 'running',
                    signal_type: stats.signal_type || 'periodic',
                    timestamp: timestamp
                };
            }

            // 如果收到信号，添加到信号列表
            if (stats.signal_type && stats.signal_type !== 'periodic') {
                historyData.signals.push({
                    time: timestamp,
                    type: stats.signal_type,
                    exchange: exchange,
                    channel: channel
                });
                console.log('添加新信号:', stats.signal_type);
            }

            // 只发送更新的数据给当前客户端
            const updateData = {
                history: {
                    timestamps: historyData.timestamps.getData(),
                    exchanges: historyData.exchanges,
                    signals: historyData.signals.getData()
                }
            };

            // 只发送给当前连接的客户端
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify(updateData));
                    console.log(`数据已发送到客户端`);
                } catch (error) {
                    console.error('发送数据到客户端失败:', error);
                }
            }

        } catch (error) {
            console.error('处理消息失败:', error);
            console.error('原始消息:', message.toString());
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`监控客户端断开连接, 代码: ${code}, 原因: ${reason}`);
        clearInterval(heartbeat);
    });

    ws.on('error', (error) => {
        console.error('WebSocket 连接错误:', error);
        clearInterval(heartbeat);
        // 只关闭出错的连接，而不是整个服务器
        ws.terminate();
    });
});

// 定期打印连接状态
setInterval(() => {
    console.log(`当前WebSocket连接数: ${wss.clients.size}`);
}, 30000);

// 加载历史数据
loadHistoryData();

// 清理函数
function cleanup() {
    console.log('正在清理资源...');
    
    // 保存当前数据
    saveHistoryData();
    
    // 关闭WebSocket服务器
    wss.close(() => {
        console.log('WebSocket服务器已关闭');
    });
    
    // 关闭HTTP服务器
    server.close(() => {
        console.log('HTTP服务器已关闭');
    });
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    // 只有在严重错误时才触发清理
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        cleanup();
        process.exit(1);
    }
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    // 记录错误但不立即退出
    console.error('Promise:', promise);
});

// 处理进程退出
process.on('exit', () => {
    cleanup();
});

// 处理SIGTERM信号
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在清理...');
    cleanup();
    process.exit(0);
});

// 处理SIGINT信号（Ctrl+C）
process.on('SIGINT', () => {
    console.log('收到SIGINT信号，正在清理...');
    cleanup();
    process.exit(0);
}); 