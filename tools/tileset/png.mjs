// 의존성 없는 PNG 라이터 (node:zlib). 타일셋 생성 파이프라인의 토대.
import { deflateSync } from "node:zlib";

export class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8Array(w * h * 4); }
  px(x, y, c, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a >= 255) { this.d[i] = c[0]; this.d[i+1] = c[1]; this.d[i+2] = c[2]; this.d[i+3] = 255; return; }
    if (a <= 0) return;
    const t = a / 255, s = this.d[i+3] / 255, o = t + s * (1 - t);
    this.d[i]   = (c[0]*t + this.d[i]  *s*(1-t)) / o;
    this.d[i+1] = (c[1]*t + this.d[i+1]*s*(1-t)) / o;
    this.d[i+2] = (c[2]*t + this.d[i+2]*s*(1-t)) / o;
    this.d[i+3] = o * 255;
  }
  rect(x, y, w, h, c, a = 255) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.px(x + i, y + j, c, a);
  }
  hline(x, y, w, c, a = 255) { this.rect(x, y, w, 1, c, a); }
  vline(x, y, h, c, a = 255) { this.rect(x, y, 1, h, c, a); }
  /** 둥근 모서리 사각 — 모서리 픽셀만 **안 그린다**.
   *  알파를 0 으로 지우면 합성 캔버스에서는 아래 레이어까지 뚫려 흰 점이 남는다. */
  round(x, y, w, h, c, a = 255) {
    const skip = new Set([`0,0`, `${w-1},0`, `0,${h-1}`, `${w-1},${h-1}`]);
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) {
      if (skip.has(`${i},${j}`)) continue;
      this.px(x + i, y + j, c, a);
    }
  }
  png() {
    // Paeth 필터 — 픽셀 아트처럼 촘촘한 그림이 20% 넘게 작아진다(필터 없음 3.97MB → 3.08MB, 소품 시트 전체).
    const stride = this.w * 4, raw = Buffer.alloc((stride + 1) * this.h), d = this.d;
    for (let y = 0; y < this.h; y += 1) {
      const o = y * (stride + 1);
      raw[o] = 4;
      for (let x = 0; x < stride; x += 1) {
        const cur = d[y * stride + x];
        const a = x >= 4 ? d[y * stride + x - 4] : 0, b = y > 0 ? d[(y - 1) * stride + x] : 0, c = x >= 4 && y > 0 ? d[(y - 1) * stride + x - 4] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        raw[o + 1 + x] = (cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}
let T = null;
function crc32(buf) {
  if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i += 1) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
