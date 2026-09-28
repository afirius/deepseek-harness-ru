// ASAR helpers. Pickle payload length includes a four-byte string length;
// JSON capacity is dataOffset - 16, never the value at byte 8.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function entryFor(header, parts) {
  return parts.reduce((node, part) => node?.files?.[part], header);
}
export function* entries(header, prefix = '') {
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const key = prefix + name;
    if (entry.files) yield* entries(entry, key + '/');
    else yield [key, entry];
  }
}
export function readArchive(file) {
  const buffer = fs.readFileSync(file);
  const pickleSize = buffer.readUInt32LE(4);
  const jsonLength = buffer.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  if (buffer.readUInt32LE(0) !== 4 || pickleSize % 4 ||
      buffer.readUInt32LE(8) !== pickleSize - 4 ||
      jsonLength > pickleSize - 8 || dataOffset > buffer.length) {
    throw new Error('Invalid ASAR framing');
  }
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'));
  return { buffer, header, pickleSize, jsonLength, dataOffset,
    entries: [...entries(header)].length };
}
export function readPacked(archive, entry) {
  const offset = Number(entry?.offset), size = entry?.size;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 ||
      archive.dataOffset + offset + size > archive.buffer.length) throw new Error('Invalid ASAR file range');
  return archive.buffer.subarray(archive.dataOffset + offset, archive.dataOffset + offset + size);
}
export function verifyPayload(archive, baseline = archive.header) {
  let count = 0;
  for (const [name, entry] of entries(baseline)) {
    if (entry.unpacked || entry.link) continue;
    const bytes = readPacked(archive, entry);
    if (entry.integrity) {
      if (entry.integrity.algorithm !== 'SHA256' || digest(bytes) !== entry.integrity.hash)
        throw new Error('ASAR checksum mismatch: ' + name);
    }
    count++;
  }
  JSON.parse(readPacked(archive, entryFor(baseline, ['dsh', 'desktop-runtime.json'])).toString('utf8'));
  return count;
}
export function withHeader(archive, header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const capacity = archive.dataOffset - 16;
  if (json.length > capacity) throw new Error(`ASAR header needs ${json.length} bytes; capacity is ${capacity}`);
  const result = Buffer.from(archive.buffer);
  result.writeUInt32LE(archive.pickleSize - 4, 8);
  result.writeUInt32LE(json.length, 12);
  result.fill(0, 16, archive.dataOffset);
  json.copy(result, 16);
  if (!result.subarray(archive.dataOffset).equals(archive.buffer.subarray(archive.dataOffset)))
    throw new Error('ASAR payload changed');
  return result;
}
export function atomicWrite(file, bytes) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
