/** 의존성 없는 PNG 디코더 — 사용자가 넣어 둔 캐릭터 이미지를 읽는다.
 *
 *  쓰는 곳은 빌드 도구뿐이다(앱은 이걸 쓰지 않는다). 그래도 직접 쓰는 이유는
 *  이 저장소가 "받아 오는 것 없이 돈다"를 지켜 왔기 때문이다 — 아트 파이프라인
 *  하나 때문에 ImageMagick 을 깔아야 한다면 그 약속이 깨진다.
 *
 *  지원: 8비트 RGBA/RGB/회색+알파, 인터레이스 없음. 그 밖은 분명한 오류를 낸다.
 */
import { inflateSync } from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** @returns {{ w:number, h:number, data:Uint8Array }} data 는 RGBA 4바이트/픽셀 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNG 이 아닙니다");
  let pos = 8, ihdr = null, idat = [], palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        w: body.readUInt32BE(0), h: body.readUInt32BE(4),
        depth: body[8], color: body[9], interlace: body[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("IHDR 없음");
  if (ihdr.depth !== 8) throw new Error(`8비트만 지원합니다 (이 파일은 ${ihdr.depth}비트)`);
  if (ihdr.interlace !== 0) throw new Error("인터레이스 PNG 는 지원하지 않습니다");
  const ch = CHANNELS[ihdr.color];
  if (!ch) throw new Error(`지원하지 않는 색 방식: ${ihdr.color}`);

  const raw = inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr;
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[rp]; rp += 1;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rp + i];
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      line[i] =
        filter === 0 ? x :
        filter === 1 ? (x + a) & 255 :
        filter === 2 ? (x + b) & 255 :
        filter === 3 ? (x + ((a + b) >> 1)) & 255 :
        filter === 4 ? (x + paeth(a, b, c)) & 255 : x;
    }
    rp += stride;
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const s = x * ch;
      if (ihdr.color === 6) { out[o] = line[s]; out[o+1] = line[s+1]; out[o+2] = line[s+2]; out[o+3] = line[s+3]; }
      else if (ihdr.color === 2) { out[o] = line[s]; out[o+1] = line[s+1]; out[o+2] = line[s+2]; out[o+3] = 255; }
      else if (ihdr.color === 0) { out[o] = out[o+1] = out[o+2] = line[s]; out[o+3] = 255; }
      else if (ihdr.color === 4) { out[o] = out[o+1] = out[o+2] = line[s]; out[o+3] = line[s+1]; }
      else if (ihdr.color === 3) {
        const idx = line[s];
        out[o] = palette[idx*3]; out[o+1] = palette[idx*3+1]; out[o+2] = palette[idx*3+2];
        out[o+3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(line);
  }
  return { w, h, data: out };
}

/** 투명한 여백을 잘라 낸다 — 원본마다 여백이 달라 그냥 줄이면 키가 제각각이 된다. */
export function trim(img, alphaThreshold = 8) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
    if (img.data[(y * img.w + x) * 4 + 3] <= alphaThreshold) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { w: 1, h: 1, data: new Uint8Array(4) };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1)
    data.set(img.data.subarray(((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x1 + 1) * 4), y * w * 4);
  return { w, h, data };
}

/** 면적 평균 축소. 픽셀 아트를 최근접으로 줄이면 선이 끊기고 얼굴이 뭉개진다.
 *  알파를 곱해 평균한 뒤 되나눈다 — 안 그러면 가장자리에 검은 테가 생긴다. */
export function resize(img, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  const sx = img.w / tw, sy = img.h / th;
  for (let y = 0; y < th; y += 1) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < tw; x += 1) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = y0; j < y1 && j < img.h; j += 1) for (let i = x0; i < x1 && i < img.w; i += 1) {
        const o = (j * img.w + i) * 4, al = img.data[o + 3] / 255;
        r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al;
        a += img.data[o + 3]; n += 1;
      }
      const o = (y * tw + x) * 4;
      if (!n || a === 0) { out[o + 3] = 0; continue; }
      const aw = a / 255;
      out[o] = Math.round(r / aw); out[o + 1] = Math.round(g / aw); out[o + 2] = Math.round(b / aw);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w: tw, h: th, data: out };
}
