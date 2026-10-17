import { generateSecret, deriveRoomId, deriveKey, encrypt, decrypt,
         encryptBytes, decryptBytes } from './crypto.js';

const WORKER_URL = 'wss://chat2-relay.2chat-dirtdigger.workers.dev';
const $ = id => document.getElementById(id);
const FILE_MAX = 8 * 1024 * 1024;
const CHUNK = 32 * 1024;

let ws = null, cryptoKey = null, roomId = null, secret = null;
let reconnectDelay = 800;
let pendingMessages = [];
let baseStatus = '';
let typingTimer = null, lastTypingSent = 0;
let currentFile = null;
let renderedIds = new Set();

window.addEventListener('error', e => {
  const el = document.getElementById('status');
  if (el) el.textContent = 'Ошибка: ' + (e.message || 'неизвестная');
});

init().catch(err => {
  console.error(err);
  alert('Ошибка запуска: ' + err.message);
});

async function init() {
  $('create').addEventListener('click', onHostCreate);
  $('joinBtn').addEventListener('click', onJoinClick);
  const hash = location.hash.replace(/^#/, '');
  if (hash && hash.length >= 20) {
    secret = hash;
    roomId = await deriveRoomId(secret);
    cryptoKey = await deriveKey(secret, roomId);
    showChat();
    connect();
  } else {
    showLobby();
  }
}

function showLobby() { $('lobby').hidden = false; $('chat').hidden = true; }
function showChat() { $('lobby').hidden = true; $('chat').hidden = false; }

async function onHostCreate() {
  try {
    secret = generateSecret();
    roomId = await deriveRoomId(secret);
    cryptoKey = await deriveKey(secret, roomId);
    history.replaceState(null, '', '#' + secret);
    $('inviteLink').value = location.origin + location.pathname + '#' + secret;
    showChat();
    connect();
  } catch (err) { alert('Ошибка: ' + err.message); }
}

async function onJoinClick() {
  const url = $('inviteInput').value.trim();
  const m = url.match(/#([A-Za-z0-9_\-]{20,})$/);
  if (!m) { alert('В ссылке нет ключа'); return; }
  try {
    secret = m[1];
    roomId = await deriveRoomId(secret);
    cryptoKey = await deriveKey(secret, roomId);
    history.replaceState(null, '', '#' + secret);
    $('inviteLink').value = location.origin + location.pathname + '#' + secret;
    showChat();
    connect();
  } catch (err) { alert('Ошибка: ' + err.message); }
}

function connect() {
  const url = WORKER_URL + '/room/' + roomId;
  setBaseStatus('Подключение…');
  try { ws = new WebSocket(url); } catch (e) { setBaseStatus('Ошибка: ' + e.message); return; }
  ws.onopen = () => {
    reconnectDelay = 800;
    while (pendingMessages.length) { try { ws.send(pendingMessages.shift()); } catch {} }
  };
  ws.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch { return; } handleIncoming(d); };
  ws.onclose = () => { setBaseStatus('Переподключение…'); setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.6, 15000); };
  ws.onerror = () => setBaseStatus('Ошибка сети, переподключение…');
}

function send(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (ws && ws.readyState === 1) { try { ws.send(str); return; } catch {} }
  pendingMessages.push(str);
}

async function handleIncoming(data) {
  if (!data || !data.type) return;
  if (data.type === 'presence') { setBaseStatus(data.count >= 2 ? 'На связи' : 'Ждём собеседника…'); return; }
  if (data.type === 'typing') { flashStatus('✍ печатает…'); return; }
  if (data.type === 'msg') {
    if (data.id && renderedIds.has(data.id)) return;
    if (data.id) renderedIds.add(data.id);
    try { renderMessage(await decrypt(cryptoKey, data.iv, data.ct), 'them'); }
    catch (err) { renderMessage('[не расшифровано]', 'them'); }
    return;
  }
  if (data.type === 'file-start') { currentFile = { id: data.msgId, name: data.name, mime: data.mime, chunks: [], iv: null }; return; }
  if (data.type === 'file-chunk') {
    if (!currentFile || currentFile.id !== data.msgId) return;
    const bytes = b64ToBytes(data.data);
    if (!currentFile.iv) currentFile.iv = bytes; else currentFile.chunks.push(bytes);
    return;
  }
  if (data.type === 'file-end') {
    if (!currentFile || currentFile.id !== data.msgId) return;
    const f = currentFile; currentFile = null;
    if (f.id && renderedIds.has(f.id)) return;
    if (f.id) renderedIds.add(f.id);
    try {
      const total = f.chunks.reduce((s, c) => s + c.byteLength, 0);
      const ct = new Uint8Array(total);
      let off = 0;
      for (const c of f.chunks) { ct.set(c, off); off += c.byteLength; }
      const plain = await decryptBytes(cryptoKey, f.iv, ct);
      renderFile({ name: f.name, type: f.mime, blob: new Blob([plain], { type: f.mime }) }, 'them');
    } catch (err) { renderMessage('[файл не расшифрован]', 'them'); }
    return;
  }
}

