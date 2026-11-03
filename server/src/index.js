import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { Server } from 'socket.io';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { db } from './db.js';
import { readBearer, requireSession, requireTeacher, signAppToken, verifyAppToken } from './auth.js';
import { validFileSignature } from './file-validation.js';

const PORT = Number(process.env.PORT || 3001);
const defaultClientOrigin = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';
const configuredOrigins = (process.env.CLIENT_ORIGIN || defaultClientOrigin).split(',').map((s) => s.trim()).filter(Boolean);
const CLIENT_ORIGINS = [...new Set([...configuredOrigins, ...(process.env.RENDER_EXTERNAL_URL ? [process.env.RENDER_EXTERNAL_URL] : [])])];
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIST = path.resolve(SERVER_ROOT, '../client/dist');
// LIVEKIT_URL is the default LiveKit WebSocket endpoint. LIVEKIT_PUBLIC_URL can explicitly
// override the browser endpoint; otherwise local development derives the same hostname
// the browser used to open Judo (important for LAN testing instead of returning localhost).
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL || LIVEKIT_URL.replace(/^ws/i, 'http');
const LIVEKIT_PUBLIC_URL = process.env.LIVEKIT_PUBLIC_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const OAUTH_CLIENTS = {
  google: { id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '' },
  microsoft: { id: process.env.MICROSOFT_CLIENT_ID || '', secret: process.env.MICROSOFT_CLIENT_SECRET || '' },
  github: { id: process.env.GITHUB_CLIENT_ID || '', secret: process.env.GITHUB_CLIENT_SECRET || '' }
};
const PUBLIC_APP_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')).replace(/\/$/, '');
const OAUTH_PROVIDERS = new Set(['google', 'microsoft', 'github']);

function isAllowedOrigin(origin) {
  if (!origin || CLIENT_ORIGINS.includes(origin)) return true;
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') ||
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  } catch { return false; }
}

function browserLiveKitUrl(req) {
  if (LIVEKIT_PUBLIC_URL) return LIVEKIT_PUBLIC_URL;
  if (process.env.NODE_ENV === 'production') return LIVEKIT_URL;
  try {
    const origin = new URL(req.get('origin') || `${req.protocol}://${req.get('host')}`);
    const configured = new URL(LIVEKIT_URL);
    const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${origin.hostname}:${process.env.LIVEKIT_PUBLIC_PORT || configured.port || '7880'}`;
  } catch { return LIVEKIT_URL; }
}
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 15));
const UPLOAD_DIR_RAW = process.env.UPLOAD_DIR || './uploads';
const UPLOAD_DIR = path.isAbsolute(UPLOAD_DIR_RAW) ? UPLOAD_DIR_RAW : path.resolve(SERVER_ROOT, UPLOAD_DIR_RAW);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: (origin, callback) => callback(null, isAllowedOrigin(origin)), methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});
const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const emptyRoomTimers = new Map();
const roomStages = new Map();
// Any open attendance rows belong to sockets from a previous process; they are no longer connected.
db.prepare('UPDATE attendance SET left_at=CURRENT_TIMESTAMP WHERE left_at IS NULL').run();
function clearEmptyRoomTimer(code) {
  const timer = emptyRoomTimers.get(code);
  if (timer) clearTimeout(timer);
  emptyRoomTimers.delete(code);
}
function scheduleTemporaryRoomClosure(code) {
  const room = db.prepare('SELECT active, permanent FROM classrooms WHERE code=?').get(code);
  if (!room || !room.active || room.permanent) return;
  clearEmptyRoomTimer(code);
  const timer = setTimeout(async () => {
    emptyRoomTimers.delete(code);
    const current = db.prepare('SELECT active, permanent FROM classrooms WHERE code=?').get(code);
    const occupants = io.sockets.adapter.rooms.get(code);
    if (!current || !current.active || current.permanent || (occupants && occupants.size > 0)) return;
    db.prepare('UPDATE classrooms SET active=0, ended_at=CURRENT_TIMESTAMP WHERE code=?').run(code);
    try { await roomService.deleteRoom(code); } catch (err) { console.warn('Temporary LiveKit room closure skipped:', err?.message || err); }
    io.to(code).emit('meeting:ended', { message: 'This temporary classroom ended after 10 minutes without participants.' });
  }, 10 * 60 * 1000);
  timer.unref?.();
  emptyRoomTimers.set(code, timer);
}
// Rebuild temporary-room idle timers after a deploy/restart. Permanent rooms stay open.
for (const room of db.prepare('SELECT code FROM classrooms WHERE active=1 AND permanent=0').all()) {
  scheduleTemporaryRoomClosure(room.code);
}
if (process.env.NODE_ENV === 'production' && (LIVEKIT_API_KEY === 'devkey' || LIVEKIT_API_SECRET === 'secret' || !(LIVEKIT_PUBLIC_URL || LIVEKIT_URL).startsWith('wss://') || !LIVEKIT_HTTP_URL.startsWith('https://'))) {
  throw new Error('Production requires private LiveKit API credentials, a wss:// client URL, and an https:// server API URL.');
}

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      connectSrc: process.env.NODE_ENV === 'production'
        ? ["'self'", LIVEKIT_PUBLIC_URL || LIVEKIT_URL, LIVEKIT_HTTP_URL]
        : ["'self'", LIVEKIT_URL, LIVEKIT_HTTP_URL, 'ws:', 'wss:', 'http:', 'https:'],
      ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {})
    }
  }
}));
app.use(cors((req, callback) => {
  const origin = req.header('Origin');
  const forwardedProto = String(req.header('x-forwarded-proto') || '').split(',')[0].trim();
  const requestOrigin = `${forwardedProto || req.protocol}://${req.get('host')}`;
  const allowed = !origin || origin === requestOrigin || isAllowedOrigin(origin);
  callback(null, { origin: allowed ? origin || false : false, credentials: true });
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/register/start', rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/register/verify', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth/oauth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/rooms', rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: true, legacyHeaders: false }));
app.use('/api/files', rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false }));
app.use('/api/notes', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const allowedTypes = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.doc', new Set(['application/msword', 'application/octet-stream'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'])],
  ['.txt', new Set(['text/plain', 'application/octet-stream'])],
  ['.ppt', new Set(['application/vnd.ms-powerpoint', 'application/octet-stream'])],
  ['.pptx', new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])],
  ['.webp', new Set(['image/webp'])]
]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const permitted = allowedTypes.get(ext);
    if (!permitted || !permitted.has(file.mimetype)) return cb(new Error('This file type is not allowed. Upload PDF, Office documents, TXT, JPG, PNG, or WEBP files.'));
    cb(null, true);
  }
});

