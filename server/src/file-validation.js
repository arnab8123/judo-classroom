import fs from 'node:fs';
import path from 'node:path';

/** Check a small file signature before storing/serving a classroom attachment. This is basic validation, not malware scanning. */
export function validFileSignature(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buffer = Buffer.alloc(8192);
  let bytesRead = 0;
  let fd;
  try {
    fd = fs.openSync(file.path, 'r');
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const header = buffer.subarray(0, Math.min(bytesRead, 16));
  if (ext === '.pdf') return header.subarray(0, 5).toString() === '%PDF-';
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (ext === '.webp') return header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP';
  if (ext === '.doc' || ext === '.ppt') return header.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (ext === '.docx' || ext === '.pptx') return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
  if (ext === '.txt') return !buffer.subarray(0, bytesRead).includes(0);
  return false;
}
