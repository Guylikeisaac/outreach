// Generates the extension PNG icons (charcoal tile + gold sync ring) with no dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.22; // tile corner radius
  const ringR = size * 0.3;
  const ringW = Math.max(1.2, size * 0.085);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square mask
      const dx = Math.max(Math.abs(x - c) - (c - radius), 0);
      const dy = Math.max(Math.abs(y - c) - (c - radius), 0);
      const inside = Math.hypot(dx, dy) <= radius;
      if (!inside) continue;
      let r = 18, g = 18, b = 20; // charcoal
      const d = Math.hypot(x - c, y - c);
      const ang = Math.atan2(y - c, x - c);
      // two arcs with gaps -> "sync" ring
      const inGap = Math.abs(Math.sin(ang)) < 0.22 && Math.cos(ang) * Math.sign(Math.sin(ang) || 1) > -2 &&
        ((ang > -0.5 && ang < 0.1) || (ang > 2.64 || ang < -2.9));
      if (Math.abs(d - ringR) <= ringW / 2 && !inGap) { r = 212; g = 175; b = 106; }
      if (d <= size * 0.08) { r = 236; g = 236; b = 236; }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, icon(s));
console.log('icons generated');
