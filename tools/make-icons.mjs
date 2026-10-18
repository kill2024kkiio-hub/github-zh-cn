/**
 * 生成扩展图标：node tools/make-icons.mjs
 * 不依赖任何图形库，直接写 PNG（zlib 压缩 + CRC）。
 * 图案：蓝色渐变圆角方块 + 白色「中」字（用矩形笔画拼出来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons');
fs.mkdirSync(outDir, { recursive: true });

// ── PNG 编码 ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 绘制 ────────────────────────────────────────────────
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 128;                     // 以 128 为设计尺寸等比缩放
  const radius = 26 * s;

  const setPx = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  const inRoundedRect = (x, y, w, h, rad) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const cx = Math.min(Math.max(x, rad), w - rad);
    const cy = Math.min(Math.max(y, rad), h - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
  };

  const rect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
  // 「中」：竖 + 口
  const strokes = [
    rect(58, 20, 70, 108),      // 中竖
    rect(32, 38, 96, 50),       // 口：上横
    rect(32, 78, 96, 90),       // 口：下横
    rect(32, 38, 44, 90),       // 口：左竖
    rect(84, 38, 96, 90),       // 口：右竖
  ].map((r) => ({
    x0: r.x0 * s, y0: r.y0 * s, x1: r.x1 * s, y1: r.y1 * s,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inRoundedRect(px, py, size, size, radius)) {
        setPx(x, y, 0, 0, 0, 0);
        continue;
      }
      // 背景：左上深蓝 → 右下紫
      const t = (px / size + py / size) / 2;
      const bg = [
        Math.round(9 + (130 - 9) * t),
        Math.round(105 + (80 - 105) * t),
        Math.round(218 + (223 - 218) * t),
      ];
      let color = [...bg, 255];
      for (const st of strokes) {
        if (px >= st.x0 && px <= st.x1 && py >= st.y0 && py <= st.y1) {
          color = [255, 255, 255, 255];
          break;
        }
      }
      setPx(x, y, ...color);
    }
  }
  return encodePng(size, size, buf);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`生成 ${path.relative(process.cwd(), file)}  ${size}x${size}  ${kb} KB`);
}
