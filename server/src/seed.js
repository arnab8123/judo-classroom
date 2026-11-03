import dotenv from 'dotenv';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
dotenv.config();

const alreadyProvisioned = db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0;
if (alreadyProvisioned) {
  console.log('A teacher account already exists; initial account provisioning skipped.');
  process.exit(0);
}

const production = process.env.NODE_ENV === 'production';
const name = String(process.env.SEED_TEACHER_NAME || (production ? '' : 'Class Teacher')).trim();
const email = String(process.env.SEED_TEACHER_EMAIL || (production ? '' : 'teacher@demo.local')).trim().toLowerCase();
const password = String(process.env.SEED_TEACHER_PASSWORD || (production ? '' : 'Classroom123!'));
if (!name || !email || !password) {
  throw new Error('No teacher account exists. Set SEED_TEACHER_NAME, SEED_TEACHER_EMAIL and SEED_TEACHER_PASSWORD before initial provisioning.');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('SEED_TEACHER_EMAIL must be a valid email address.');
if (production && password.length < 14) {
  throw new Error('For first production provisioning, SEED_TEACHER_PASSWORD must be at least 14 characters long.');
}
if (!production && password.length < 10) throw new Error('SEED_TEACHER_PASSWORD must be at least 10 characters long.');

db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
  .run(crypto.randomUUID(), name.slice(0, 100), email, bcrypt.hashSync(password, 12), 'teacher');
console.log(`Created initial teacher account for ${email}.`);
if (!production) console.log(`Local development teacher password: ${password}. Change it before using a public deployment.`);
else console.log('Initial teacher credentials were read from server environment variables; the password was not logged.');