$('msgInput').addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTypingSent < 1500) return;
  lastTypingSent = now;
  send({ type: 'typing' });
});

$('msgForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  renderMessage(text, 'me');
  const id = Math.random().toString(36).slice(2, 11);
  renderedIds.add(id);
  const payload = await encrypt(cryptoKey, text);
  send({ type: 'msg', id, ...payload });
});

$('attachBtn').addEventListener('click', e => { e.preventDefault(); $('fileInput').click(); });
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > FILE_MAX) { alert('Максимум 8 МБ'); return; }
  try { await sendFile(file); } catch (err) { alert('Ошибка: ' + err.message); }
});

async function sendFile(file) {
  const msgId = Math.random().toString(36).slice(2, 11);
  renderedIds.add(msgId);
  renderFile({ name: file.name, type: file.type || 'application/octet-stream', blob: file }, 'me');
  setBaseStatus('шифрую файл…');
  const buf = await file.arrayBuffer();
  const { iv, ct } = await encryptBytes(cryptoKey, buf);
  const mime = file.type || 'application/octet-stream';
  send({ type: 'file-start', msgId, name: file.name, mime });
  send({ type: 'file-chunk', msgId, data: bytesToB64(iv) });
  const total = ct.byteLength;
  let sent = 0;
  for (let i = 0; i < total; i += CHUNK) {
    const slice = ct.subarray(i, Math.min(i + CHUNK, total));
    send({ type: 'file-chunk', msgId, data: bytesToB64(slice) });
    sent += slice.byteLength;
    setBaseStatus(`отправка ${Math.round(sent/total*100)}%`);
    if (ws && ws.bufferedAmount > 1_000_000) await new Promise(r => setTimeout(r, 50));
  }
  send({ type: 'file-end', msgId });
  setBaseStatus('На связи');
}

function renderMessage(text, who) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.textContent = text;
  appendToLog(el);
}
function renderFile(file, who) {
  const el = document.createElement('div');
  el.className = 'msg file ' + who;
  const blob = file.blob || file;
  const url = URL.createObjectURL(blob);
  const type = file.type || blob.type || '';
  const name = file.name || 'файл';
  
  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url; img.className = 'file-preview';
    el.appendChild(img);
  } else if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url; video.controls = true; video.className = 'file-preview';
    el.appendChild(video);
  } else if (type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.src = url; audio.controls = true; audio.className = 'file-preview';
    el.appendChild(audio);
  }

  const footer = document.createElement('div');
  footer.className = 'file-footer';
  
  const info = document.createElement('span');
  info.className = 'file-info';
  info.textContent = name;
  
  const a = document.createElement('a');
  a.href = url; a.download = name; a.className = 'file-download';
  a.textContent = '⬇️';
  
  footer.appendChild(info);
  footer.appendChild(a);
  el.appendChild(footer);
  
  appendToLog(el);
}
function appendToLog(el) {
  const box = $('messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function setBaseStatus(s) {
  baseStatus = s;
  const el = $('status');
  el.textContent = s;
  el.classList.remove('typing');
}
function flashStatus(t, ms = 2200) {
  const el = $('status');
  el.textContent = t; el.classList.add('typing');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { el.textContent = baseStatus; el.classList.remove('typing'); }, ms);
}

function bytesToB64(u8) {
  let bin = '';
  const c = 0x8000;
  for (let i = 0; i < u8.length; i += c)
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + c));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

$('copyBtn').addEventListener('click', async () => {
  const val = $('inviteLink').value;
  try { await navigator.clipboard.writeText(val); }
  catch { $('inviteLink').select(); document.execCommand('copy'); }
  $('copyBtn').textContent = '✓';
  setTimeout(() => ($('copyBtn').textContent = 'Копировать'), 1200);
});

$('leave').addEventListener('click', () => {
  try { ws && ws.close(); } catch {}
  history.replaceState(null, '', location.pathname);
  location.reload();
});
