import crypto from 'node:crypto';

const b64url = (value) => Buffer.from(value).toString('base64url');
const fromB64url = (value) => Buffer.from(value, 'base64url');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  let output = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  for (let counter = 1; output.length < length; counter += 1) {
    previous = hmac(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]));
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

export function getVapidPublicKey() { return process.env.VAPID_PUBLIC_KEY || ''; }
export function hasVapidKeys() { return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY); }

function vapidAuthorization(endpoint) {
  const url = new URL(endpoint);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: url.origin, exp: now + 12 * 60 * 60, sub: process.env.VAPID_SUBJECT || 'mailto:admin@judomeet.online' }));
  const signingInput = `${header}.${claims}`;
  const publicKey = fromB64url(process.env.VAPID_PUBLIC_KEY);
  const privateKey = fromB64url(process.env.VAPID_PRIVATE_KEY);
  if (publicKey.length !== 65 || privateKey.length !== 32) throw new Error('Invalid VAPID key configuration.');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)), d: b64url(privateKey), ext: true };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${process.env.VAPID_PUBLIC_KEY}`;
}

function encryptPayload(subscription, payload) {
  const userPublicKey = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  if (userPublicKey.length !== 65 || authSecret.length !== 16) throw new Error('Invalid push subscription keys.');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublicKey, serverPublicKey]);
  const inputKey = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const contentKey = hkdf(salt, inputKey, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, inputKey, 'Content-Encoding: nonce\0', 12);
  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublicKey.length]), serverPublicKey, encrypted]);
}

export async function sendWebPush(subscription, payload) {
  const url = new URL(subscription.endpoint);
  const validHost = url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (
    url.hostname === 'fcm.googleapis.com' || url.hostname.endsWith('.push.services.mozilla.com') ||
    url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com')
  );
  if (!validHost) throw new Error('Unsupported or invalid push endpoint.');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high'
    },
    body: encryptPayload(subscription, payload),
    signal: AbortSignal.timeout(10_000)
  });
  return response.status;
}
