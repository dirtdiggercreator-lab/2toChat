import { generateSecret, deriveRoomId, deriveKey, encrypt, decrypt } from './crypto.js';

const $ = id => document.getElementById(id);
const SESSION_KEY = '2chat-role:';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

let pc = null;
let dc = null;
let cryptoKey = null;
let secret = null;

init();

async function init() {
  const hash = location.hash.slice(1);
  if (hash && hash.length >= 20) {
    secret = hash;
    const role = sessionStorage.getItem(SESSION_KEY + secret);
    cryptoKey = await deriveKey(secret, await deriveRoomId(secret));
    if (role === 'host') await startHost();
    else await startGuest();
  } else {
    showLobby();
  }
}

function show(section) {
  ['lobby','hostSetup','guestSetup','chat'].forEach(s => {
    $(s).hidden = s !== section;
  });
}
function showLobby() { show('lobby'); $('create').onclick = onHostCreate; $('joinBtn').onclick = onJoinClick; }

$('create').onclick = onHostCreate;
$('joinBtn').onclick = onJoinClick;

function onHostCreate() {
  secret = generateSecret();
  sessionStorage.setItem(SESSION_KEY + secret, 'host');
  location.hash = secret;
  startHost();
}

function onJoinClick() {
  const url = $('inviteInput').value.trim();
  if (!url) return;
  const m = url.match(/#(.{20,})$/);
  if (!m) { alert('В ссылке нет ключа'); return; }
  secret = m[1];
  location.hash = secret;
  startGuest();
}

// ---------- HOST ----------
async function startHost() {
  show('hostSetup');
  $('hostInviteLink').value = location.origin + location.pathname + '#' + secret;
  $('hostStatus').textContent = 'Готовлю код…';

  pc = new RTCPeerConnection(RTC_CONFIG);
  dc = pc.createDataChannel('chat', { ordered: true });
  setupDC(dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  $('hostOffer').value = encodeSdp(pc.localDescription);
  $('hostStatus').textContent = 'Отправьте ссылку и код собеседнику, затем вставьте ответный код.';
}

$('copyLinkBtn').onclick = () => copyText($('hostInviteLink').value, $('copyLinkBtn'));
$('copyOfferBtn').onclick = () => copyText($('hostOffer').value, $('copyOfferBtn'));

$('connectBtn').onclick = async () => {
  const code = $('hostAnswer').value.trim();
  if (!code) return;
  try {
    await pc.setRemoteDescription(decodeSdp(code));
    $('hostStatus').textContent = 'Жду установления соединения…';
  } catch (e) {
    $('hostStatus').textContent = 'Ошибка: ' + e.message;
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
}

$('genAnswerBtn').onclick = async () => {
  const code = $('guestOffer').value.trim();
  if (!code) return;
  try {
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ondatachannel = e => { dc = e.channel; setupDC(dc); };

    await pc.setRemoteDescription(decodeSdp(code));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);

    $('guestAnswer').value = encodeSdp(pc.localDescription);
    $('guestAnswerBox').hidden = false;
    $('guestStatus').textContent = 'Отправьте код создателю.';
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
  channel.onopen = () => { show('chat'); };
  channel.onmessage = async e => {
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    if (!data || data.type !== 'msg') return;
    try {
      const text = await decrypt(cryptoKey, data.iv, data.ct);
      renderMessage(text, 'them');
    } catch (err) { console.error('decrypt failed', err); }
  };
  channel.onclose = () => { $('status').textContent = 'Собеседник отключился'; };
}

function waitIce(pc, timeout = 5000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', onChange);
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
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return JSON.parse(b64decode(s));
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
  if (!dc || dc.readyState !== 'open') return;
  const payload = await encrypt(cryptoKey, text);
  dc.send(JSON.stringify({ type: 'msg', ...payload }));
});

$('leave').onclick = () => {
  sessionStorage.removeItem(SESSION_KEY + secret);
  try { dc?.close(); pc?.close(); } catch {}
  location.hash = '';
  location.reload();
};