function codeForRoom() {
  // Human-readable and difficult to guess; collision is checked by the database unique constraint.
  return crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-');
}
function normalizeCode(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '-'); }
function allowSocketEvent(socket, key, maximum, windowMs) {
  const now = Date.now();
  const buckets = socket.data.eventBuckets || (socket.data.eventBuckets = new Map());
  const recent = (buckets.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= maximum) {
    socket.emit('server:warning', { message: 'You are sending actions too quickly. Please slow down.' });
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}
function safeRoom(row) {
  if (!row) return null;
  return {
    code: row.code,
    title: row.title,
    language: row.language,
    active: Boolean(row.active),
    permanent: Boolean(row.permanent),
    teacherName: row.teacher_name || null,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at || null
  };
}
function optionalTeacher(req) {
  const token = readBearer(req);
  if (!token) return null;
  try {
    const claims = verifyAppToken(token);
    return claims.userId && ['teacher', 'admin'].includes(claims.role) ? claims : null;
  } catch { return null; }
}
function roomByCode(code) {
  return db.prepare(`SELECT c.*, u.name AS teacher_name FROM classrooms c JOIN users u ON u.id=c.host_user_id WHERE c.code=?`).get(normalizeCode(code));
}
function requireRoomSession(req, res, next) {
  if (normalizeCode(req.params.code) !== normalizeCode(req.session.roomCode)) return res.status(403).json({ error: 'This session cannot access another classroom.' });
  next();
}
function requireActiveSession(req, res, next) {
  requireSession(req, res, () => {
    const room = db.prepare('SELECT active FROM classrooms WHERE code=?').get(normalizeCode(req.session.roomCode));
    if (!room || !room.active) return res.status(403).json({ error: 'This classroom has ended. Rejoin an active classroom to continue.' });
    next();
  });
}
function oauthApiBase(req) {
  return (process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function oauthClient(provider) { return OAUTH_CLIENTS[provider]; }
function oauthRedirect(provider, req) { return `${oauthApiBase(req)}/api/auth/oauth/${provider}/callback`; }
function oauthErrorRedirect(code) { return `${PUBLIC_APP_URL || 'http://localhost:5173'}/#host_auth_error=${encodeURIComponent(code)}`; }
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Identity provider request failed (${response.status}).`);
  return body;
}
async function verifyOidcIdToken(idToken, provider, expectedNonce, clientId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Identity provider returned an invalid token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  let keysUrl;
  if (provider === 'google') keysUrl = 'https://www.googleapis.com/oauth2/v3/certs';
  else {
    const discovery = await requestJson('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration');
    keysUrl = discovery.jwks_uri;
  }
  const jwks = await requestJson(keysUrl);
  const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.use === 'sig');
  if (!jwk || header.alg !== 'RS256') throw new Error('Identity provider signing key was not recognized.');
  const validSignature = crypto.verify(
    'RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url')
  );
  if (!validSignature) throw new Error('Identity provider token signature is invalid.');
  const now = Math.floor(Date.now() / 1000);
  const audienceMatches = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  if (!audienceMatches || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now || claims.nonce !== expectedNonce) throw new Error('Identity provider token claims did not match this sign-in.');
  if (provider === 'google' && !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Identity provider issuer was invalid.');
  if (provider === 'microsoft' && (!claims.tid || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`)) throw new Error('Identity provider issuer was invalid.');
  return claims;
}
async function getOAuthProfile(provider, code, state, nonce, req) {
  const client = oauthClient(provider);
  const redirectUri = oauthRedirect(provider, req);
  if (provider === 'github') {
    const token = await requestJson('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: client.id, client_secret: client.secret, code, state, redirect_uri: redirectUri })
    });
    if (!token.access_token) throw new Error('GitHub did not return an access token.');
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const [user, emails] = await Promise.all([
      requestJson('https://api.github.com/user', { headers }),
      requestJson('https://api.github.com/user/emails', { headers })
    ]);
    const email = emails.find((item) => item.primary && item.verified)?.email;
    if (!user.id || !email) throw new Error('GitHub must provide a verified primary email address.');
    return { subject: String(user.id), name: user.name || user.login || 'Teacher', email: email.toLowerCase() };
  }
  const isGoogle = provider === 'google';
  const tokenUrl = isGoogle ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const token = await requestJson(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  });
  const claims = await verifyOidcIdToken(token.id_token, provider, nonce, client.id);
  const subject = String(claims.sub || '');
  const providerEmail = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!subject || (isGoogle && (!providerEmail || claims.email_verified !== true))) throw new Error('Use an account with a verified email address.');
  const email = claims.email_verified === true ? providerEmail : `${provider}.${subject}@accounts.judo.invalid`;
  return { subject, name: claims.name || email || 'Teacher', email };
}
function createOrFindOAuthUser(provider, profile) {
  const linked = db.prepare('SELECT u.id, u.name, u.email, u.role FROM oauth_accounts a JOIN users u ON u.id=a.user_id WHERE a.provider=? AND a.provider_subject=?').get(provider, profile.subject);
  if (linked) return linked;
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(profile.email);
  if (existing) throw new Error('An account already uses this email. Sign in with that account first.');
  const user = { id: crypto.randomUUID(), name: String(profile.name || 'Teacher').trim().slice(0, 100) || 'Teacher', email: profile.email, role: 'teacher' };
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.email, bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12), user.role);
    db.prepare('INSERT INTO oauth_accounts (provider, provider_subject, user_id) VALUES (?, ?, ?)').run(provider, profile.subject, user.id);
  });
  tx();
  return user;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'judo-api', database: db.open ? 'connected' : 'unavailable', livekitConfigured: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET), uptimeSeconds: Math.floor(process.uptime()) }));
