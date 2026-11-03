import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { db } from './db.js';
dotenv.config();

const secret = process.env.AUTH_SECRET || 'local-dev-secret-change-this';
if (process.env.NODE_ENV === 'production' && (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)) {
  throw new Error('Set AUTH_SECRET to a random value of at least 32 characters in production.');
}
export function signAppToken(payload, options = {}) {
  return jwt.sign(payload, secret, { expiresIn: options.expiresIn || '4h', issuer: 'linguaroom' });
}
export function verifyAppToken(token) {
  return jwt.verify(token, secret, { issuer: 'linguaroom' });
}
export function readBearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}
export function requireSession(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ error: 'Join a classroom first.' });
    req.session = verifyAppToken(token);
    if (!req.session?.roomCode || !req.session?.ownerKey || !req.session?.sessionId) return res.status(401).json({ error: 'Invalid classroom session.' });
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Rejoin the classroom.' });
  }
}
export function requireTeacher(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ error: 'Teacher sign-in required.' });
    const claims = verifyAppToken(token);
    if (!claims.userId || !['teacher', 'admin'].includes(claims.role)) return res.status(403).json({ error: 'Teacher access required.' });
    // A still-valid JWT can outlive a reset/restored SQLite database. Reject it here
    // instead of allowing later classroom inserts to fail their host_user_id FK.
    const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(claims.userId);
    if (!user || user.role !== claims.role) return res.status(401).json({ error: 'Your host account is no longer available. Sign in again.' });
    req.teacher = claims;
    next();
  } catch {
    return res.status(401).json({ error: 'Your sign-in has expired. Sign in again.' });
  }
}
