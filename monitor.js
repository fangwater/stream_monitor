const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const port = 3000;

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'history.json');
const LOG_FILE = path.join(__dirname, 'data', 'metrics.log');

// 确保数据目录存在
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

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
    return '0.0.0.0'; // 如果找不到合适的IP，使用0.0.0.0
}

const localIP = getLocalIP();

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

// 存储历史数据
const MAX_DATA_POINTS = 60*4; // 保存最近4分钟的数据点（15秒一个点）
const MAX_WS_CONNECTIONS = 10; // 最大WebSocket连接数
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 最大日志文件大小（10MB）
const SUBMIT_INTERVAL = 15000; // 15秒提交一次数据

let historyData = {
    timestamps: new CircularBuffer(MAX_DATA_POINTS),
    exchanges: {}, // 存储每个交易所的数据 {exchange: {channel: {msgRates: CircularBuffer, bytesPerSec: CircularBuffer}}}
    signals: new CircularBuffer(5) // 只保留最近5个信号
};

// 存储临时数据
let tempData = {
    exchanges: {}, // {exchange: {channel: {msgCount: 0, bytesCount: 0, lastUpdate: timestamp}}}
};

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
        // 检查日志文件大小
        if (fs.existsSync(LOG_FILE)) {
            const stats = fs.statSync(LOG_FILE);
            if (stats.size > MAX_LOG_SIZE) {
                // 如果日志文件过大，创建新的日志文件
                const backupFile = LOG_FILE + '.' + new Date().toISOString().replace(/[:.]/g, '-');
                fs.renameSync(LOG_FILE, backupFile);
            }
        }
        
        const logEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...stats
        }) + '\n';
        fs.appendFileSync(LOG_FILE, logEntry);
    } catch (error) {
        console.error('记录指标失败:', error);
    }
}

// 创建 HTTP 服务器
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`监控服务器运行在 http://${localIP}:${port}`);
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
    server,
    path: '/ws/metrics'
});

// 加载历史数据
loadHistoryData();

// 初始化临时数据
function initTempData(exchange, channel) {
    if (!tempData.exchanges[exchange]) {
        tempData.exchanges[exchange] = {};
    }
    if (!tempData.exchanges[exchange][channel]) {
        tempData.exchanges[exchange][channel] = {
            msgCount: 0,
            bytesCount: 0,
            lastUpdate: Date.now()
        };
    }
}

// 更新临时数据
function updateTempData(exchange, channel, msgSize) {
    initTempData(exchange, channel);
    const data = tempData.exchanges[exchange][channel];
    data.msgCount++;
    data.bytesCount += msgSize;
}

// 计算速率并提交数据
function submitData() {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    
    // 添加时间戳
    historyData.timestamps.push(timestamp);
    
    // 处理每个交易所的数据
    Object.keys(tempData.exchanges).forEach(exchange => {
        Object.keys(tempData.exchanges[exchange]).forEach(channel => {
            const data = tempData.exchanges[exchange][channel];
            const timeDiff = (now - data.lastUpdate) / 1000; // 转换为秒
            
            // 计算速率
            const msgRate = Math.round(data.msgCount / timeDiff);
            const bytesPerSec = Math.round(data.bytesCount / timeDiff);
            
            // 确保exchanges对象存在
            if (!historyData.exchanges[exchange]) {
                historyData.exchanges[exchange] = {
                    "trade": {
                        msgRates: new CircularBuffer(MAX_DATA_POINTS),
                        bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                    },
                    "inc": {
                        msgRates: new CircularBuffer(MAX_DATA_POINTS),
                        bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                    }
                };
            }
            
            // 确保channel对象存在
            if (!historyData.exchanges[exchange][channel]) {
                historyData.exchanges[exchange][channel] = {
                    msgRates: new CircularBuffer(MAX_DATA_POINTS),
                    bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                };
            }
            
            // 添加数据
            historyData.exchanges[exchange][channel].msgRates.push(msgRate);
            historyData.exchanges[exchange][channel].bytesPerSec.push(bytesPerSec);
            
            // 准备发送给客户端的数据
            const currentData = {
                history: {
                    timestamps: historyData.timestamps.getData(),
                    exchanges: {},
                    signals: historyData.signals.getData()
                },
                current: {
                    exchanges: {}
                }
            };
            
            // 转换交易所数据
            Object.keys(historyData.exchanges).forEach(ex => {
                currentData.history.exchanges[ex] = {};
                Object.keys(historyData.exchanges[ex]).forEach(ch => {
                    currentData.history.exchanges[ex][ch] = {
                        msgRates: historyData.exchanges[ex][ch].msgRates.getData(),
                        bytesPerSec: historyData.exchanges[ex][ch].bytesPerSec.getData()
                    };
                });
            });
            
            // 添加当前数据
            if (!currentData.current.exchanges[exchange]) {
                currentData.current.exchanges[exchange] = {};
            }
            currentData.current.exchanges[exchange][channel] = {
                msg_rate: msgRate,
                bytes_per_sec: bytesPerSec,
                status: 'running',
                signal_type: 'periodic'
            };
            
            // 广播更新给所有客户端
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify(currentData));
                    } catch (error) {
                        console.error('发送数据到客户端失败:', error);
                    }
                }
            });
            
            console.log('成功处理统计数据:', {
                exchange,
                channel,
                msgRate,
                bytesPerSec,
                status: 'running'
            });
            
            // 重置计数器
            data.msgCount = 0;
            data.bytesCount = 0;
            data.lastUpdate = now;
        });
    });
}