app.get('/api/auth/providers', (_req, res) => res.json({ providers: Object.fromEntries([...OAUTH_PROVIDERS].map((provider) => [provider, Boolean(oauthClient(provider).id && oauthClient(provider).secret)])), whatsapp: false }));

app.post('/api/auth/register/start', async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 100);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name (at least 2 characters).' });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Use a password between 12 and 200 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account already uses this email. Sign in instead.' });
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return res.status(503).json({ error: 'Email verification is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL to server/.env.' });
  const old = db.prepare('SELECT sent_at FROM signup_verifications WHERE email=?').get(email);
  if (old && Date.now() - old.sent_at < 60_000) return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const codeHash = crypto.createHmac('sha256', process.env.AUTH_SECRET || 'local-dev-secret-change-this').update(`${email}:${code}`).digest('hex');
  const passwordHash = bcrypt.hashSync(password, 12);
  const safeName = name.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL, to: [email], subject: 'Verify your Judo host account', text: `Hello ${name}, your Judo verification code is ${code}. It expires in 10 minutes.`, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Verify your Judo account</title></head><body style="margin:0;background:#f5f5f2;font-family:Arial,Helvetica,sans-serif;color:#202020"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#fff;border-radius:14px"><tr><td style="padding:28px"><h1 style="font-size:22px;line-height:1.3;margin:0 0 14px">Verify your email</h1><p style="font-size:15px;line-height:1.6;margin:0 0 16px">Hello ${safeName}, enter this code to finish creating your Judo host account:</p><p style="font-size:30px;line-height:1.4;letter-spacing:8px;font-weight:bold;margin:0 0 16px">${code}</p><p style="font-size:13px;line-height:1.5;color:#555;margin:0">This code expires in 10 minutes. If you didn’t request it, you can ignore this email.</p></td></tr></table></td></tr></table></body></html>` })
    });
    if (!response.ok) { const detail = await response.text(); console.error('Resend email error:', response.status, detail.slice(0, 300)); return res.status(502).json({ error: 'Could not send the verification email. Check your Resend sender and API key.' }); }
  } catch (err) { console.error('Resend request failed:', err?.message || err); return res.status(502).json({ error: 'Could not reach the email service. Try again shortly.' }); }
  db.prepare(`INSERT INTO signup_verifications (email,name,password_hash,code_hash,expires_at,attempts,sent_at) VALUES (?,?,?,?,?,0,?)
    ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at`)
    .run(email, name, passwordHash, codeHash, Date.now() + 10 * 60_000, Date.now());
  res.json({ ok: true, email });
});

