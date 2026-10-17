import { generateSecret, deriveRoomId, deriveKey, encrypt, decrypt } from './crypto.js';

const $ = id => document.getElementById(id);
const SESSION_KEY = '2chat-role:';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

let pc = null, dc = null, cryptoKey = null, secret = null, roomId = null;
let wasBackgrounded = false;

init();

async function init() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) wasBackgrounded = true;
    else if (wasBackgrounded) {
      wasBackgrounded = false;
      const st = $('status');
      if (st) st.textContent = 'Вкладка была в фоне. Если сообщения не идут — переподключитесь';
    }
  });

  const hash = location.hash.slice(1);
  if (hash && hash.length >= 20) {
    secret = hash;
    roomId = await deriveRoomId(secret);
    cryptoKey = await deriveKey(secret, roomId);
    const role = sessionStorage.getItem(SESSION_KEY + secret);
    if (role === 'host') await startHost();
    else await startGuest();
  } else {
    showLobby();
  }
}

async function restoreHostUI() {
  // Восстанавливаем offer после F5 — не пересоздаём PeerConnection,
  // просто показываем старый код, чтобы можно было вставить ответ
  const saved = sessionStorage.getItem('2chat-offer:' + secret);
  if (!saved) return false;
  $('hostInviteLink').value = location.origin + location.pathname + '#' + secret;
  $('hostOffer').value = saved;
  $('hostStatus').textContent = 'Восстановлено после обновления. Вставьте ответный код.';
  return true;
}

function restoreGuestUI() {
  const saved = sessionStorage.getItem('2chat-answer:' + secret);
  if (!saved) return false;
  $('guestAnswer').value = saved;
  $('guestAnswerBox').hidden = false;
  $('guestStatus').textContent = 'Восстановлено после обновления. Отправьте код создателю.';
  return true;
}

function show(section) {
  ['lobby','hostSetup','guestSetup','chat'].forEach(s => $(s).hidden = s !== section);
}
function showLobby() {
  show('lobby');
  $('create').onclick = onHostCreate;
  $('joinBtn').onclick = onJoinClick;
}

async function onHostCreate() {
  secret = generateSecret();
  roomId = await deriveRoomId(secret);
  cryptoKey = await deriveKey(secret, roomId);
  sessionStorage.setItem(SESSION_KEY + secret, 'host');
  location.hash = secret;
  startHost();
}

