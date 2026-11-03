import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
dotenv.config();

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadRaw = process.env.UPLOAD_DIR || './uploads';
const uploadDir = path.isAbsolute(uploadRaw) ? uploadRaw : path.resolve(serverRoot, uploadRaw);
const backupRaw = process.env.BACKUP_DIR || './backups';
const backupRoot = path.isAbsolute(backupRaw) ? backupRaw : path.resolve(serverRoot, backupRaw);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(backupRoot, `judo-${stamp}`);

try {
  fs.mkdirSync(destination, { recursive: true });
  // better-sqlite3's backup API accounts for the live WAL; do not copy the DB file directly while running.
  await db.backup(path.join(destination, 'classroom.sqlite'));
  if (fs.existsSync(uploadDir)) {
    await fs.promises.cp(uploadDir, path.join(destination, 'uploads'), { recursive: true, errorOnExist: false });
  } else {
    fs.mkdirSync(path.join(destination, 'uploads'), { recursive: true });
  }
  fs.writeFileSync(path.join(destination, 'backup-info.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    databaseFile: 'classroom.sqlite',
    uploadsDirectory: 'uploads',
    note: 'Store this backup somewhere separate from the app host and persistent disk.'
  }, null, 2));
  console.log(`Backup created: ${destination}`);
  db.close();
} catch (error) {
  try { db.close(); } catch { /* ignore close errors */ }
  console.error('Backup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
