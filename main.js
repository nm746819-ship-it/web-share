import Peer from 'peerjs';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';

// ===== DOM ELEMENTS =====
const $ = (sel) => document.querySelector(sel);
const viewHome = $('#viewHome');
const viewWaiting = $('#viewWaiting');
const viewConnected = $('#viewConnected');
const connectionStatus = $('#connectionStatus');
const statusText = connectionStatus.querySelector('.status-text');

const btnCreateRoom = $('#btnCreateRoom');
const btnJoinRoom = $('#btnJoinRoom');
const btnScanQR = $('#btnScanQR');
const joinModal = $('#joinModal');
const joinCodeInput = $('#joinCodeInput');
const btnCancelJoin = $('#btnCancelJoin');
const btnConfirmJoin = $('#btnConfirmJoin');
const roomCodeText = $('#roomCodeText');
const btnCopyCode = $('#btnCopyCode');
const btnCancelWaiting = $('#btnCancelWaiting');
const btnDisconnect = $('#btnDisconnect');
const peerIdDisplay = $('#peerIdDisplay');
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const transferList = $('#transferList');
const toastContainer = $('#toastContainer');
const qrCanvas = $('#qrCanvas');
const scanModal = $('#scanModal');
const btnCancelScan = $('#btnCancelScan');

// ===== STATE =====
let peer = null;
let conn = null;
let roomCode = '';
let transfers = new Map();

// ===== UTILS =====
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ===== VIEW SWITCHING =====
function showView(view) {
  [viewHome, viewWaiting, viewConnected].forEach(v => v.classList.remove('active'));
  view.classList.add('active');
  // Re-trigger animation
  void view.offsetWidth;
}

function setConnected(connected) {
  if (connected) {
    connectionStatus.classList.add('connected');
    statusText.textContent = 'Connected';
  } else {
    connectionStatus.classList.remove('connected');
    statusText.textContent = 'Not Connected';
  }
}

// ===== PEER FUNCTIONS =====
function createPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id, {
      debug: 0,
    });
    p.on('open', () => resolve(p));
    p.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'unavailable-id') {
        // ID already in use, generate a new one
        reject(new Error('Room code already in use. Try again.'));
      } else {
        reject(err);
      }
    });
  });
}

function setupConnection(connection) {
  conn = connection;
  conn.on('open', () => {
    setConnected(true);
    peerIdDisplay.textContent = conn.peer.substring(3); // remove ws- prefix
    showView(viewConnected);
    clearTransfers();
    showToast('🔗 Peer connected!');
  });

  conn.on('data', (data) => handleIncomingData(data));

  conn.on('close', () => {
    setConnected(false);
    conn = null;
    showView(viewHome);
    showToast('Connection closed');
  });

  conn.on('error', (err) => {
    console.error('Connection error:', err);
    showToast('Connection error');
  });
}

// ===== FILE TRANSFER =====
const CHUNK_SIZE = 16 * 1024; // 16KB