// 定期提交数据
setInterval(submitData, SUBMIT_INTERVAL);

// WebSocket 连接处理
wss.on('connection', (ws) => {
    // 检查连接数量限制
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
        ws.close(1008, '达到最大连接数限制');
        return;
    }
    
    console.log('新的监控客户端连接');

    // 发送当前状态给新连接的客户端
    ws.send(JSON.stringify({
        history: historyData,
        current: {
            exchanges: {}
        }
    }));

    // 设置心跳检测
    const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);

    ws.on('pong', () => {
        // 收到 pong 响应，连接正常
    });

    ws.on('message', (message) => {
        try {
            const stats = JSON.parse(message);
            if (!stats.exchange || !stats.channel) {
                console.error('消息缺少必要字段:', stats);
                return;
            }

            const exchange = stats.exchange.toString();
            const channel = stats.channel.toString();
            
            // 记录指标到日志
            logMetrics(stats);
            
            // 更新历史数据
            const timestamp = new Date(stats.timestamp).toISOString();
            
            // 添加时间戳
            historyData.timestamps.push(timestamp);
            
            // 确保exchanges对象存在
            if (!historyData.exchanges[exchange]) {
                historyData.exchanges[exchange] = {
                    "trade": {
                        msgRates: new CircularBuffer(MAX_DATA_POINTS),
                        bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                    },
                    "inc": {
                        msgRates: new CircularBuffer(MAX_DATA_POINTS),
                        bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                    }
                };
            }
            
            // 确保channel对象存在
            if (!historyData.exchanges[exchange][channel]) {
                historyData.exchanges[exchange][channel] = {
                    msgRates: new CircularBuffer(MAX_DATA_POINTS),
                    bytesPerSec: new CircularBuffer(MAX_DATA_POINTS)
                };
            }
            
            // 将15秒的数据转换为每秒的速率
            const msgRate = Math.round((stats.msg_sec || 0) / 15);
            const bytesPerSec = Math.round((stats.bytes_sec || 0) / 15);
            
            historyData.exchanges[exchange][channel].msgRates.push(msgRate);
            historyData.exchanges[exchange][channel].bytesPerSec.push(bytesPerSec);

            // 如果收到信号，添加到信号列表
            if (stats.signal_type && stats.signal_type !== 'periodic') {
                historyData.signals.push({
                    time: timestamp,
                    type: stats.signal_type,
                    exchange: exchange,
                    channel: channel
                });
            }

            // 准备发送给客户端的数据
            const currentData = {
                history: {
                    timestamps: historyData.timestamps.getData(),
                    exchanges: {},
                    signals: historyData.signals.getData()
                },
                current: {
                    exchanges: {}
                }
            };

            // 转换交易所数据
            Object.keys(historyData.exchanges).forEach(ex => {
                currentData.history.exchanges[ex] = {};
                Object.keys(historyData.exchanges[ex]).forEach(ch => {
                    currentData.history.exchanges[ex][ch] = {
                        msgRates: historyData.exchanges[ex][ch].msgRates.getData(),
                        bytesPerSec: historyData.exchanges[ex][ch].bytesPerSec.getData()
                    };
                });
            });

            // 添加当前数据
            if (!currentData.current.exchanges[exchange]) {
                currentData.current.exchanges[exchange] = {};
            }
            currentData.current.exchanges[exchange][channel] = {
                msg_rate: msgRate,
                bytes_per_sec: bytesPerSec,
                status: stats.status || 'running',
                signal_type: stats.signal_type || 'periodic'
            };

            // 广播更新给所有客户端
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify(currentData));
                    } catch (error) {
                        console.error('发送数据到客户端失败:', error);
                    }
                }
            });

            console.log('成功处理统计数据:', {
                exchange,
                channel,
                msgRate,
                bytesPerSec,
                status: stats.status || 'running'
            });
        } catch (error) {
            console.error('解析消息失败:', error);
            console.error('原始消息:', message.toString());
        }
    });

    ws.on('close', () => {
        console.log('监控客户端断开连接');
        clearInterval(heartbeat);
    });

    ws.on('error', (error) => {
        console.error('WebSocket 错误:', error);
        clearInterval(heartbeat);
    });
});

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 创建 public 目录
if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

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
        
        <table class="connections-table">
            <thead>
                <tr>
                    <th>交易所</th>
                    <th>频道</th>
                    <th>状态</th>
                    <th>消息速率</th>
                    <th>带宽</th>
                </tr>
            </thead>
            <tbody id="connectionsTableBody">
            </tbody>
        </table>

        <div id="chartsContainer" class="chart-grid">
            <!-- 图表将通过JavaScript动态添加 -->
        </div>
        
        <div class="signal-list">
            <h2>最近信号</h2>
            <div id="signalList"></div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <script>
        // 存储图表实例
        const charts = {};
        
        // 创建图表
        function createChart(exchange, channel) {
            const chartId = \`chart-\${exchange}-\${channel}\`;
            const chartWrapper = document.createElement('div');
            chartWrapper.className = 'chart-wrapper';
            chartWrapper.innerHTML = \`
                <div class="chart-title">\${exchange} - \${channel}</div>
                <div id="\${chartId}" style="height: 300px;"></div>
            \`;
            document.getElementById('chartsContainer').appendChild(chartWrapper);
            
            const chart = echarts.init(document.getElementById(chartId));
            charts[\`\${exchange}-\${channel}\`] = chart;
            
            return chart;
        }
        
        // 更新图表
        function updateCharts(data) {
            const now = new Date();
            const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
            
            // 过滤最近30分钟的数据
            const recentData = {
                timestamps: [],
                exchanges: {}
            };
            
            // 过滤时间戳
            data.history.timestamps.forEach((ts, index) => {
                const timestamp = new Date(ts);
                if (timestamp >= thirtyMinutesAgo) {
                    recentData.timestamps.push(ts);
                    
                    // 同时过滤每个交易所的数据
                    Object.keys(data.history.exchanges).forEach(exchange => {
                        if (!recentData.exchanges[exchange]) {
                            recentData.exchanges[exchange] = {};
                        }
                        
                        ['inc', 'trade'].forEach(channel => {
                            if (data.history.exchanges[exchange][channel]) {
                                if (!recentData.exchanges[exchange][channel]) {
                                    recentData.exchanges[exchange][channel] = {
                                        msgRates: [],
                                        bytesPerSec: []
                                    };
                                }
                                recentData.exchanges[exchange][channel].msgRates.push(
                                    data.history.exchanges[exchange][channel].msgRates[index]
                                );
                                recentData.exchanges[exchange][channel].bytesPerSec.push(
                                    data.history.exchanges[exchange][channel].bytesPerSec[index]
                                );
                            }
                        });
                    });
                }
            });

            const timestamps = recentData.timestamps.map(ts => {
                const date = new Date(ts);
                return date.toLocaleTimeString();
            });
            
            // 处理每个交易所的数据
            for (const [exchange, exchangeData] of Object.entries(recentData.exchanges)) {
                for (const channel of ['inc', 'trade']) {
                    if (exchangeData[channel]) {
                        const stats = exchangeData[channel];
                        const chartKey = \`\${exchange}-\${channel}\`;
                        
                        // 如果图表不存在，创建新的图表
                        if (!charts[chartKey]) {
                            createChart(exchange, channel);
                        }
                        
                        const chart = charts[chartKey];
                        
                        // 准备数据
                        const msgRateData = stats.msgRates;
                        const bytesData = stats.bytesPerSec.map(bytes => 
                            ((bytes || 0) * 8) / (1024 * 1024) // 转换为Mbps
                        );
                        
                        // 设置图表选项
                        const option = {
                            tooltip: {
                                trigger: 'axis',
                                axisPointer: {
                                    type: 'cross'
                                }
                            },
                            legend: {
                                data: ['消息速率', '带宽'],
                                bottom: 0
                            },
                            grid: {
                                left: '3%',
                                right: '4%',
                                bottom: '15%',
                                containLabel: true
                            },
                            xAxis: {
                                type: 'category',
                                data: timestamps
                            },
                            yAxis: [
                                {
                                    type: 'value',
                                    name: '消息/秒',
                                    axisLabel: {
                                        formatter: function(value) {
                                            return formatNumber(value);
                                        }
                                    }
                                },
                                {
                                    type: 'value',
                                    name: 'Mbps',
                                    axisLabel: {
                                        formatter: function(value) {
                                            return value.toFixed(2) + ' Mbps';
                                        }
                                    }
                                }
                            ],
                            series: [
                                {
                                    name: '消息速率',
                                    type: 'line',
                                    data: msgRateData,
                                    smooth: true,
                                    showSymbol: false
                                },
                                {
                                    name: '带宽',
                                    type: 'line',
                                    yAxisIndex: 1,
                                    data: bytesData,
                                    smooth: true,
                                    showSymbol: false
                                }
                            ]
                        };
                        
                        chart.setOption(option);
                    }
                }
            }
        }

        // 更新连接表格
        function updateConnectionsTable(data) {
            const tbody = document.getElementById('connectionsTableBody');
            tbody.innerHTML = '';
            
            for (const [exchange, channels] of Object.entries(data.current.exchanges)) {
                for (const [channel, stats] of Object.entries(channels)) {
                    const row = document.createElement('tr');
                    row.innerHTML = \`
                        <td>\${exchange}</td>
                        <td>\${channel}</td>
                        <td>
                            <span class="status-indicator \${stats.status}"></span>
                            \${stats.status}
                        </td>
                        <td>\${formatNumber(stats.msg_rate)} 消息/秒</td>
                        <td>\${formatBytes(stats.bytes_per_sec)}</td>
                    \`;
                    tbody.appendChild(row);
                }
            }
        }

        // 格式化数字
        function formatNumber(num) {
            return new Intl.NumberFormat().format(num);
        }

        // 格式化字节数
        function formatBytes(bytes) {
            const mbps = (bytes * 8) / (1024 * 1024); // 转换为Mbps
            return mbps.toFixed(2) + ' Mbps';
        }

        // 更新信号列表
        function updateSignalList(signals) {
            const signalList = document.getElementById('signalList');
            signalList.innerHTML = signals.map(signal => 
                \`<div class="signal-item">
                    <strong>\${signal.type}</strong> (\${signal.exchange} - \${signal.channel}) - \${signal.time}
                </div>\`
            ).join('');
        }

        // 连接WebSocket
        const ws = new WebSocket('ws://' + window.location.host + '/ws/metrics');

        ws.onopen = () => {
            document.getElementById('status').textContent = '已连接';
            document.getElementById('status').className = 'status running';
        };

        // WebSocket 消息处理
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            updateConnectionsTable(data);
            updateSignalList(data.history.signals);
            updateCharts(data);
        };

        ws.onclose = () => {
            document.getElementById('status').textContent = '断开连接';
            document.getElementById('status').className = 'status stopped';
        };

        // 窗口大小改变时调整图表大小
        window.addEventListener('resize', () => {
            Object.values(charts).forEach(chart => chart.resize());
        });
    </script>
</body>
</html>
`;

// 写入 HTML 文件
fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), htmlContent);

// 清理函数
function cleanup() {
    console.log('正在清理资源...');
    
    // 保存当前数据
    saveHistoryData();
    
    // 清理日志文件
    try {
        if (fs.existsSync(LOG_FILE)) {
            fs.unlinkSync(LOG_FILE);
            console.log('已删除日志文件:', LOG_FILE);
        }
    } catch (error) {
        console.error('删除日志文件失败:', error);
    }
    
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
    cleanup();
    process.exit(1);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    cleanup();
    process.exit(1);
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