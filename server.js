const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

function getValidIPs() {
  const validIPs = [];
  const excludePatterns = [/virtualbox/i, /vmware/i, /hyper-v/i, /docker/i, /vpn/i, /tunnel/i, /loopback/i, /virtual/i, /veth/i, /bridge/i];
  
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        const isExcluded = excludePatterns.some(p => p.test(name) || p.test(info.address));
        if (!isExcluded && !info.address.startsWith('169.254.')) {
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

const wss = new WebSocket.Server({ 
  server,
  maxPayload: 1024 * 1024
});

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`Client connected: ${clientIP}`);
  let currentRoom = null;
  let clientId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join':
          currentRoom = data.room;
          clientId = Date.now().toString();
          
          if (!rooms.has(currentRoom)) {
            rooms.set(currentRoom, new Set());
          }
          
          const room = rooms.get(currentRoom);
          const otherClients = [...room];
          
          room.add(ws);
          
          ws.room = currentRoom;
          ws.clientId = clientId;
          
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

        case 'leave':
          handleLeave(ws);
          break;
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  ws.on('close', () => {
    handleLeave(ws);
  });

  function handleLeave(client) {
    if (client.room && rooms.has(client.room)) {
      const room = rooms.get(client.room);
      room.delete(client);
      
      if (room.size === 0) {
        rooms.delete(client.room);
      } else {
        room.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'peer-left', count: room.size }));
          }
        });
      }
    }
  }
});

server.listen(PORT, () => {
  const address = server.address();
  const validIPs = getValidIPs();
  
  console.log(`服务器运行在:`);
  console.log(`  - http://localhost:${address.port}`);
  
  if (validIPs.length > 0) {
    validIPs.forEach(ip => {
      console.log(`  - http://${ip.address}:${address.port} (${ip.name})`);
    });
  }
  
  console.log(`\n请确保手机和电脑在同一局域网下访问`);
});