app.post('/api/auth/register/verify', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit code sent to your email.' });
  const pending = db.prepare('SELECT * FROM signup_verifications WHERE email=?').get(email);
  if (!pending || pending.expires_at < Date.now()) { if (pending) db.prepare('DELETE FROM signup_verifications WHERE email=?').run(email); return res.status(400).json({ error: 'That code expired. Start sign-up again to get a new code.' }); }
  if (pending.attempts >= 5) { db.prepare('DELETE FROM signup_verifications WHERE email=?').run(email); return res.status(429).json({ error: 'Too many incorrect codes. Start sign-up again.' }); }
  const submittedHash = crypto.createHmac('sha256', process.env.AUTH_SECRET || 'local-dev-secret-change-this').update(`${email}:${code}`).digest('hex');
  const matches = crypto.timingSafeEqual(Buffer.from(submittedHash, 'hex'), Buffer.from(pending.code_hash, 'hex'));
  if (!matches) { db.prepare('UPDATE signup_verifications SET attempts=attempts+1 WHERE email=?').run(email); return res.status(400).json({ error: 'That verification code is incorrect.' }); }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { db.prepare('DELETE FROM signup_verifications WHERE email=?').run(email); return res.status(409).json({ error: 'An account already uses this email. Sign in instead.' }); }
  const user = { id: crypto.randomUUID(), name: pending.name, email, role: 'teacher' };
  const createUser = db.transaction(() => { db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(user.id,user.name,user.email,pending.password_hash,user.role); db.prepare('DELETE FROM signup_verifications WHERE email=?').run(email); });
  try { createUser(); } catch (err) { if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'An account already uses this email. Sign in instead.' }); throw err; }
  const token = signAppToken({ userId: user.id, role: user.role, name: user.name }, { expiresIn: '12h' });
  res.status(201).json({ token, user });
});

app.get('/api/auth/oauth/:provider', (req, res) => {
  const { provider } = req.params;
  const client = OAUTH_PROVIDERS.has(provider) && oauthClient(provider);
  if (!client || !client.id || !client.secret) return res.redirect(oauthErrorRedirect('provider_unavailable'));
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = provider === 'github' ? null : crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - 10 * 60 * 1000);
  db.prepare('INSERT INTO oauth_states (state, provider, nonce, created_at) VALUES (?, ?, ?, ?)').run(state, provider, nonce, Date.now());
  const callback = oauthRedirect(provider, req);
  let authorize;
  if (provider === 'google') authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  else if (provider === 'microsoft') authorize = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  else authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', client.id);
  authorize.searchParams.set('redirect_uri', callback);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('state', state);
  if (provider === 'google') {
    authorize.searchParams.set('scope', 'openid email profile'); authorize.searchParams.set('nonce', nonce); authorize.searchParams.set('prompt', 'select_account');
  } else if (provider === 'microsoft') {
    authorize.searchParams.set('scope', 'openid profile email User.Read'); authorize.searchParams.set('nonce', nonce); authorize.searchParams.set('prompt', 'select_account');
  } else { authorize.searchParams.set('scope', 'read:user user:email'); }
  res.redirect(authorize.toString());
});

