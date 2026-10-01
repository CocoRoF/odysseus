/** 2배 해상도(64px/칸)로 직접 그리는 붓들 — 팩에 없는 것만.
 *
 *  draw.mjs 의 붓은 32px 칸에 그려 2배로 뻥튀기되므로 팩 소품 옆에서 거칠다. 팩과 같은 화면에 서는
 *  것은 처음부터 2배로 그린다. 규칙은 같다: 빛은 위에서, 윗면·앞면·옆면 세 톤, 검은 외곽선 없음.
 */
import { Canvas } from "./png.mjs";

const toImg = (cv) => ({ w: cv.w, h: cv.h, data: cv.d });

/** 엘리베이터 문 — 복도 벽에 걸린다(2칸 폭). 닫힌 두 짝의 스테인리스 문과 층 표시등. */
export function elevator() {
  const W = 120, H = 52;
  const cv = new Canvas(W, H);
  const frame = [150, 158, 174], frameLite = [200, 206, 220], frameDark = [96, 104, 122];
  const door = [176, 184, 200], doorLite = [206, 212, 226], doorDark = [128, 136, 154];
  // 문틀
  cv.rect(0, 8, W, H - 8, frame);
  cv.hline(0, 8, W, frameLite);
  cv.vline(0, 8, H - 8, frameLite);
  cv.vline(W - 1, 8, H - 8, frameDark);
  cv.hline(0, H - 1, W, frameDark);
  // 두 짝 문 — 가운데 틈
  const inset = 6;
  const half = (W - inset * 2 - 2) / 2;
  for (const [x0] of [[inset], [inset + half + 2]]) {
    cv.rect(x0, 14, half, H - 18, door);
    cv.hline(x0, 14, half, doorLite);
    cv.vline(x0, 14, H - 18, doorLite);
    cv.vline(x0 + half - 1, 14, H - 18, doorDark);
    cv.hline(x0, H - 5, half, doorDark);
    // 솔질 자국 — 스테인리스
    for (let y = 18; y < H - 8; y += 3) cv.hline(x0 + 3, y, half - 6, [0, 0, 0], 14);
  }
  cv.rect(inset + half, 14, 2, H - 18, [60, 66, 80]);
  // 층 표시등 — 문 위 가운데
  cv.rect(W / 2 - 14, 0, 28, 8, [40, 46, 60]);
  cv.rect(W / 2 - 12, 2, 24, 4, [24, 28, 40]);
  cv.rect(W / 2 - 4, 3, 8, 2, [255, 176, 96]);
  return toImg(cv);
}

/** 사무실 출입문 — 양문. 2칸 폭·2칸 높이(48px 칸)로 벽 앞면에 걸린다. 팩(Office-3)에 문이 없어 팩의 결로 그린다:
 *  검은 외곽선 없이 세 톤, 회색 문틀, 세로 창이 난 두 짝, 발판. open 이면 두 짝이 안쪽으로 젖혀지고 문 너머가 밝다. */
export function officeDoor(open = false) {
  const W = 96, H = 96;
  const cv = new Canvas(W, H);
  const F = [168, 176, 190], FL = [214, 220, 232], FD = [104, 112, 130];
  const P = [226, 228, 233], PL = [244, 245, 248], PD = [186, 190, 200];
  const G = [196, 228, 247], GL = [235, 247, 255], GD = [150, 196, 228];
  const HD = [78, 84, 98], HL = [140, 148, 164];
  const K = [200, 204, 212], KD = [160, 166, 178];
  const SEAM = [120, 126, 140];
  const X0 = 10, X1 = 86, Y0 = 12, Y1 = 96;
  const IX0 = X0 + 3, IX1 = X1 - 3, IY0 = Y0 + 8, IY1 = Y1 - 3;
  // 문틀과 상인방
  cv.rect(X0, Y0, X1 - X0, Y1 - Y0, F);
  cv.hline(X0, Y0, X1 - X0, FL);
  cv.vline(X0, Y0, Y1 - Y0, FL);
  cv.vline(X1 - 1, Y0, Y1 - Y0, FD);
  cv.hline(X0, Y1 - 1, X1 - X0, FD);
  cv.hline(X0 + 1, Y0 + 7, X1 - X0 - 2, FD);
  // 문지방
  cv.rect(IX0, IY1, IX1 - IX0, Y1 - 1 - IY1, KD);
  cv.hline(IX0, IY1, IX1 - IX0, K);

  const glass = (gx, gy, gw, gh) => {
    cv.rect(gx, gy, gw, gh, FD);
    cv.rect(gx + 1, gy + 1, gw - 2, gh - 2, G);
    if (gw > 8) {
      cv.rect(gx + gw - 4, gy + gh - 12, 3, 11, GD);
      for (let i = 0; i < 6; i += 1) { cv.px(gx + 2 + i, gy + 7 - i, GL); cv.px(gx + 3 + i, gy + 7 - i, GL); }
    }
  };
  const leaf = (x, w, handle) => {
    cv.rect(x, IY0, w, IY1 - IY0, P);
    cv.hline(x, IY0, w, PL);
    cv.vline(x, IY0, IY1 - IY0, PL);
    cv.vline(x + w - 1, IY0, IY1 - IY0, PD);
    cv.hline(x, IY1 - 1, w, PD);
    glass(x + Math.floor((w - 14) / 2), IY0 + 6, 14, 40);
    const hx = handle === "right" ? x + w - 8 : x + 5;
    cv.rect(hx, IY0 + 36, 3, 14, HD);
    cv.vline(hx, IY0 + 36, 14, HL);
    cv.rect(x + 3, IY1 - 14, w - 6, 12, K);
    cv.hline(x + 3, IY1 - 3, w - 6, KD);
  };

  if (!open) {
    leaf(IX0, 34, "right");
    cv.rect(IX0 + 34, IY0, 2, IY1 - IY0, SEAM);
    leaf(IX0 + 36, 34, "left");
    return { w: W, h: H, data: cv.d };
  }

  // 열림 — 문 너머는 밝고, 두 짝은 문틀 안쪽에 얇게 젖혀져 있다
  for (let y = IY0; y < IY1; y += 1) {
    const t = (y - IY0) / (IY1 - IY0);
    cv.hline(IX0, y, IX1 - IX0, [Math.round(255 - 41 * t), Math.round(255 - 15 * t), Math.round(255 - 2 * t)]);
  }
  const swung = (x, w, edgeRight) => {
    cv.rect(x, IY0, w, IY1 - IY0, P);
    cv.hline(x, IY0, w, PL);
    cv.vline(edgeRight ? x + w - 1 : x, IY0, IY1 - IY0, PD);
    cv.vline(edgeRight ? x : x + w - 1, IY0, IY1 - IY0, PL);
    cv.hline(x, IY1 - 1, w, PD);
    glass(x + 3, IY0 + 6, 5, 40);
    cv.rect(x + 2, IY1 - 14, w - 4, 12, K);
    cv.hline(x + 2, IY1 - 3, w - 4, KD);
    // 젖혀진 짝의 그림자 — 안쪽 바닥
    cv.rect(edgeRight ? x + w : x - 3, IY0 + 2, 3, IY1 - IY0 - 2, [40, 60, 90], 48);
  };
  swung(IX0, 11, true);
  swung(IX1 - 11, 11, false);
  return { w: W, h: H, data: cv.d };
}