async function onJoinClick() {
  const url = $('inviteInput').value.trim();
  if (!url) return;
  const m = url.match(/#([A-Za-z0-9_\-]{20,})$/);
  if (!m) { alert('В ссылке нет ключа (ожидается # + 20 и более символов)'); return; }
  secret = m[1];
  roomId = await deriveRoomId(secret);
  cryptoKey = await deriveKey(secret, roomId);
  sessionStorage.setItem(SESSION_KEY + secret, 'guest');
  location.hash = secret;
  startGuest();
}

// ---------- HOST ----------
async function startHost() {
  show('hostSetup');
  if (await restoreHostUI()) return;

  $('hostInviteLink').value = location.origin + location.pathname + '#' + secret;
  $('hostStatus').textContent = 'Готовлю код…';

  pc = new RTCPeerConnection(RTC_CONFIG);
  watchPc(pc);
  dc = pc.createDataChannel('chat', { ordered: true });
  setupDC(dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  const offerCode = 'O:' + encodeSdp(pc.localDescription);
  $('hostOffer').value = offerCode;
  sessionStorage.setItem('2chat-offer:' + secret, offerCode);
  $('hostStatus').textContent = 'Готово. Отправьте ссылку и код собеседнику.';
}

function watchPc(p) {
  p.addEventListener('iceconnectionstatechange', () => {
    if (p.iceConnectionState === 'failed') setStatus('ICE не установился — вероятно нужен TURN');
    else if (p.iceConnectionState === 'disconnected') setStatus('Соединение потеряно');
  });
}
function setStatus(s) { const el = $('status'); if (el) el.textContent = s; }

$('copyLinkBtn').onclick = () => copyText($('hostInviteLink').value, $('copyLinkBtn'));
$('copyOfferBtn').onclick = () => copyText($('hostOffer').value, $('copyOfferBtn'));

$('connectBtn').onclick = async () => {
  let code = $('hostAnswer').value.trim();
  if (!code) return;
  if (code.startsWith('A:')) code = code.slice(2);
  if (!code.startsWith('v=') && !/^[A-Za-z0-9_\-]+$/.test(code)) {
    $('hostStatus').textContent = 'Неверный код. Скопируйте код целиком (начинается с "A:")';
    return;
  }
  try {
    await pc.setRemoteDescription(decodeSdp(code.replace(/^A:/, '')));
    $('hostStatus').textContent = 'Жду установления соединения…';
  } catch (e) {
    $('hostStatus').textContent = 'Ошибка декодирования: ' + e.message;
  }
};

$('hostCancel').onclick = () => {
  sessionStorage.removeItem(SESSION_KEY + secret);
  try { pc?.close(); } catch {}
  location.hash = '';
  location.reload();
};

// ---------- GUEST ----------
async function startGuest() {
  show('guestSetup');
  restoreGuestUI();
}

$('genAnswerBtn').onclick = async () => {
  let code = $('guestOffer').value.trim();
  if (!code) return;
  if (code.startsWith('O:')) code = code.slice(2);
  try {
    pc = new RTCPeerConnection(RTC_CONFIG);
    watchPc(pc);
    pc.ondatachannel = e => { dc = e.channel; setupDC(dc); };

    await pc.setRemoteDescription(decodeSdp(code));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);

    const ansCode = 'A:' + encodeSdp(pc.localDescription);
    $('guestAnswer').value = ansCode;
    sessionStorage.setItem('2chat-answer:' + secret, ansCode);
    $('guestAnswerBox').hidden = false;
    $('guestStatus').textContent = 'Отправьте код создателю (начинается с "A:").';
  } catch (e) {
    $('guestStatus').textContent = 'Ошибка: ' + e.message;
  }
};

$('copyAnswerBtn').onclick = () => copyText($('guestAnswer').value, $('copyAnswerBtn'));

$('guestCancel').onclick = () => {
  try { pc?.close(); } catch {}
  location.hash = '';
  location.reload();
};

// ---------- COMMON ----------
function setupDC(channel) {
  const label = (cryptoKey ? '🔑 ' : '🔒 ') + (roomId ? roomId.slice(0,6) : '');
  channel.onopen = () => {
    show('chat');
    setStatus(label + ' · канал открыт');
    // Тестовый пинг
    try { channel.send(JSON.stringify({ type: 'ping' })); } catch {}
  };
  channel.onmessage = async e => {
    let data = e.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    if (!data) return;
    if (data.type === 'ping') { setStatus(label + ' · на связи ✓'); return; }
    if (data.type !== 'msg') return;
    try {
      const text = await decrypt(cryptoKey, data.iv, data.ct);
      renderMessage(text, 'them');
    } catch (err) {
      console.error('decrypt failed', err);
      renderMessage('[не удалось расшифровать]', 'them');
    }
  };
  channel.onclose = () => setStatus(label + ' · собеседник отключился');
  channel.onerror = err => {
    console.error('dc error', err);
    setStatus(label + ' · ошибка канала');
  };
  // Оповещение о разрыве ICE
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      if (!pc) return;
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        setStatus(label + ' · разрыв ICE (' + pc.iceConnectionState + ')');
      }
    });
  }
}

function waitIce(p, timeout = 8000) {
  return new Promise(resolve => {
    if (p.iceGatheringState === 'complete') return resolve();
    const done = () => {
      p.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => { if (p.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    p.addEventListener('icegatheringstatechange', onChange);
  });
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function encodeSdp(desc) {
  return b64encode(JSON.stringify({ type: desc.type, sdp: desc.sdp }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeSdp(str) {
  // Убираем ВСЁ, кроме символов base64 (защита от пробелов/переводов строк из мессенджеров)
  let s = String(str).replace(/[^A-Za-z0-9\-_+/=]/g, '');
  // Оставляем только один сегмент (если случайно склеилось два кода)
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  // Убираем любые паддинги и добавляем заново корректно
  s = s.replace(/=+$/, '');
  while (s.length % 4) s += '=';
  const decoded = b64decode(s);
  if (!decoded.startsWith('{')) {
    throw new Error('код повреждён или обрезан при копировании. Перешлите код заново одним куском');
  }
  return JSON.parse(decoded);
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }
  const orig = btn.textContent;
  btn.textContent = '✓ Скопировано';
  setTimeout(() => (btn.textContent = orig), 1500);
}

function renderMessage(text, who) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.textContent = text;
  const box = $('messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

$('msgForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  renderMessage(text, 'me');
  if (!dc || dc.readyState !== 'open') {
    setStatus('Нет соединения (dc.readyState=' + (dc ? dc.readyState : 'null') + ')');
    return;
  }
  try {
    const payload = await encrypt(cryptoKey, text);
    dc.send(JSON.stringify({ type: 'msg', ...payload }));
    setStatus('✓ отправлено');
    setTimeout(() => setStatus('на связи'), 800);
  } catch (err) {
    console.error('send error', err);
    setStatus('Ошибка отправки: ' + err.message);
  }
});

$('leave').onclick = () => {
  sessionStorage.removeItem(SESSION_KEY + secret);
  try { dc?.close(); pc?.close(); } catch {}
  location.hash = '';
  location.reload();
};