app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  const fail = (code) => res.redirect(oauthErrorRedirect(code));
  if (!OAUTH_PROVIDERS.has(provider) || !req.query.code || !req.query.state) return fail('oauth_failed');
  try {
    const stateRow = db.prepare('SELECT nonce FROM oauth_states WHERE state=? AND provider=? AND created_at>=?').get(String(req.query.state), provider, Date.now() - 10 * 60 * 1000);
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(String(req.query.state));
    if (!stateRow) return fail('oauth_state');
    const profile = await getOAuthProfile(provider, String(req.query.code), String(req.query.state), stateRow.nonce, req);
    const user = createOrFindOAuthUser(provider, profile);
    const token = signAppToken({ userId: user.id, role: user.role, name: user.name }, { expiresIn: '12h' });
    return res.redirect(`${PUBLIC_APP_URL || 'http://localhost:5173'}/#host_auth_token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.warn('Host OAuth sign-in failed:', err?.message || err);
    return fail(/already uses this email/i.test(err?.message || '') ? 'account_exists' : 'oauth_failed');
  }
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const user = db.prepare('SELECT id, name, email, password_hash, role FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const token = signAppToken({ userId: user.id, role: user.role, name: user.name }, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', requireTeacher, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id=?').get(req.teacher.userId);
  if (!user) return res.status(401).json({ error: 'Teacher account was not found.' });
  res.json({ user });
});

app.get('/api/rooms/lookup/:code', (req, res) => {
  const row = roomByCode(req.params.code);
  if (!row || !row.active) return res.status(404).json({ error: 'That classroom does not exist or has ended.' });
  res.json({ room: safeRoom(row) });
});

app.post('/api/rooms/:code/join', async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const room = roomByCode(code);
    if (!room || !room.active) return res.status(404).json({ error: 'That classroom does not exist or has ended.' });
    const displayName = String(req.body?.displayName || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 50);
    const guestKey = String(req.body?.guestKey || '');
    if (displayName.length < 1) return res.status(400).json({ error: 'Enter the name you want classmates to see.' });
    if (guestKey.length < 32 || guestKey.length > 100 || !/^[a-zA-Z0-9-]+$/.test(guestKey)) return res.status(400).json({ error: 'Guest identity is invalid. Refresh the page and try again.' });
    const teacher = optionalTeacher(req);
    const isHost = Boolean(teacher && teacher.userId === room.host_user_id);
    const role = isHost ? 'teacher' : 'participant';
    const ownerKey = isHost ? `teacher:${teacher.userId}` : `guest:${guestKey}`;
    const sessionId = crypto.randomUUID();
    const sessionToken = signAppToken({
      ownerKey,
      roomCode: code,
      sessionId,
      displayName,
      role,
      ...(isHost ? { userId: teacher.userId } : {})
    }, { expiresIn: '4h' });
    const identity = `${isHost ? 'teacher' : 'guest'}-${sessionId}`;
    const lkToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: '4h',
      metadata: JSON.stringify({ displayName, role, roomCode: code })
    });
    lkToken.addGrant({ roomJoin: true, room: code, canPublish: true, canSubscribe: true, canPublishData: true });
    const livekitToken = await lkToken.toJwt();
    res.json({ sessionToken, livekitToken, livekitUrl: browserLiveKitUrl(req), room: safeRoom(room), role, displayName, participantId: sessionId });
  } catch (error) {
    console.error('Room join token error:', error?.message || error);
    res.status(500).json({ error: 'Could not prepare the classroom session. Check the server configuration.' });
  }
});

app.get('/api/rooms', requireTeacher, (req, res) => {
  const rows = db.prepare(`SELECT c.*, u.name AS teacher_name FROM classrooms c JOIN users u ON u.id=c.host_user_id WHERE c.host_user_id=? ORDER BY c.created_at DESC`).all(req.teacher.userId);
  res.json({ rooms: rows.map((row) => ({ ...safeRoom(row), id: row.id, participantCount: db.prepare('SELECT COUNT(DISTINCT participant_key) AS count FROM attendance WHERE classroom_code=? AND left_at IS NULL').get(row.code).count })) });
});

app.post('/api/rooms', requireTeacher, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 100);
  const language = String(req.body?.language || 'German').trim().slice(0, 40);
  const scheduleInput = req.body?.scheduledAt;
  const scheduleDate = scheduleInput ? new Date(scheduleInput) : null;
  if (!title) return res.status(400).json({ error: 'Enter a meeting title.' });
  if (scheduleInput && (!scheduleDate || Number.isNaN(scheduleDate.getTime()) || scheduleDate.getTime() <= Date.now())) {
    return res.status(400).json({ error: 'Choose a future date and time for the scheduled meeting.' });
  }
  // Scheduled meetings use persistent rooms so a link remains valid before class starts.
  const permanent = (req.body?.permanent || scheduleDate) ? 1 : 0;
  const scheduledAt = scheduleDate ? scheduleDate.toISOString() : null;
  let code = codeForRoom();
  while (db.prepare('SELECT id FROM classrooms WHERE code=?').get(code)) code = codeForRoom();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO classrooms (id, code, title, language, host_user_id, permanent, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, title, language || 'German', req.teacher.userId, permanent, scheduledAt);
  res.status(201).json({ room: { id, code, title, language: language || 'German', active: true, permanent: Boolean(permanent), scheduledAt, createdAt: new Date().toISOString() } });
});

app.post('/api/rooms/:code/end', requireTeacher, async (req, res) => {
  const code = normalizeCode(req.params.code);
  const room = db.prepare('SELECT * FROM classrooms WHERE code=?').get(code);
  if (!room) return res.status(404).json({ error: 'Classroom not found.' });
  if (room.host_user_id !== req.teacher.userId) return res.status(403).json({ error: 'Only the classroom host can end this room.' });
  clearEmptyRoomTimer(code);
  db.prepare('UPDATE classrooms SET active=0, ended_at=CURRENT_TIMESTAMP WHERE code=?').run(code);
  try { await roomService.deleteRoom(code); } catch (err) { console.warn('LiveKit room deletion skipped:', err?.message || err); }
  io.to(code).emit('meeting:ended', { message: 'The teacher ended this classroom.' });
  res.json({ ok: true });
});

app.get('/api/rooms/:code/attendance.csv', requireTeacher, (req, res) => {
  const code = normalizeCode(req.params.code);
  const room = db.prepare('SELECT * FROM classrooms WHERE code=? AND host_user_id=?').get(code, req.teacher.userId);
  if (!room) return res.status(404).json({ error: 'Classroom not found.' });
  const rows = db.prepare('SELECT display_name, role, joined_at, left_at FROM attendance WHERE classroom_code=? ORDER BY joined_at ASC').all(code);
  const escape = (value) => {
    const text = String(value ?? '');
    // Prefix formula-leading values so opening this CSV in spreadsheet software won't execute them.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = ['Name,Role,Joined at,Left at', ...rows.map((r) => [r.display_name, r.role, r.joined_at, r.left_at || 'Still in class'].map(escape).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${code}.csv"`);
  res.send(csv);
});

