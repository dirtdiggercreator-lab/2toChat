const enc = new TextEncoder();
const dec = new TextDecoder();

export function generateSecret() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return b64url(buf);
}
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function deriveRoomId(secret) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode('room:' + secret));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
export async function deriveKey(secret, roomId) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(roomId), info: enc.encode('2chat-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
export async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}
export async function decrypt(key, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(ivB64) },
    key,
    fromB64url(ctB64)
  );
  return dec.decode(pt);
}

/* --- добавлено для совместимости с app.js --- */
function _2chatB64u(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function _2chatB64uDec(s) {
  s = String(s).replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: iv, ct: new Uint8Array(ct) };
}
export async function decryptBytes(key, iv, ct) {
  const ivU8 = iv instanceof Uint8Array ? iv : new Uint8Array(iv);
  const ctU8 = ct instanceof Uint8Array ? ct : new Uint8Array(ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivU8 }, key, ctU8);
  return new Uint8Array(pt);
}
