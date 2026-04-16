const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

process.on('uncaughtException', (error) => {
  console.error('未捕获的错误:', error);
  fs.appendFileSync(path.join(__dirname, 'error.log'), `${new Date().toISOString()} - ${error.stack}\n`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});

let mainWindow;
let server;

function getValidIPs() {
  const validIPs = [];
  const excludePatterns = [/virtualbox/i, /vmware/i, /hyper-v/i, /docker/i, /vpn/i, /tunnel/i, /loopback/i, /virtual/i, /veth/i, /bridge/i, /本地连接/i, /移动热点/i];
  
  const excludeSubnets = [
    '192.168.137',
    '169.254'
  ];
  
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        const isExcluded = excludePatterns.some(p => p.test(name) || p.test(info.address));
        const isExcludedSubnet = excludeSubnets.some(subnet => info.address.startsWith(subnet));
        if (!isExcluded && !isExcludedSubnet) {
          validIPs.push({
            name: name,
            address: info.address
          });
        }
      }
    }
  }
  
  return validIPs;
}

function startServer() {
  const PORT = 3000;
  
  const server = http.createServer((req, res) => {
    if (req.url === '/api/ip') {
      const ips = getValidIPs();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ips }));
      return;
    }
    
    if (req.method === 'GET') {
      const filePath = path.join(__dirname, 'public', 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('Error loading index.html');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const rooms = new Map();
  const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`Client connected: ${clientIP}`);
    let currentRoom = null;

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.type) {
          case 'join':
            currentRoom = data.room;
            if (!rooms.has(currentRoom)) {
              rooms.set(currentRoom, new Set());
            }
            const room = rooms.get(currentRoom);
            const otherClients = [...room];
            room.add(ws);
            ws.room = currentRoom;
            
            if (otherClients.length > 0) {
              ws.send(JSON.stringify({ type: 'peers', peers: otherClients.length }));
              otherClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: 'new-peer', count: room.size }));
                }
              });
            } else {
              ws.send(JSON.stringify({ type: 'waiting' }));
            }
            break;
          case 'offer':
          case 'answer':
          case 'candidate':
            const roomClients = rooms.get(currentRoom);
            if (roomClients) {
              roomClients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(data));
                }
              });
            }
            break;
        }
      } catch (err) {
        console.error('Message parse error:', err);
      }
    });

    ws.on('close', () => {
      if (ws.room && rooms.has(ws.room)) {
        const room = rooms.get(ws.room);
        room.delete(ws);
        if (room.size === 0) {
          rooms.delete(ws.room);
        }
      }
    });
  });

  server.listen(PORT, () => {
    const validIPs = getValidIPs();
    console.log(`服务器运行在:`);
    console.log(`  - http://localhost:${PORT}`);
    if (validIPs.length > 0) {
      validIPs.forEach(ip => {
        console.log(`  - http://${ip.address}:${PORT} (${ip.name})`);
      });
    }
    console.log(`\n请确保手机和电脑在同一局域网下访问`);
  });

  return server;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('页面加载失败:', errorCode, errorDescription);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  try {
    server = startServer();
    createWindow();
  } catch (err) {
    console.error('启动错误:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (server) {
    server.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (server) {
    server.close();
  }
});