function sendFile(file) {
  if (!conn || !conn.open) {
    showToast('Not connected to a peer');
    return;
  }

  const transferId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Send file metadata
  conn.send({
    type: 'file-meta',
    transferId,
    name: file.name,
    size: file.size,
    fileType: file.type,
    totalChunks,
  });

  // Add to transfer list (sender side)
  addTransferItem(transferId, file.name, file.size, 'sending');

  // Read and send chunks
  let offset = 0;
  let chunkIndex = 0;
  const reader = new FileReader();

  function readNextChunk() {
    if (offset >= file.size) return;
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  reader.onload = (e) => {
    conn.send({
      type: 'file-chunk',
      transferId,
      chunkIndex,
      data: e.target.result,
    });

    chunkIndex++;
    offset += CHUNK_SIZE;
    const progress = Math.min(100, Math.round((offset / file.size) * 100));
    updateTransferProgress(transferId, progress);

    if (offset < file.size) {
      // Small delay to avoid overwhelming the data channel
      setTimeout(readNextChunk, 5);
    } else {
      // Send completion signal
      conn.send({ type: 'file-complete', transferId });
      completeTransfer(transferId);
    }
  };

  reader.onerror = () => {
    showToast(`Error reading ${file.name}`);
  };

  readNextChunk();
}

// ===== INCOMING DATA HANDLER =====
const incomingFiles = new Map();

function handleIncomingData(data) {
  if (data.type === 'file-meta') {
    incomingFiles.set(data.transferId, {
      name: data.name,
      size: data.size,
      fileType: data.fileType,
      totalChunks: data.totalChunks,
      chunks: [],
      received: 0,
    });
    addTransferItem(data.transferId, data.name, data.size, 'receiving');
  }

  else if (data.type === 'file-chunk') {
    const file = incomingFiles.get(data.transferId);
    if (!file) return;
    file.chunks[data.chunkIndex] = data.data;
    file.received++;
    const progress = Math.min(100, Math.round((file.received / file.totalChunks) * 100));
    updateTransferProgress(data.transferId, progress);
  }

  else if (data.type === 'file-complete') {
    const file = incomingFiles.get(data.transferId);
    if (!file) return;
    // Assemble file and download
    const blob = new Blob(file.chunks, { type: file.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    incomingFiles.delete(data.transferId);
    completeTransfer(data.transferId);
    showToast(`📥 Received: ${file.name}`);
  }
}

// ===== TRANSFER UI =====
function clearTransfers() {
  transfers.clear();
  transferList.innerHTML = `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
      </svg>
      <p>No transfers yet</p>
    </div>
  `;
}

function addTransferItem(id, name, size, direction) {
  // Remove empty state
  const empty = transferList.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'transfer-item';
  item.id = `transfer-${id}`;

  const iconType = direction === 'sending' ? 'sending' : 'receiving';
  const arrowSvg = direction === 'sending'
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 15 3 19 7 23"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

  item.innerHTML = `
    <div class="transfer-file-icon ${iconType}">
      ${arrowSvg}
    </div>
    <div class="transfer-details">
      <div class="transfer-name">${escapeHtml(name)}</div>
      <div class="transfer-meta">
        <span>${formatSize(size)}</span>
        <span>•</span>
        <span>${direction === 'sending' ? 'Sending' : 'Receiving'}...</span>
      </div>
      <div class="transfer-progress-bar">
        <div class="transfer-progress-fill" style="width: 0%"></div>
      </div>
    </div>
    <div class="transfer-percent">0%</div>
  `;

  transferList.prepend(item);
  transfers.set(id, { name, size, direction });
}

function updateTransferProgress(id, progress) {
  const item = document.getElementById(`transfer-${id}`);
  if (!item) return;
  item.querySelector('.transfer-progress-fill').style.width = progress + '%';
  item.querySelector('.transfer-percent').textContent = progress + '%';
}

function completeTransfer(id) {
  const item = document.getElementById(`transfer-${id}`);
  if (!item) return;
  const icon = item.querySelector('.transfer-file-icon');
  icon.className = 'transfer-file-icon done';
  icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  item.querySelector('.transfer-progress-fill').style.width = '100%';
  item.querySelector('.transfer-percent').textContent = '✓';
  const meta = item.querySelector('.transfer-meta');
  const spans = meta.querySelectorAll('span');
  if (spans[2]) spans[2].textContent = 'Complete';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== EVENT LISTENERS =====

// Create Room
btnCreateRoom.addEventListener('click', async () => {
  roomCode = generateCode();
  const peerId = 'ws-' + roomCode;

  try {
    peer = await createPeer(peerId);
  } catch (err) {
    showToast(err.message || 'Failed to create room');
    return;
  }

  roomCodeText.textContent = roomCode;
  showView(viewWaiting);

  // Generate QR Code
  QRCode.toCanvas(qrCanvas, roomCode, {
    width: 200,
    margin: 1,
    color: {
      dark: '#0a0a1a',
      light: '#ffffff'
    }
  }, (err) => {
    if (!err) {
      qrCanvas.parentElement.classList.add('visible');
    }
  });

  peer.on('connection', (connection) => {
    setupConnection(connection);
  });

  peer.on('disconnected', () => {
    if (!conn) {
      showView(viewHome);
      showToast('Disconnected from server');
    }
  });
});

// Join Room
btnJoinRoom.addEventListener('click', () => {
  joinCodeInput.value = '';
  joinModal.classList.add('active');
  setTimeout(() => joinCodeInput.focus(), 200);
});

btnCancelJoin.addEventListener('click', () => {
  joinModal.classList.remove('active');
});

joinModal.addEventListener('click', (e) => {
  if (e.target === joinModal) joinModal.classList.remove('active');
});

async function connectToRoom(code) {
  const myId = 'ws-' + generateCode() + '-cli';

  try {
    peer = await createPeer(myId);
  } catch (err) {
    showToast(err.message || 'Failed to connect');
    return;
  }

  const connection = peer.connect('ws-' + code, { reliable: true });
  setupConnection(connection);

  // Timeout if connection doesn't open
  setTimeout(() => {
    if (!conn || !conn.open) {
      showToast('Could not connect. Check the room code.');
      if (peer) { peer.destroy(); peer = null; }
    }
  }, 10000);
}

btnConfirmJoin.addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    showToast('Please enter a 6-character code');
    return;
  }
  joinModal.classList.remove('active');
  connectToRoom(code);
});

// Scan QR Code
let html5QrCode;

btnScanQR.addEventListener('click', () => {
  scanModal.classList.add('active');
  
  // Initialize scanner
  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("qr-reader");
  }

  const config = { fps: 10, qrbox: { width: 250, height: 250 } };

  html5QrCode.start(
    { facingMode: "environment" },
    config,
    (decodedText, decodedResult) => {
      // Handle on success
      const code = decodedText.trim().toUpperCase();
      if (code.length === 6 && /^[A-Z0-9]+$/.test(code)) {
        html5QrCode.stop().then(() => {
          scanModal.classList.remove('active');
          connectToRoom(code);
        }).catch((err) => {
          console.error("Failed to stop scanner", err);
        });
      }
    },
    (errorMessage) => {
      // parse errors, can be ignored
    }
  ).catch((err) => {
    showToast('Could not start camera');
    scanModal.classList.remove('active');
    console.error(err);
  });
});

btnCancelScan.addEventListener('click', () => {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => {
      scanModal.classList.remove('active');
    }).catch((err) => {
      console.error(err);
      scanModal.classList.remove('active');
    });
  } else {
    scanModal.classList.remove('active');
  }
});

// Enter key on join input
joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConfirmJoin.click();
});

// Cancel waiting
btnCancelWaiting.addEventListener('click', () => {
  if (peer) { peer.destroy(); peer = null; }
  showView(viewHome);
  qrCanvas.parentElement.classList.remove('visible');
});

// Copy room code
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast('📋 Code copied!');
  }).catch(() => {
    showToast('Could not copy');
  });
});

// Disconnect
btnDisconnect.addEventListener('click', () => {
  if (conn) conn.close();
  if (peer) { peer.destroy(); peer = null; }
  conn = null;
  setConnected(false);
  showView(viewHome);
});

// Drop zone click → file picker
dropZone.addEventListener('click', () => fileInput.click());

// File selected via picker
fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (!files.length) return;
  for (const file of files) sendFile(file);
  fileInput.value = ''; // reset
});

// Drag & drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (!files.length) return;
  for (const file of files) sendFile(file);
});
