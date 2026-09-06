import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// 从 public/icon.svg 的图形规格，程序化生成 PNG 图标（纯 Node，无第三方依赖）。
// 图形：深蓝圆角底 + 青色圆环 + 浅绿十字线 + 白色中心点。

const SS = 4; // 每像素 4x4 超采样抗锯齿

function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// 逻辑坐标空间为 192x192（与 SVG viewBox 一致）
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex("#06101d");
const RING = hex("#3cd9f5");
const CROSS = hex("#8fe1b4");
const DOT = hex("#eef6ff");

function sample(x, y) {
  // 圆角矩形（radius 44）
  const r = 44;
  const dx = Math.max(r - x, x - (192 - r), 0);
  const dy = Math.max(r - y, y - (192 - r), 0);
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0]; // 圆角外透明
  let color = BG;
  let a = 255;
  // 圆环 r=48，stroke 8
  const d = Math.hypot(x - 96, y - 96);
  if (d >= 44 && d <= 52) color = RING;
  // 十字线（画在圆环之上，透明度 0.78）
  const inV = Math.abs(x - 96) <= 2.5 && y >= 34 && y <= 158;
  const inH = Math.abs(y - 96) <= 2.5 && x >= 34 && x <= 158;
  if (inV || inH) {
    const t = 0.78;
    color = [0, 1, 2].map((i) => Math.round(t * CROSS[i] + (1 - t) * color[i]));
  }
  // 中心点 r=10
  if (d <= 10) color = DOT;
  return [...color, a];
}

function render(size) {
  const big = size * SS;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px * SS + sx + 0.5) / big) * 192;
          const y = ((py * SS + sy + 0.5) / big) * 192;
          const [cr, cg, cb, ca] = sample(x, y);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

const outDir = path.join(process.cwd(), "public");
mkdirSync(outDir, { recursive: true });

const targets = [
  { size: 512, name: "icon-512.png" },
  { size: 192, name: "icon-192.png" },
  { size: 180, name: "apple-touch-icon.png" },
];

for (const t of targets) {
  const png = encodePNG(t.size, t.size, render(t.size));
  const dest = path.join(outDir, t.name);
  writeFileSync(dest, png);
  console.log(`${t.name}: ${t.size}x${t.size} (${png.length} bytes)`);
}
