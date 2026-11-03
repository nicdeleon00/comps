// Web Push from your own computer: VAPID-signed (RFC 8292), aes128gcm-encrypted
// (RFC 8291) messages, delivered by the browser vendor's push service (Apple's,
// for a Home Screen web app on iPhone). No third-party service involved.

import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair (P-256), base64url. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function derive(authSecret, shared, uaPublic, asPublic, salt) {
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  return { cek, nonce };
}

/**
 * Encrypts a payload for one subscription ({ p256dh, auth } from the browser).
 * `salt` and `serverPrivateKey` are only for tests; normally both are fresh per message.
 */
export function encrypt(payload, keys, { salt = randomBytes(16), serverPrivateKey } = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const ecdh = createECDH('prime256v1');
  if (serverPrivateKey) ecdh.setPrivateKey(fromB64u(serverPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const { cek, nonce } = derive(authSecret, ecdh.computeSecret(uaPublic), uaPublic, asPublic, salt);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** The receiving side, for tests: decrypts with the subscriber's private key. */
export function decrypt(body, { privateKey, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(privateKey));
  const { cek, nonce } = derive(fromB64u(auth), ecdh.computeSecret(asPublic), ecdh.getPublicKey(), asPublic, salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

/** VAPID Authorization header for a push endpoint. */
export function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const pub = fromB64u(vapid.publicKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: vapid.privateKey }, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Sends one notification. `gone` means the subscription no longer exists (remove it). */
export async function sendPush(subscription, message, vapid, { subject, ttl = 3600, urgency = 'high' } = {}) {
  const body = encrypt(JSON.stringify(message), subscription.keys);
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuth(subscription.endpoint, vapid, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, detail: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: e.message };
  }
}
