import { generateSecret, deriveRoomId, deriveKey, encrypt, decrypt } from './crypto.js';

const $ = id => document.getElementById(id);
const PREFIX = '2chat-v1-';

// Пробуем сигнальные серверы по очереди
const SERVERS = [
  { name: 'cloud',  cfg: {} },
  { name: '92k.de', cfg: { host: 'peerjs.92k.de', port: 443, secure: true, path: '/' } },
];

let peer = null, conn = null, cryptoKey = null, roomId = null, myRole = null;
let serverIdx = 0;

init();

function init() {
  const secret = location.hash.slice(1);
  if (secret) startChat(secret);
  else $('create').onclick = () => { location.hash = generateSecret(); };
  window.addEventListener('hashchange', () => location.reload());
}

async function startChat(secret) {
  $('lobby').hidden = true;
  $('chat').hidden = false;
  roomId = await deriveRoomId(secret);
  cryptoKey = await deriveKey(secret, roomId);
  $('inviteLink').value = location.origin + location.pathname + '#' + secret;
  $('inviteBar').hidden = false;
  connectPeer();
}

function setStatus(s) { $('status').textContent = s; }

function connectPeer() {
  const fullId = PREFIX + roomId;
  const srv = SERVERS[serverIdx];
  setStatus(`Подключение к серверу (${srv.name})…`);

  const cfg = Object.assign({ debug: 1 }, srv.cfg);
  peer = new Peer(fullId, cfg);

  const openTimeout = setTimeout(() => {
    if (!peer.open) {
      try { peer.destroy(); } catch {}
      if (serverIdx + 1 < SERVERS.length) { serverIdx++; connectPeer(); }
      else setStatus('Не удалось подключиться к сигнальному серверу');
    }
  }, 6000);

  peer.on('open', () => {
    clearTimeout(openTimeout);
    myRole = 'host';
    setStatus('Ожидание собеседника…');
  });

  peer.on('connection', c => {
    if (conn && conn.open) { c.close(); return; }
    conn = c; wireConn();
  });

  peer.on('error', err => {
    clearTimeout(openTimeout);
    if (err.type === 'unavailable-id') {
      try { peer.destroy(); } catch {}
      peer = new Peer(Object.assign({ debug: 1 }, srv.cfg));
      peer.on('open', () => {
        myRole = 'guest';
        setStatus('Подключение к собеседнику…');
        conn = peer.connect(fullId, { reliable: true });
        wireConn();
      });
      peer.on('error', e => {
        console.error(e);
        setStatus('Ошибка: ' + (e.type || e.message));
      });
    } else if (err.type === 'peer-unavailable') {
      setStatus('Собеседник не в сети');
    } else if (['network','server-error','socket-error','socket-closed'].includes(err.type)) {
      try { peer.destroy(); } catch {}
      if (serverIdx + 1 < SERVERS.length) { serverIdx++; connectPeer(); }
      else setStatus('Ошибка сети: ' + (err.type || err.message));
    } else {
      console.error(err);
      setStatus('Ошибка: ' + (err.type || err.message));
    }
  });
}

function wireConn() {
  conn.on('open', () => { setStatus('На связи'); $('inviteBar').hidden = true; });
  conn.on('data', async data => {
    if (!data || data.type !== 'msg') return;
    try {
      const text = await decrypt(cryptoKey, data.iv, data.ct);
      renderMessage(text, 'them');
    } catch (e) { console.error('decrypt failed', e); }
  });
  conn.on('close', () => {
    conn = null;
    if (myRole === 'guest') {
      setStatus('Собеседник отключился, переподключение…');
      setTimeout(() => { peer?.destroy(); connectPeer(); }, 1500);
    } else {
      setStatus('Собеседник отключился. Ожидание…');
      $('inviteBar').hidden = false;
    }
  });
  conn.on('error', e => console.error('conn error', e));
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
  if (!conn || !conn.open) { setStatus('Нет соединения'); return; }
  const payload = await encrypt(cryptoKey, text);
  conn.send({ type: 'msg', ...payload });
});

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('inviteLink').value);
    $('copyBtn').textContent = '✓';
    setTimeout(() => ($('copyBtn').textContent = 'Копировать'), 1200);
  } catch {
    $('inviteLink').select();
    document.execCommand('copy');
  }
};

$('leave').onclick = () => { peer?.destroy(); location.hash = ''; location.reload(); };