app.get('/api/rooms/:code/attendance', requireTeacher, (req, res) => {
  const code = normalizeCode(req.params.code);
  const room = db.prepare('SELECT id FROM classrooms WHERE code=? AND host_user_id=?').get(code, req.teacher.userId);
  if (!room) return res.status(404).json({ error: 'Classroom not found.' });
  const attendance = db.prepare('SELECT display_name AS displayName, role, joined_at AS joinedAt, left_at AS leftAt FROM attendance WHERE classroom_code=? ORDER BY joined_at DESC').all(code);
  res.json({ attendance });
});

app.delete('/api/rooms/:code', requireTeacher, (req, res) => {
  const code = normalizeCode(req.params.code);
  const room = db.prepare('SELECT id, active FROM classrooms WHERE code=? AND host_user_id=?').get(code, req.teacher.userId);
  if (!room) return res.status(404).json({ error: 'Classroom not found.' });
  if (room.active) return res.status(409).json({ error: 'End the classroom before deleting it.' });
  const storedFiles = db.prepare('SELECT stored_name FROM uploads WHERE classroom_code=?').all(code).map((row) => path.basename(row.stored_name));
  const removeRows = db.transaction(() => {
    db.prepare('DELETE FROM attendance WHERE classroom_code=?').run(code);
    db.prepare('DELETE FROM chat_messages WHERE classroom_code=?').run(code);
    db.prepare('DELETE FROM board_events WHERE classroom_code=?').run(code);
    db.prepare('DELETE FROM notes WHERE classroom_code=?').run(code);
    db.prepare('DELETE FROM uploads WHERE classroom_code=?').run(code);
    db.prepare('DELETE FROM classrooms WHERE code=? AND host_user_id=? AND active=0').run(code, req.teacher.userId);
  });
  removeRows();
  clearEmptyRoomTimer(code);
  roomStages.delete(code);
  for (const storedName of storedFiles) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, storedName)); } catch (err) { if (err?.code !== 'ENOENT') console.warn('Could not remove deleted classroom file:', err?.message || err); }
  }
  res.json({ ok: true });
});

app.get('/api/notes', requireActiveSession, (req, res) => {
  const notes = db.prepare('SELECT id, classroom_code AS classroomCode, title, content, updated_at AS updatedAt FROM notes WHERE owner_key=? ORDER BY updated_at DESC').all(req.session.ownerKey);
  res.json({ notes });
});
app.post('/api/notes', requireActiveSession, (req, res) => {
  const id = String(req.body?.id || '');
  const title = String(req.body?.title || 'Class notes').trim().slice(0, 120) || 'Class notes';
  const content = String(req.body?.content || '').slice(0, 100000);
  if (id) {
    const result = db.prepare('UPDATE notes SET title=?, content=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_key=?').run(title, content, id, req.session.ownerKey);
    if (!result.changes) return res.status(404).json({ error: 'Note not found.' });
    const note = db.prepare('SELECT id, classroom_code AS classroomCode, title, content, updated_at AS updatedAt FROM notes WHERE id=?').get(id);
    return res.json({ note });
  }
  const newId = crypto.randomUUID();
  db.prepare('INSERT INTO notes (id, owner_key, classroom_code, title, content) VALUES (?, ?, ?, ?, ?)')
    .run(newId, req.session.ownerKey, req.session.roomCode, title, content);
  res.status(201).json({ note: db.prepare('SELECT id, classroom_code AS classroomCode, title, content, updated_at AS updatedAt FROM notes WHERE id=?').get(newId) });
});
app.delete('/api/notes/:id', requireActiveSession, (req, res) => {
  const result = db.prepare('DELETE FROM notes WHERE id=? AND owner_key=?').run(req.params.id, req.session.ownerKey);
  if (!result.changes) return res.status(404).json({ error: 'Note not found.' });
  res.json({ ok: true });
});

app.get('/api/files', requireActiveSession, (req, res) => {
  const code = normalizeCode(req.query.roomCode || req.session.roomCode);
  if (code !== normalizeCode(req.session.roomCode)) return res.status(403).json({ error: 'You cannot access files from another classroom.' });
  const files = db.prepare('SELECT id, uploader_name AS uploaderName, original_name AS originalName, mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt FROM uploads WHERE classroom_code=? ORDER BY created_at DESC').all(code);
  res.json({ files });
});
app.post('/api/files', requireActiveSession, (req, res, next) => {
  upload.array('files', 8)(req, res, (err) => {
    if (err) {
      const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 400;
      return res.status(status).json({ error: err.message || 'Upload failed.' });
    }
    next();
  });
}, (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Choose at least one file.' });
  const invalidFile = files.find((file) => !validFileSignature(file));
  if (invalidFile) {
    files.forEach((file) => { try { fs.unlinkSync(file.path); } catch { /* ignore cleanup errors */ } });
    return res.status(400).json({ error: `The contents of ${path.basename(invalidFile.originalname)} do not match an allowed file type.` });
  }
  const insert = db.prepare('INSERT INTO uploads (id, classroom_code, uploader_key, uploader_name, original_name, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => items.map((file) => {
    const id = crypto.randomUUID();
    insert.run(id, req.session.roomCode, req.session.ownerKey, req.session.displayName, path.basename(file.originalname), file.filename, file.mimetype, file.size);
    return { id, uploaderName: req.session.displayName, originalName: path.basename(file.originalname), mimeType: file.mimetype, sizeBytes: file.size, createdAt: new Date().toISOString() };
  }));
  try { res.status(201).json({ files: tx(files) }); }
  catch (error) { files.forEach((file) => { try { fs.unlinkSync(file.path); } catch { /* ignore cleanup errors */ } }); throw error; }
});
app.get('/api/files/:id/download', requireActiveSession, (req, res) => {
  const file = db.prepare('SELECT * FROM uploads WHERE id=? AND classroom_code=?').get(req.params.id, req.session.roomCode);
  if (!file) return res.status(404).json({ error: 'File not found in this classroom.' });
  const filePath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'The stored file is missing.' });
  res.download(filePath, path.basename(file.original_name));
});

