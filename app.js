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
  
  let hash = location.hash.replace(/^#/, '');

  if (hash && hash.length >= 20) {
    secret = hash;
    localStorage.setItem('2chat_secret', secret);
    history.replaceState(null, '', '#' + secret);
    roomId = await deriveRoomId(secret);
    cryptoKey = await deriveKey(secret, roomId);
    showChat();
    connect();
  } else {
    showLobby();
  }
}

function showLobby() { $('lobby').hidden = false; $('chat').hidden = true; }
function showChat() { 
  $('lobby').hidden = true; $('chat').hidden = false; 
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

async function onHostCreate() {
  try {
    secret = generateSecret();
    localStorage.setItem("2chat_secret", secret);
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
    localStorage.setItem("2chat_secret", secret);
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
  ws.onclose = (event) => {
    if (event.code === 1006) {
      setBaseStatus('Ошибка сети. Если вы используете VPN, попробуйте его отключить или сменить сервер.');
    } else {
      setBaseStatus('Переподключение…');
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
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
    try { 
      const text = await decrypt(cryptoKey, data.iv, data.ct);
      renderMessage(text, 'them');
      notifyUser(text);
    }
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
  try { 
    let finalFile = file;
    if (file.type.startsWith('image/')) {
      setBaseStatus('Сжимаю картинку...');
      finalFile = await compressImage(file);
      setBaseStatus('На связи');
    }
    await sendFile(finalFile); 
  } catch (err) { alert('Ошибка: ' + err.message); }
});


async function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return resolve(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      const MAX = 1200;
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round((height * MAX) / width); width = MAX; }
        else { width = Math.round((width * MAX) / height); height = MAX; }
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) return resolve(file);
        resolve(new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

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
    const audioWrap = document.createElement('div');
    audioWrap.className = 'custom-audio';
    
    const audio = document.createElement('audio');
    audio.src = url;
    
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'play-btn';
    playBtn.textContent = '▶';
    
    const progress = document.createElement('input');
    progress.type = 'range';
    progress.className = 'audio-progress';
    progress.value = 0; progress.max = 100;
    
    const timeLbl = document.createElement('span');
    timeLbl.className = 'audio-time';
    timeLbl.textContent = '0:00';
    
    playBtn.onclick = () => {
      if (audio.paused) { audio.play(); playBtn.textContent = '❚❚'; }
      else { audio.pause(); playBtn.textContent = '▶'; }
    };
    audio.onended = () => { playBtn.textContent = '▶'; progress.value = 0; timeLbl.textContent = '0:00'; };
    audio.ontimeupdate = () => {
      if (!audio.duration) return;
      progress.value = (audio.currentTime / audio.duration) * 100;
      const m = Math.floor(audio.currentTime / 60);
      const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0');
      timeLbl.textContent = m + ':' + s;
    };
    progress.oninput = () => {
      if (audio.duration) audio.currentTime = (progress.value / 100) * audio.duration;
    };
    
    audioWrap.appendChild(playBtn);
    audioWrap.appendChild(progress);
    audioWrap.appendChild(timeLbl);
    el.appendChild(audioWrap);
  }

  const footer = document.createElement('div');
  footer.className = 'file-footer';
  
  const info = document.createElement('span');
  info.className = 'file-info';
  info.textContent = type.startsWith('audio/') ? 'Голосовое сообщение' : name;
  
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

function bytesToB64(data) {
  let u8 = data;
  if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (data && data.buffer instanceof ArrayBuffer && !(data instanceof Uint8Array)) {
    u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (!(data instanceof Uint8Array)) {
    u8 = new Uint8Array(Object.values(data));
  }
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

// Очистка памяти при выходе
const leaveBtn = document.getElementById('leave');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => localStorage.removeItem('2chat_secret'));
}

// --- Голосовые сообщения ---
let mediaRecorder;
let audioChunks = [];
const micBtn = document.getElementById('micBtn');
if (micBtn) {
  micBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      micBtn.classList.remove('recording');
      micBtn.textContent = '🎤';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const file = new File([blob], 'Голосовое_' + Date.now() + '.webm', { type: 'audio/webm' });
        try { await sendFile(file); } catch (err) { alert('Ошибка отправки: ' + err.message); }
      };
      mediaRecorder.start();
      micBtn.classList.add('recording');
      micBtn.textContent = '🔴';
      setBaseStatus('Идёт запись...');
    } catch (err) {
      alert('Нет доступа к микрофону. Разрешите доступ в настройках браузера.');
    }
  });
}

// --- СИСТЕМА УВЕДОМЛЕНИЙ ---
function playBeep() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) { console.log('Ошибка звука:', e); }
}

function notifyUser(text) {
  if (document.hasFocus()) return; // Не беспокоим, если вкладка открыта
  playBeep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('2chat: Новое сообщение', { body: text || 'Вам пришло сообщение' });
  }
}

document.getElementById('msgInput').addEventListener('focus', () => {
  setTimeout(() => {
    const box = document.getElementById('messages');
    if (box) box.scrollTop = box.scrollHeight;
  }, 300);
});

// Фикс скролла при возврате на вкладку
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const box = document.getElementById('messages');
    if (box) {
      box.style.overflow = 'hidden';
      setTimeout(() => { box.style.overflow = 'auto'; }, 50);
    }
  }
});
