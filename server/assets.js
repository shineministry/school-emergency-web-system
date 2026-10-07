const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generateIcon(file, size) {
  const red = [200, 16, 46, 255];
  const dark = [140, 8, 30, 255];
  const white = [255, 255, 255, 255];
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      let px;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < r * 0.78) {
        const inBar = Math.abs(dx) < r * 0.16 && dy > -r * 0.55 && dy < r * 0.22;
        const inDot = dist < r * 0.2 && dy > r * 0.42;
        px = inBar || inDot ? red : white;
      } else if (dist < r) {
        px = white;
      } else if (y > size * 0.86) {
        px = dark;
      } else {
        px = red;
      }
      raw[o++] = px[0];
      raw[o++] = px[1];
      raw[o++] = px[2];
      raw[o++] = px[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
}

function generateSiren(file) {
  const rate = 22050;
  const seconds = 2.4;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = (t % 0.8) / 0.8;
    const freq = 620 + 560 * (phase < 0.5 ? phase * 2 : (1 - phase) * 2);
    const envelope = 0.35 + 0.15 * Math.sin(2 * Math.PI * 2 * t);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function ensureAssets() {
  const assetsDir = path.join(PUBLIC_DIR, 'assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const icon192 = path.join(assetsDir, 'icon-192.png');
  const icon512 = path.join(assetsDir, 'icon-512.png');
  const siren = path.join(assetsDir, 'siren.wav');

  if (!fs.existsSync(icon192)) generateIcon(icon192, 192);
  if (!fs.existsSync(icon512)) generateIcon(icon512, 512);
  if (!fs.existsSync(siren)) generateSiren(siren);
}

module.exports = { ensureAssets };
