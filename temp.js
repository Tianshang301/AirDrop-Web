
    const CHUNK_SIZE = 256 * 1024;
    const BUFFER_AHEAD = 2;
    const MAX_BUFFERED = 8 * 1024 * 1024;
    const MAX_RETRIES = 5;

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    };

    const roomInput = document.getElementById('roomInput');
    const joinBtn = document.getElementById('joinBtn');
    const statusArea = document.getElementById('statusArea');
    const fileArea = document.getElementById('fileArea');
    const joinArea = document.getElementById('joinArea');
    const fileSelect = document.getElementById('fileSelect');
    const fileInput = document.getElementById('fileInput');
    const sendFileList = document.getElementById('sendFileList');
    const receivedList = document.getElementById('receivedList');
    const sendBtn = document.getElementById('sendBtn');
    const queueList = document.getElementById('queueList');
    const queueCount = document.getElementById('queueCount');
    const queueArea = document.getElementById('queueArea');

    let pc = null;
    let dataChannels = [];
    let ws = null;
    let roomId = '';
    let isInitiator = false;
    let receivingFileInfo = null;
    let receivedChunks = [];
    let isReceiving = false;
    let fileQueue = [];
    let isFileSending = false;
    let pendingFiles = [];
    let receivedBlobs = new Map();
    let activeTransfers = new Map();

    function getWsUrl() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}`;
    }

    function updateStatus(text, type) {
      statusArea.textContent = text;
      statusArea.className = `status ${type}`;
      statusArea.classList.remove('hidden');
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function triggerDownload(url, filename) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    window.reDownload = function(fileId, filename) {
      const blob = receivedBlobs.get(fileId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        triggerDownload(url, filename);
        URL.revokeObjectURL(url);
      }
    };

    function updateQueueUI() {
      queueList.innerHTML = '';
      fileQueue.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.innerHTML = `
          <div class="queue-item-info">
            <div class="queue-item-name">${escapeHtml(file.name)}</div>
            <div class="queue-item-size">${formatSize(file.size)}</div>
          </div>
          <button class="queue-item-remove" onclick="removeFromQueue(${index})">删除</button>
        `;
        queueList.appendChild(item);
      });
      queueCount.textContent = `${fileQueue.length} 个文件`;
      sendBtn.disabled = fileQueue.length === 0;
      queueArea.classList.toggle('hidden', fileQueue.length === 0);
    }

    window.removeFromQueue = function(index) {
      fileQueue.splice(index, 1);
      updateQueueUI();
    };

    function addToQueue(files) {
      for (const file of files) {
        fileQueue.push(file);
      }
      updateQueueUI();
    }

    function connectWebSocket() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(getWsUrl());
        ws.onopen = () => resolve();
        ws.onerror = (err) => reject(err);
        ws.onmessage = (event) => handleSignaling(JSON.parse(event.data));
        ws.onclose = () => updateStatus('连接已断开', 'error');
      });
    }

    async function joinRoom() {
      roomId = roomInput.value.trim();
      if (!roomId) { alert('请输入房间号'); return; }
      joinBtn.disabled = true;
      joinBtn.textContent = '连接中...';
      try {
        await connectWebSocket();
        ws.send(JSON.stringify({ type: 'join', room: roomId }));
      } catch (err) {
        updateStatus('连接服务器失败', 'error');
        joinBtn.disabled = false;
        joinBtn.textContent = '连接';
      }
    }

    function handleSignaling(data) {
      switch (data.type) {
        case 'waiting':
          updateStatus('等待其他设备加入...', 'waiting');
          break;
        case 'peers':
          isInitiator = true;
          createPeerConnection();
          updateStatus('正在建立连接...', 'waiting');
          break;
        case 'new-peer':
          if (!pc) { isInitiator = false; createPeerConnection(); }
          updateStatus('正在建立连接...', 'waiting');
          break;
        case 'offer':
          if (!pc) createPeerConnection();
          pc.setRemoteDescription(new RTCSessionDescription(data.offer))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => ws.send(JSON.stringify({ type: 'answer', answer: pc.localDescription })));
          break;
        case 'answer':
          pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          break;
        case 'candidate':
          if (pc && data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          break;
        case 'peer-left':
          updateStatus('对方已离开，重新等待...', 'waiting');
          break;
      }
    }

    function createPeerConnection() {
      pc = new RTCPeerConnection(configuration);
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          updateStatus('已连接', 'connected');
          joinArea.classList.add('hidden');
          fileArea.classList.add('active');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          updateStatus('连接断开', 'error');
          isFileSending = false;
          pendingFiles = [];
          activeTransfers.clear();
        }
      };
      
      pc.ondatachannel = (event) => {
        dataChannels.push(event.channel);
        setupDataChannel(event.channel);
      };
      
      if (isInitiator) {
        const dc = pc.createDataChannel('fileTransfer', { ordered: true });
        dataChannels.push(dc);
        setupDataChannel(dc);
        
        pc.createOffer({ iceRestart: true })
          .then(offer => pc.setLocalDescription(offer))
          .then(() => ws.send(JSON.stringify({ type: 'offer', offer: pc.localDescription })))
          .catch(err => console.error('Failed to create offer:', err));
      }
    }

    function setupDataChannel(channel) {
      channel.onopen = () => {
        console.log('DataChannel opened');
        updateStatus('已连接', 'connected');
      };
      channel.onmessage = (event) => handleReceiveData(event.data);
      channel.onerror = (error) => {
        console.error('DataChannel error:', error);
        updateStatus('传输通道错误', 'error');
      };
      channel.onclose = () => {
        console.log('DataChannel closed');
        updateStatus('连接已断开', 'error');
      };
    }

    function handleReceiveData(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        switch (msg.type) {
          case 'file-start':
            receivingFileInfo = {
              name: msg.name,
              size: msg.size,
              mimeType: msg.mimeType || 'application/octet-stream',
              fileId: msg.fileId
            };
            receivedChunks = [];
            isReceiving = true;
            updateStatus(`正在接收: ${msg.name}`, 'waiting');
            break;
            
          case 'file-end':
            if (receivedChunks.length > 0 && receivingFileInfo) {
              const blob = new Blob(receivedChunks, { type: receivingFileInfo.mimeType });
              downloadFile(blob, receivingFileInfo.name, msg.size);
              const channel = dataChannels.find(c => c.readyState === 'open');
              if (channel) {
                channel.send(JSON.stringify({ type: 'file-received', fileId: msg.fileId }));
              }
            }
            isReceiving = false;
            receivedChunks = [];
            receivingFileInfo = null;
            updateStatus('已连接', 'connected');
            break;
            
          case 'file-received':
            if (window._onFileReceived) {
              window._onFileReceived(msg.fileId);
            }
            break;
        }
      } else if (data instanceof ArrayBuffer || data instanceof Blob) {
        if (isReceiving && receivingFileInfo) {
          receivedChunks.push(data);
          const receivedSize = receivedChunks.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.size), 0);
          const percent = ((receivedSize / receivingFileInfo.size) * 100).toFixed(1);
          updateStatus(`接收中: ${percent}%`, 'waiting');
        }
      }
    }

    function downloadFile(blob, filename, fileSize) {
      const fileId = Date.now() + Math.random().toString(36).substr(2, 9);
      receivedBlobs.set(fileId, blob);
      const item = document.createElement('div');
      item.className = 'received-item';
      item.innerHTML = `
        <div>
          <div class="file-name">${escapeHtml(filename)}</div>
          <div class="file-size">${formatSize(fileSize)}</div>
        </div>
        <button class="download-btn" onclick="reDownload('${fileId}', '${escapeHtml(filename)}')">下载</button>
      `;
      receivedList.appendChild(item);
      updateStatus('已收到文件: ' + filename, 'connected');
    }

    function sendQueuedFiles() {
      if (fileQueue.length === 0) return;
      if (dataChannels.length === 0 || !dataChannels.some(c => c.readyState === 'open')) {
        alert('连接未建立');
        return;
      }
      pendingFiles = [...fileQueue];
      fileQueue = [];
      updateQueueUI();
      sendNextFile();
    }

    function sendNextFile() {
      if (pendingFiles.length === 0) {
        isFileSending = false;
        return;
      }
      const file = pendingFiles.shift();
      sendFile(file);
    }

    function sendFile(file) {
      if (dataChannels.length === 0 || !dataChannels.some(c => c.readyState === 'open')) {
        alert('连接未建立');
        isFileSending = false;
        return;
      }
      
      isFileSending = true;
      const fileId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const totalSize = file.size;
      const channel = dataChannels.find(c => c.readyState === 'open');
      
      if (!channel) {
        alert('没有可用的数据通道');
        return;
      }

      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.id = `file-${fileId}`;
      fileItem.innerHTML = `
        <div class="file-info">
          <div>
            <div class="file-name">${escapeHtml(file.name)}</div>
            <div class="file-size">${formatSize(totalSize)}</div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-bar"><div class="progress-fill" id="progress-${fileId}"></div></div>
          <div class="progress-text" id="progress-text-${fileId}">准备发送...</div>
        </div>
      `;
      sendFileList.appendChild(fileItem);

      channel.send(JSON.stringify({
        type: 'file-start',
        name: file.name,
        size: totalSize,
        mimeType: file.type || 'application/octet-stream',
        fileId: fileId
      }));

      let offset = 0;
      let bytesSent = 0;
      let isFinished = false;
      let retryCount = 0;
      let updateInterval = null;
      const startTime = performance.now();
      
      const context = {
        fileId,
        channel,
        totalSize,
        fileItem,
        file,
        receivedConfirmation: false,
        isFinished: false,
        retryCount: 0,
        
        updateProgress: (sent) => {
          bytesSent = sent;
          const percent = Math.min((bytesSent / totalSize) * 100, 100);
          const fill = document.getElementById(`progress-${fileId}`);
          if (fill) fill.style.width = percent + '%';
          
          const now = performance.now();
          const elapsed = (now - startTime) / 1000;
          const speedMBps = elapsed > 0 ? (bytesSent / 1024 / 1024 / elapsed).toFixed(1) : '0';
          const sentMB = (bytesSent / 1024 / 1024).toFixed(1);
          const totalMB = (totalSize / 1024 / 1024).toFixed(1);
          const textElem = document.getElementById(`progress-text-${fileId}`);
          if (textElem) {
            let statusText = `${sentMB}MB / ${totalMB}MB (${speedMBps}MB/s)`;
            if (retryCount > 0) statusText = `[重试 ${retryCount}/${MAX_RETRIES}] ${statusText}`;
            textElem.textContent = statusText;
          }
        },
        
        finish: (success = true) => {
          if (updateInterval) clearInterval(updateInterval);
          const elapsed = (performance.now() - startTime) / 1000;
          const speedMBps = elapsed > 0 ? (totalSize / 1024 / 1024 / elapsed).toFixed(1) : '0';
          const textElem = document.getElementById(`progress-text-${fileId}`);
          
          if (success && context.receivedConfirmation) {
            textElem.textContent = `发送完成 (平均速度: ${speedMBps}MB/s)`;
          } else if (!success) {
            if (retryCount < MAX_RETRIES) {
              retryCount++;
              console.log('开始第', retryCount, '次重试...');
              setTimeout(() => sendFile(file), 1000);
            } else {
              textElem.textContent = `发送失败 - 已重试${MAX_RETRIES}次仍失败`;
            }
          } else {
            textElem.textContent = `发送超时 - 正在重试...`;
          }
          
          if (success || retryCount >= MAX_RETRIES) {
            isFileSending = false;
            activeTransfers.delete(fileId);
            setTimeout(() => sendNextFile(), 50);
          }
        }
      };
      
      activeTransfers.set(fileId, context);

      window._onFileReceived = (confirmedFileId) => {
        if (confirmedFileId === fileId && activeTransfers.has(fileId)) {
          const ctx = activeTransfers.get(fileId);
          ctx.receivedConfirmation = true;
          if (!ctx.isFinished) {
            ctx.isFinished = true;
            ctx.finish(true);
          }
        }
      };
      
      const chunks = [];
      
      async function readNextChunk() {
        if (offset >= totalSize) return null;
        return new Promise((resolve) => {
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const reader = new FileReader();
          reader.onload = (e) => {
            const data = e.target.result;
            const curOffset = offset;
            offset += CHUNK_SIZE;
            resolve({ data, offset: curOffset });
          };
          reader.onerror = () => resolve(null);
          reader.readAsArrayBuffer(slice);
        });
      }
      
      async function sendLoop() {
        while (!isFinished && channel.readyState === 'open') {
          while (chunks.length < BUFFER_AHEAD && offset < totalSize) {
            const chunk = await readNextChunk();
            if (chunk) chunks.push(chunk);
            else break;
          }
          
          if (chunks.length > 0) {
            if (channel.bufferedAmount < MAX_BUFFERED) {
              const chunk = chunks.shift();
              channel.send(chunk.data);
              context.updateProgress(chunk.offset + chunk.data.byteLength);
            } else {
              await new Promise(r => setTimeout(r, 10));
            }
          } else if (offset >= totalSize && chunks.length === 0) {
            channel.send(JSON.stringify({
              type: 'file-end',
              fileId: fileId,
              size: totalSize,
              name: file.name
            }));
            isFinished = true;
            
            setTimeout(() => {
              if (activeTransfers.has(fileId)) {
                const ctx = activeTransfers.get(fileId);
                if (ctx && !ctx.isFinished) {
                  ctx.isFinished = true;
                  ctx.finish(false);
                }
              }
            }, 3000);
            break;
          } else {
            await new Promise(r => setTimeout(r, 10));
          }
        }
        
        if (channel.readyState !== 'open' && !isFinished) {
          console.error('DataChannel closed during transfer');
          isFinished = true;
          context.finish(false);
        }
      }
      
      updateInterval = setInterval(() => {
        if (!isFinished && activeTransfers.has(fileId)) {
          const now = performance.now();
          const elapsed = (now - startTime) / 1000;
          const speedMBps = elapsed > 0 ? (bytesSent / 1024 / 1024 / elapsed).toFixed(1) : '0';
          const sentMB = (bytesSent / 1024 / 1024).toFixed(1);
          const totalMB = (totalSize / 1024 / 1024).toFixed(1);
          const textElem = document.getElementById(`progress-text-${fileId}`);
          if (textElem) {
            let statusText = `${sentMB}MB / ${totalMB}MB (${speedMBps}MB/s)`;
            if (retryCount > 0) statusText = `[重试 ${retryCount}/${MAX_RETRIES}] ${statusText}`;
            textElem.textContent = statusText;
          }
        }
      }, 200);
      
      sendLoop();
    }

    fileSelect.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileSelect.classList.add('dragover');
    });
    fileSelect.addEventListener('dragleave', (e) => {
      e.preventDefault();
      fileSelect.classList.remove('dragover');
    });
    fileSelect.addEventListener('drop', (e) => {
      e.preventDefault();
      fileSelect.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) addToQueue(files);
    });
    fileSelect.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addToQueue(e.target.files);
        fileInput.value = '';
      }
    });
    sendBtn.addEventListener('click', sendQueuedFiles);
    joinBtn.addEventListener('click', joinRoom);
    roomInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinRoom(); });
  