import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validFileSignature } from '../src/file-validation.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linguaroom-file-check-'));
after(() => fs.rmSync(testDir, { recursive: true, force: true }));

function check(name, bytes) {
  const filePath = path.join(testDir, name);
  fs.writeFileSync(filePath, bytes);
  return validFileSignature({ path: filePath, originalname: name });
}

test('accepts basic supported file signatures', () => {
  assert.equal(check('lesson.pdf', Buffer.from('%PDF-1.7\n')), true);
  assert.equal(check('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(check('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(check('photo.webp', Buffer.from('RIFF1234WEBPdata')), true);
  assert.equal(check('notes.txt', Buffer.from('Hallo, guten Tag!')), true);
  assert.equal(check('book.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(check('old-book.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), true);
});

test('rejects a mismatched extension and unsupported types', () => {
  assert.equal(check('not-a-pdf.pdf', Buffer.from('this is not a PDF')), false);
  assert.equal(check('renamed.exe', Buffer.from('MZ\x00fake executable')), false);
  assert.equal(check('binary.txt', Buffer.from([0x41, 0x00, 0x42])), false);
});
