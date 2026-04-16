
    const CHUNK_SIZE = 256 * 1024;              // 256KB per chunk
    const BUFFER_AHEAD = 2;                      // read ahead chunks
    const MAX_BUFFERED = 8 * 1024 * 1024;        // 8MB backpressure
    const MAX_WAITS = 100;                       // max consecutive waits before timeout
    const READ_TIMEOUT = 5000;                   // 5s timeout for reading each chunk
    const MAX_RETRIES = 5;                       // max retry attempts
    const STORAGE_KEY_PREFIX = 'airdrop_transfer_';  // localStorage key prefix

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

    // ----- DOM elements -----
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

    // ----- Global state -----
    let pc = null;
    let dataChannels = [];          // all available data channels
    let ws = null;
    let roomId = '';
    let isInitiator = false;

    // Receiving state
    let receivingFileInfo = null;   // { name, size, mimeType }
    let receivedChunks = [];
    let isReceiving = false;

    // Sending queue
    let fileQueue = [];              // pending files (File objects)
    let isFileSending = false;      // currently sending a file
    let pendingFiles = [];           // copy of queue when sending starts

    // Store received blobs for download
    let receivedBlobs = new Map();

    // 接收端断点存储
    let receiveProgress = {};  // { fileId: { receivedChunks: Set<number>, info: {...} } }

    // ----- Helper functions -----
    // localStorage 存储断点信息
    function saveTransferProgress(fileId, data) {
      try {
        localStorage.setItem(STORAGE_KEY_PREFIX + fileId, JSON.stringify(data));
      } catch (e) {
        console.warn('无法保存断点信息:', e);
      }
    }

    function loadTransferProgress(fileId) {
      try {
        const data = localStorage.getItem(STORAGE_KEY_PREFIX + fileId);
        return data ? JSON.parse(data) : null;
      } catch (e) {
        console.warn('无法加载断点信息:', e);
        return null;
      }
    }

    function clearTransferProgress(fileId) {
      try {
        localStorage.removeItem(STORAGE_KEY_PREFIX + fileId);
      } catch (e) {
        console.warn('无法清除断点信息:', e);
      }
    }

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

    // ----- Queue UI -----
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

    // ----- WebRTC signaling -----
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
        updateStatus('传输通道错误，请重新连接', 'error');
      };
      channel.onclose = () => {
        console.log('DataChannel closed');
        updateStatus('连接已断开', 'error');
        // 清理发送状态
        isFileSending = false;
        pendingFiles = [];
        // 标记所有 active transfers 为失败
        activeTransfers.forEach((ctx, fid) => {
          if (!ctx.isFinished) {
            ctx.isFinished = true;
            const textElem = document.getElementById(`progress-text-${fid}`);
            if (textElem) textElem.textContent = '连接断开，传输失败';
          }
        });
      };
    }

    // ----- Data receiving logic -----
    function handleReceiveData(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        switch (msg.type) {
          case 'file-start':
            // start receiving a new file or resume
            receivingFileInfo = {
              name: msg.name,
              size: msg.size,
              mimeType: msg.mimeType || 'application/octet-stream',
              fileId: msg.fileId,
              chunkCount: msg.chunkCount
            };
            
            // 检查是否有断点信息
            const savedProgress = loadTransferProgress(msg.fileId);
            if (savedProgress && savedProgress.chunks && savedProgress.chunks.length > 0) {
              console.log('发现断点信息，已收到', savedProgress.chunks.length, '个chunks');
              receivedChunks = savedProgress.chunks.map(b => new Uint8Array(b));
            } else {
              receivedChunks = [];
            }
            isReceiving = true;
            updateStatus(`正在接收: ${msg.name}`, 'waiting');
            break;
            
          case 'file-resume-request':
            // 发送方请求恢复传输
            console.log('收到 file-resume-request, fileId:', msg.fileId, 'receivedChunks:', msg.receivedChunks);
            const saved = loadTransferProgress(msg.fileId);
            const startChunk = saved && saved.chunks ? saved.chunks.length : 0;
            
            // 恢复接收状态
            if (saved && saved.info) {
              receivingFileInfo = saved.info;
              receivedChunks = saved.chunks.map(b => new Uint8Array(b));
              isReceiving = true;
            }
            
            // 发送恢复确认
            const channel = dataChannels.find(c => c.readyState === 'open');
            if (channel) {
              channel.send(JSON.stringify({
                type: 'file-resume-ack',
                fileId: msg.fileId,
                startChunk: startChunk
              }));
              console.log('已发送 file-resume-ack, startChunk:', startChunk);
            }
            break;
            
          case 'file-resume-ack':
            // 发送方收到恢复确认
            if (window._onFileResumeAck) {
              window._onFileResumeAck(msg.fileId, msg.startChunk);
            }
            break;
            
          case 'file-end':
            console.log('收到 file-end, receivedChunks长度:', receivedChunks.length, 'receivingFileInfo:', !!receivingFileInfo);
            // all chunks received, assemble blob
            if (receivedChunks.length > 0 && receivingFileInfo) {
              const blob = new Blob(receivedChunks, { type: receivingFileInfo.mimeType });
              console.log('组装Blob完成，大小:', blob.size);
              downloadFile(blob, receivingFileInfo.name, msg.size);
              // send confirmation back to sender
              const ch = dataChannels.find(c => c.readyState === 'open');
              if (ch) {
                ch.send(JSON.stringify({ type: 'file-received', fileId: msg.fileId }));
                console.log('已发送 file-received 确认');
              }
              // 清除断点信息
              clearTransferProgress(msg.fileId);
            } else {
              console.warn('Received file-end but no data chunks', { receivedChunksLength: receivedChunks.length, receivingFileInfo });
            }
            // reset receiving state
            isReceiving = false;
            receivedChunks = [];
            receivingFileInfo = null;
            updateStatus('已连接', 'connected');
            break;
            
          case 'file-received':
            // This will be handled by the sender's per-file state (see sendFile)
            // We'll just forward it to the appropriate handler via a global event.
            if (window._onFileReceived && typeof window._onFileReceived === 'function') {
              window._onFileReceived(msg.fileId);
            }
            break;
            
          default:
            console.log('Unknown message type:', msg.type);
        }
      } else if (data instanceof ArrayBuffer || data instanceof Blob) {
        // Binary chunk
        if (isReceiving && receivingFileInfo) {
          // 检查是否重复接收
          const chunkIndex = Math.floor((receivedChunks.length * CHUNK_SIZE) / CHUNK_SIZE);
          
          receivedChunks.push(data);
          const receivedSize = receivedChunks.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.size), 0);
          const percent = ((receivedSize / receivingFileInfo.size) * 100).toFixed(1);
          updateStatus(`接收中: ${percent}%`, 'waiting');
          
          // 定期保存断点信息（每10个chunk保存一次）
          if (receivedChunks.length % 10 === 0) {
            const progressData = {
              chunks: Array.from(receivedChunks).map(c => new Uint8Array(c)),
              info: receivingFileInfo
            };
            saveTransferProgress(receivingFileInfo.fileId, progressData);
            console.log('已保存断点信息，chunks:', receivedChunks.length);
          }
        } else {
              console.warn('Received file-end but no data chunks', { receivedChunksLength: receivedChunks.length, receivingFileInfo });
            }
            // reset receiving state
            isReceiving = false;
            receivedChunks = [];
            receivingFileInfo = null;
            updateStatus('已连接', 'connected');
            break;
            
          case 'file-received':
            // This will be handled by the sender's per-file state (see sendFile)
            // We'll just forward it to the appropriate handler via a global event.
            if (window._onFileReceived && typeof window._onFileReceived === 'function') {
              window._onFileReceived(msg.fileId);
            }
            break;
            
          default:
            console.log('Unknown message type:', msg.type);
        }
      } else if (data instanceof ArrayBuffer || data instanceof Blob) {
        // Binary chunk
        if (isReceiving && receivingFileInfo) {
          receivedChunks.push(data);
          const receivedSize = receivedChunks.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.size), 0);
          const percent = ((receivedSize / receivingFileInfo.size) * 100).toFixed(1);
          updateStatus(`接收中: ${percent}%`, 'waiting');
        } else {
          console.warn('Received binary data but not in receiving state');
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

    // ----- File sending logic (with proper per-file state) -----
    // Map to store active file transfer contexts, keyed by fileId
    const activeTransfers = new Map();

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
      const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
      let retryCount = 0;
      let startChunk = 0;  // 断点重传起始位置
      
      // 检查是否有本地断点信息
      const savedProgress = loadTransferProgress(fileId + '_sender');
      if (savedProgress && savedProgress.startChunk > 0) {
        startChunk = savedProgress.startChunk;
        console.log('发现发送断点，从chunk', startChunk, '开始发送');
      }
      
      // Create UI element for this file
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
      
      // Get an open data channel
      const channel = dataChannels.find(c => c.readyState === 'open');
      if (!channel) {
        alert('没有可用的数据通道');
        return;
      }
      
      // Send file-start metadata (包含 chunkCount)
      channel.send(JSON.stringify({
        type: 'file-start',
        name: file.name,
        size: totalSize,
        mimeType: file.type || 'application/octet-stream',
        fileId: fileId,
        chunkCount: chunkCount,
        startChunk: startChunk  // 如果是断点续传，告知起始位置
      }));
      
      // Transfer context
      let offset = startChunk * CHUNK_SIZE;
      let bytesSent = startChunk * CHUNK_SIZE;
      let isFinished = false;
      let updateInterval = null;
      const startTime = performance.now();
      
      // 保存断点信息
      function saveProgress(chunkIndex) {
        try {
          localStorage.setItem(fileId + '_sender', JSON.stringify({
            startChunk: chunkIndex,
            fileName: file.name,
            totalSize: totalSize
          }));
        } catch (e) {
          console.warn('保存发送断点失败:', e);
        }
      }
      
      // Store context so we can handle file-received confirmation
      const context = {
        fileId,
        channel,
        totalSize,
        fileItem,
        file,
        receivedConfirmation: false,
        isFinished: false,
        retryCount: 0,
        startChunk: startChunk,
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
            // 显示重试次数或断点信息
            let statusText = `${sentMB}MB / ${totalMB}MB (${speedMBps}MB/s)`;
            if (startChunk > 0) {
              statusText = `[断点续传] ${statusText}`;
            }
            if (retryCount > 0) {
              statusText = `[重试 ${retryCount}/${MAX_RETRIES}] ${statusText}`;
            }
            textElem.textContent = statusText;
          }
        },
        finish: (success = true) => {
          if (updateInterval) clearInterval(updateInterval);
          const elapsed = (performance.now() - startTime) / 1000;
          const speedMBps = elapsed > 0 ? (bytesSent / 1024 / 1024 / elapsed).toFixed(1) : '0';
          const textElem = document.getElementById(`progress-text-${fileId}`);
          
          if (success && context.receivedConfirmation) {
            // 成功完成
            textElem.textContent = `发送完成 (平均速度: ${speedMBps}MB/s)`;
            // 清除断点信息
            clearTransferProgress(fileId + '_sender');
          } else if (!success) {
            // 失败
            if (retryCount < MAX_RETRIES) {
              // 自动重试
              retryCount++;
              console.log('开始第', retryCount, '次重试...');
              setTimeout(() => resumeTransfer(retryCount), 1000);
            } else {
              // 超过最大重试次数
              textElem.textContent = `发送失败 - 已重试${MAX_RETRIES}次仍失败`;
              clearTransferProgress(fileId + '_sender');
            }
          } else {
            // 超时但没有明确失败
            textElem.textContent = `发送超时 - 正在重试...`;
          }
          
          isFileSending = false;
        },
        
        // 恢复传输的函数
        resume: function(newStartChunk) {
          console.log('恢复传输，从chunk', newStartChunk, '开始');
          this.startChunk = newStartChunk;
          offset = newStartChunk * CHUNK_SIZE;
          bytesSent = newStartChunk * CHUNK_SIZE;
          startChunk = newStartChunk;
          saveProgress(newStartChunk);
          // 重新发送 file-start
          const ch = dataChannels.find(c => c.readyState === 'open');
          if (ch) {
            ch.send(JSON.stringify({
              type: 'file-start',
              name: file.name,
              size: totalSize,
              mimeType: file.type || 'application/octet-stream',
              fileId: fileId,
              chunkCount: chunkCount,
              startChunk: newStartChunk
            }));
          }
          // 重新启动发送循环
          sendLoop();
        }
      };
      
      // 恢复传输函数
      function resumeTransfer(attempt) {
        // 尝试恢复传输
        const ch = dataChannels.find(c => c.readyState === 'open');
        if (ch) {
          ch.send(JSON.stringify({
            type: 'file-resume-request',
            fileId: fileId,
            receivedChunks: startChunk
          }));
          // 等待恢复确认
        } else {
          // 连接已断开，需要重新连接
          context.finish(false);
        }
      }
      
      activeTransfers.set(fileId, context);
      
      // Register global callback for file-received confirmation
      window._onFileReceived = (confirmedFileId) => {
        console.log('收到 file-received 确认，fileId:', confirmedFileId, '期望:', fileId);
        if (confirmedFileId === fileId && activeTransfers.has(fileId)) {
          const ctx = activeTransfers.get(fileId);
          ctx.receivedConfirmation = true;
          console.log('设置 receivedConfirmation = true');
          if (!ctx.isFinished) {
            ctx.isFinished = true;
            ctx.finish(true);
          }
        }
      };
      
      // Register global callback for resume acknowledgement
      window._onFileResumeAck = (ackFileId, ackStartChunk) => {
        console.log('收到 resume ack, fileId:', ackFileId, 'startChunk:', ackStartChunk);
        if (ackFileId === fileId && activeTransfers.has(fileId)) {
          const ctx = activeTransfers.get(fileId);
          ctx.resume(ackStartChunk);
        }
      };
      
      // Read and send chunks
      const chunks = [];
      let consecutiveWaits = 0;
      
      async function readNextChunk() {
        if (offset >= totalSize) return null;
        try {
          const result = await Promise.race([
            new Promise((resolve, reject) => {
              const slice = file.slice(offset, offset + CHUNK_SIZE);
              const reader = new FileReader();
              reader.onload = (e) => {
                const data = e.target.result;
                const curOffset = offset;
                offset += CHUNK_SIZE;
                resolve({ data, offset: curOffset });
              };
              reader.onerror = () => reject(new Error('read error'));
              reader.readAsArrayBuffer(slice);
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT))
          ]);
          return result;
        } catch (e) {
          console.error('读取chunk失败:', e.message);
          // 跳过这个chunk，继续尝试下一个
          offset += CHUNK_SIZE;
          return null;
        }
      }
      
      async function sendLoop() {
        while (!isFinished && channel.readyState === 'open') {
          // Pre-read chunks
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
              consecutiveWaits = 0;  // Reset wait counter on successful send
            } else {
              await new Promise(r => setTimeout(r, 10));
              consecutiveWaits++;
            }
          } else if (offset >= totalSize && chunks.length === 0) {
            // All data sent, now send file-end message
            channel.send(JSON.stringify({
              type: 'file-end',
              fileId: fileId,
              size: totalSize,
              name: file.name
            }));
            // Mark as finished, but wait for receiver's confirmation
            isFinished = true;
            // We'll actually finish when we get file-received back (or timeout)
            // Set a safety timeout in case confirmation never arrives
            setTimeout(() => {
              if (activeTransfers.has(fileId)) {
                console.warn('No file-received confirmation, finishing anyway');
                const ctx = activeTransfers.get(fileId);
                if (ctx && !ctx.isFinished) {
                  ctx.isFinished = true;
                  ctx.finish(false);  // 触发重试
                }
              }
            }, 5000);
            break;
          } else {
            await new Promise(r => setTimeout(r, 10));
            consecutiveWaits++;
          }
          
          // Timeout protection: exit if too many consecutive waits
          if (consecutiveWaits > MAX_WAITS) {
            console.error('发送超时（连续等待过多），退出传输');
            isFinished = true;
            // 保存断点
            const currentChunk = Math.floor(bytesSent / CHUNK_SIZE);
            saveProgress(currentChunk);
            
            const textElem = document.getElementById(`progress-text-${fileId}`);
            if (textElem) textElem.textContent = `发送超时 - 准备重试 (${retryCount + 1}/${MAX_RETRIES})`;
            
            // 触发重试
            if (activeTransfers.has(fileId)) {
              context.finish(false);  // false 表示需要重试
            }
            break;
          }
        }
        
        // If channel closed prematurely
        if (channel.readyState !== 'open' && !isFinished) {
          console.error('DataChannel closed during transfer');
          isFinished = true;
          // 保存断点
          const currentChunk = Math.floor(bytesSent / CHUNK_SIZE);
          saveProgress(currentChunk);
          
          const textElem = document.getElementById(`progress-text-${fileId}`);
          if (textElem) textElem.textContent = `连接断开 - 准备重试 (${retryCount + 1}/${MAX_RETRIES})`;
          
          // 触发重试
          if (activeTransfers.has(fileId)) {
            context.finish(false);
          }
        }
      }
      
      // Start periodic UI updates
      updateInterval = setInterval(() => {
        if (!isFinished && activeTransfers.has(fileId)) {
          const ctx = activeTransfers.get(fileId);
          const now = performance.now();
          const elapsed = (now - startTime) / 1000;
          const speedMBps = elapsed > 0 ? (bytesSent / 1024 / 1024 / elapsed).toFixed(1) : '0';
          const sentMB = (bytesSent / 1024 / 1024).toFixed(1);
          const totalMB = (totalSize / 1024 / 1024).toFixed(1);
          const textElem = document.getElementById(`progress-text-${fileId}`);
          if (textElem) {
            let statusText = `${sentMB}MB / ${totalMB}MB (${speedMBps}MB/s)`;
            if (startChunk > 0) statusText = `[断点续传] ${statusText}`;
            if (retryCount > 0) statusText = `[重试 ${retryCount}/${MAX_RETRIES}] ${statusText}`;
            textElem.textContent = statusText;
          }
        }
      }, 200);
      
      sendLoop();
    }

    // ----- UI event binding -----
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
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        addToQueue(files);
        updateStatus('已通过粘贴添加 ' + files.length + ' 个文件', 'connected');
      }
    });
    sendBtn.addEventListener('click', sendQueuedFiles);
    joinBtn.addEventListener('click', joinRoom);
    roomInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinRoom(); });
  