// In production, serve the Vite build from this same origin so the browser never calls localhost.
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (error) => { if (error && !res.headersSent) next(error); });
  });
}

app.use((err, _req, res, _next) => {
  console.error('Unhandled API error:', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Unexpected server error. Check the server logs for details.' });
});

// Socket.IO is for classroom state and signaling events only. Audio/video uses the LiveKit SFU.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Classroom session missing. Rejoin the classroom.'));
    const claims = verifyAppToken(token);
    if (!claims.roomCode || !claims.ownerKey || !claims.sessionId) return next(new Error('Invalid classroom session.'));
    const room = db.prepare('SELECT active FROM classrooms WHERE code=?').get(normalizeCode(claims.roomCode));
    if (!room || !room.active) return next(new Error('This classroom has ended.'));
    socket.data.session = claims;
    next();
  } catch { next(new Error('Your session has expired. Rejoin the classroom.')); }
});

io.on('connection', (socket) => {
  const session = socket.data.session;
  const code = normalizeCode(session.roomCode);
  const attendanceId = crypto.randomUUID();
  socket.data.attendanceId = attendanceId;
  socket.join(code);
  clearEmptyRoomTimer(code);
  db.prepare('INSERT INTO attendance (id, classroom_code, participant_key, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .run(attendanceId, code, session.sessionId, session.displayName, session.role);

  const existing = io.sockets.adapter.rooms.get(code) || new Set();
  const participants = [...existing].map((socketId) => {
    const connected = io.sockets.sockets.get(socketId);
    if (!connected) return null;
    const p = connected.data.session;
    return { sessionId: p.sessionId, displayName: p.displayName, role: p.role, socketId };
  }).filter(Boolean);
  socket.emit('room:participants', participants);
  socket.emit('room:stage', { stage: roomStages.get(code) || 'video' });
  socket.emit('chat:history', db.prepare('SELECT id, sender_name AS senderName, body, created_at AS createdAt FROM chat_messages WHERE classroom_code=? ORDER BY created_at DESC LIMIT 100').all(code).reverse());
  socket.to(code).emit('participant:joined', { sessionId: session.sessionId, displayName: session.displayName, role: session.role, socketId: socket.id });

  socket.on('chat:send', (data) => {
    if (!allowSocketEvent(socket, 'chat:send', 12, 10_000)) return;
    const body = String(data?.body || '').trim().slice(0, 2000);
    if (!body) return;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO chat_messages (id, classroom_code, sender_key, sender_name, body) VALUES (?, ?, ?, ?, ?)')
      .run(id, code, session.ownerKey, session.displayName, body);
    db.prepare('DELETE FROM chat_messages WHERE classroom_code=? AND id NOT IN (SELECT id FROM chat_messages WHERE classroom_code=? ORDER BY created_at DESC, rowid DESC LIMIT 3000)').run(code, code);
    io.to(code).emit('chat:new', { id, senderName: session.displayName, senderId: session.sessionId, body, createdAt });
  });

  socket.on('board:sync', () => {
    if (!allowSocketEvent(socket, 'board:sync', 3, 5000)) return;
    const events = db.prepare('SELECT payload FROM board_events WHERE classroom_code=? ORDER BY created_at ASC, rowid ASC LIMIT 1200').all(code)
      .map((row) => {
        try {
          const stroke = JSON.parse(row.payload);
          // Older local databases may contain an old ownerKey field; never send it to clients.
          if (stroke && typeof stroke === 'object') delete stroke.ownerKey;
          return stroke;
        } catch { return null; }
      }).filter(Boolean);
    socket.emit('board:state', events);
  });
  socket.on('room:stage:set', (data) => {
    if (session.role !== 'teacher' || !allowSocketEvent(socket, 'room:stage:set', 10, 5000)) return;
    if (!['video', 'board'].includes(data?.stage)) return;
    roomStages.set(code, data.stage);
    io.to(code).emit('room:stage', { stage: data.stage });
  });
  socket.on('board:draw', (payload) => {
    if (!allowSocketEvent(socket, 'board:draw', 18, 5000)) return;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.points) || payload.points.length > 3000) return;
    const id = String(payload.id || crypto.randomUUID()).slice(0, 100);
    if (db.prepare('SELECT 1 FROM board_events WHERE classroom_code=? AND object_id=? LIMIT 1').get(code, id)) {
      socket.emit('server:warning', { message: 'That whiteboard stroke ID is already in use. Draw the stroke again.' });
      return;
    }
    const color = /^#[0-9a-fA-F]{6}$/.test(String(payload.color)) ? payload.color : '#2563eb';
    const width = Math.min(28, Math.max(1, Number(payload.width) || 3));
    const tool = payload.tool === 'eraser' ? 'eraser' : 'pen';
    const points = payload.points.slice(0, 3000).map((p) => ({ x: Math.min(1, Math.max(0, Number(p?.x) || 0)), y: Math.min(1, Math.max(0, Number(p?.y) || 0)) }));
    const stroke = { id, type: 'draw', tool, color, width, points, ownerName: session.displayName, ownerId: session.sessionId };
    db.prepare('INSERT INTO board_events (id, classroom_code, object_id, owner_key, payload) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), code, id, session.ownerKey, JSON.stringify(stroke));
    db.prepare('DELETE FROM board_events WHERE classroom_code=? AND id NOT IN (SELECT id FROM board_events WHERE classroom_code=? ORDER BY created_at DESC, rowid DESC LIMIT 1200)').run(code, code);
    socket.to(code).emit('board:draw', stroke);
  });
  socket.on('board:undo', (data) => {
    if (!allowSocketEvent(socket, 'board:undo', 8, 5000)) return;
    const id = String(data?.id || '').slice(0, 100);
    if (!id) return;
    const stroke = db.prepare('SELECT owner_key FROM board_events WHERE classroom_code=? AND object_id=? ORDER BY created_at DESC LIMIT 1').get(code, id);
    if (!stroke || (session.role !== 'teacher' && stroke.owner_key !== session.ownerKey)) {
      socket.emit('server:warning', { message: 'You can only undo your own whiteboard strokes.' });
      return;
    }
    db.prepare('DELETE FROM board_events WHERE classroom_code=? AND object_id=?').run(code, id);
    io.to(code).emit('board:undo', { id });
  });
  socket.on('board:clear', () => {
    if (session.role !== 'teacher') { socket.emit('server:warning', { message: 'Only the teacher can clear the shared whiteboard.' }); return; }
    if (!allowSocketEvent(socket, 'board:clear', 2, 10_000)) return;
    db.prepare('DELETE FROM board_events WHERE classroom_code=?').run(code);
    io.to(code).emit('board:cleared', { by: session.displayName });
  });
  socket.on('participant:hand', (data) => {
    if (!allowSocketEvent(socket, 'participant:hand', 8, 5000)) return;
    io.to(code).emit('participant:hand', { sessionId: session.sessionId, displayName: session.displayName, raised: Boolean(data?.raised) });
  });
  socket.on('meeting:reaction', (data) => {
    if (!allowSocketEvent(socket, 'meeting:reaction', 8, 5000)) return;
    const allowed = new Set(['👏', '👍', '❤️', '😂', '🎉', '🙌']);
    if (allowed.has(data?.emoji)) io.to(code).emit('meeting:reaction', { displayName: session.displayName, emoji: data.emoji, sessionId: session.sessionId });
  });
  socket.on('meeting:announcement', (data) => {
    if (session.role !== 'teacher' || !allowSocketEvent(socket, 'meeting:announcement', 3, 60_000)) return;
    const message = String(data?.message || '').trim().slice(0, 500);
    if (message) io.to(code).emit('meeting:announcement', { displayName: session.displayName, message, createdAt: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    db.prepare('UPDATE attendance SET left_at=CURRENT_TIMESTAMP WHERE id=?').run(attendanceId);
    socket.to(code).emit('participant:left', { sessionId: session.sessionId, displayName: session.displayName, socketId: socket.id });
    const remaining = io.sockets.adapter.rooms.get(code);
    if (!remaining || [...remaining].filter((socketId) => socketId !== socket.id).length === 0) scheduleTemporaryRoomClosure(code);
  });
});

const listener = server.listen(PORT, '0.0.0.0', () => {
  console.log(`Judo API listening on port ${PORT}`);
  console.log(`Client build: ${fs.existsSync(path.join(CLIENT_DIST, 'index.html')) ? CLIENT_DIST : 'not found (use npm run dev for local frontend)'}`);
  console.log(`LiveKit server API URL: ${LIVEKIT_HTTP_URL}`);
  console.log(`LiveKit browser URL: ${LIVEKIT_PUBLIC_URL || (process.env.NODE_ENV === 'production' ? LIVEKIT_URL : 'derived from the browser hostname during local development')}`);
  console.log(`Upload limit: ${MAX_UPLOAD_MB} MB per file; upload folder: ${UPLOAD_DIR}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing Judo services...`);
  for (const timer of emptyRoomTimers.values()) clearTimeout(timer);
  listener.close(() => {
    io.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
