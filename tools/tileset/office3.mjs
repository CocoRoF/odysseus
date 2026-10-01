/** 구입한 에셋 팩 Office-3 (images/Office-3) 의 매니페스트 — 시트의 모든 물건을 하나씩 안다.
 *
 *  RPG Maker 규격이다: 한 칸 48px. tile-B-01~05 는 물건 시트(16×16칸), Auto-tile-A4-walls-2/3 은 벽 오토타일
 *  (블록 하나 = 2칸×5칸: 위 2×3 이 벽 윗면, 아래 2×2 가 벽 앞면 — 각 시트에 8×3 = 24 가지).
 *
 *  물건은 **칸 사각형**으로 정한다(cx, cy, w, h — 시트의 칸 좌표). 시트에서 서로 붙어 있는 물건(책상 줄, 캐비닛 더미,
 *  복사기 짝 …)은 자동 분할이 합쳐 버리므로 여기서 사람이 경계를 적었다. 칸이 ㄱ자인 물건은 cells 로 칸을 나열한다.
 *   - foot: 바닥 발자국의 높이(칸, 아래에서부터). 없으면 그림 전체. 키 큰 가구(캐비닛·정수기·유리벽)는 1.
 *   - inset: 상자 안쪽에서 지울 여백(px) — 옆 물건의 그림이 칸 경계를 조금 넘어와 있을 때.
 *   - clear: 지울 사각형들(캔버스 px, pad 포함) — 시트에서 이웃이 겹쳐 그려진 곳. keep "leaf"/"notLeaf" 로 화분 잎만 남기거나 지운다.
 *   - isolate: 가장 큰 덩어리만 남긴다 — 이웃이 칸 안으로 크게 넘어온 물건.
 *   - shares: 칸을 같이 쓰는 이웃의 이름들 — 한 칸에 두 물건이 겹쳐 그려진 곳을 둘 다 잘라 오고 clear 로 가를 때.
 *   - pad: 상자 밖으로 더 잘라 올 여백(px) — 제 그림이 칸 경계를 넘을 때. 오른쪽·위만(스프라이트는 왼쪽 아래가 기준이라
 *     그 두 방향은 늘려도 자리가 그대로다).
 *   - wall: 벽 앞면에 거는 것(그림·시계·게시판·상부장·조명·행잉 플랜트). 바닥 칸을 쓰지 않는다.
 *   - walk: 밟고 다니는 것(매트).
 *  이름은 장면(scenes.ts)이 부르는 키다. 라벨은 편집기 팔레트에 보이는 한국어.
 */

/** 구입한 팩 원본 — 비공개 서브모듈(odysseus-licensed-assets) 안. 공개 저장소에는 없다. */
export const OFFICE3_DIR = "apps/web/public/office/licensed/source/Office-3";
export const OFFICE3_TILE = 48;
export const OFFICE3_SHEETS = { B01: "tile-B-01", B02: "tile-B-02", B03: "tile-B-03", B04: "tile-B-04", B05: "tile-B-05" };

/** 팔레트 묶음 순서 */
export const GROUPS = {
  desk: "책상", chair: "의자", pc: "모니터·PC", storage: "수납장", machine: "사무기기", meeting: "회의",
  lounge: "라운지", kitchen: "탕비실", plant: "식물", partition: "칸막이·유리", misc: "기타", wall: "벽걸이",
};

const O = [];
/** 한 물건 */
const add = (name, sheet, cx, cy, w, h, label, group, opt = {}) => { O.push({ name, sheet, cx, cy, w, h, label, group, ...opt }); };
/** 가로로 늘어선 같은 물건들 */
const row = (prefix, sheet, cx0, cy, w, h, n, labelOf, group, opt = {}) => { for (let i = 0; i < n; i += 1) add(`${prefix}${i + 1}`, sheet, cx0 + i * w, cy, w, h, labelOf(i + 1), group, opt); };

// ── B01: 책상·칸막이·의자·모니터·PC ─────────────────────────────
add("desk-white-1", "B01", 0, 0, 2, 1, "책상 (흰색)", "desk");
add("desk-white-2", "B01", 2, 0, 2, 1, "책상 (흰색) 2", "desk");
add("desk-white-3", "B01", 0, 1, 2, 1, "책상 (흰색) 3", "desk");
add("desk-white-4", "B01", 2, 1, 2, 1, "책상 (흰색) 4", "desk");
add("desk-white-5", "B01", 0, 2, 2, 1, "책상 (흰색) 5", "desk");
add("desk-white-6", "B01", 2, 2, 2, 1, "책상 (흰색) 6", "desk");
add("desk-wood-1", "B01", 4, 0, 2, 1, "책상 (원목)", "desk");
add("desk-wood-2", "B01", 4, 1, 2, 1, "책상 (원목) 2", "desk");
add("desk-wood-3", "B01", 4, 2, 2, 1, "책상 (원목) 3", "desk");
add("desk-wood-drawer-1", "B01", 6, 0, 2, 1, "서랍 책상 (원목)", "desk");
add("desk-wood-drawer-2", "B01", 6, 1, 2, 1, "서랍 책상 (원목) 2", "desk");
add("desk-wood-drawer-3", "B01", 6, 2, 2, 1, "서랍 책상 (원목) 3", "desk");
add("desk-l-white-1", "B01", 8, 0, 2, 2, "ㄱ자 책상 (흰색)", "desk");
add("desk-l-wood-1", "B01", 10, 0, 2, 2, "ㄱ자 책상 (원목)", "desk");
add("desk-l-white-2", "B01", 12, 0, 2, 2, "ㄱ자 책상 (흰색) 2", "desk");
add("desk-l-wood-2", "B01", 14, 0, 2, 2, "ㄱ자 책상 (원목) 2", "desk");
add("desk-l-white-3", "B01", 8, 2, 2, 2, "ㄱ자 책상 (흰색) 3", "desk");
add("desk-l-wood-3", "B01", 10, 2, 2, 2, "ㄱ자 책상 (원목) 3", "desk");
add("desk-l-wood-4", "B01", 12, 2, 2, 2, "ㄱ자 책상 (원목) 4", "desk");
add("desk-l-wood-5", "B01", 14, 2, 2, 2, "ㄱ자 책상 (원목) 5", "desk");
add("divider-blue-1", "B01", 0, 4, 2, 1, "칸막이 판 (파랑, 기둥 없음)", "partition");
add("divider-blue-2", "B01", 0, 5, 2, 1, "칸막이 판 (파랑, 기둥 없음) 2", "partition");
add("divider-blue-post", "B01", 2, 4, 2, 2, "칸막이 (파랑, 기둥)", "partition", { foot: 1 });
add("divider-tall", "B01", 4, 4, 2, 2, "칸막이 (파랑·초록, 높은)", "partition", { foot: 1 });
add("divider-glass-1", "B01", 10, 4, 2, 2, "유리 칸막이 (파랑)", "partition", { foot: 1 });
add("divider-glass-2", "B01", 12, 4, 2, 2, "유리 칸막이 (파랑) 2", "partition", { foot: 1 });
add("divider-glass-gray", "B01", 14, 4, 2, 2, "유리 칸막이 (회색)", "partition", { foot: 1 });
add("divider-blue-double", "B01", 0, 6, 2, 2, "칸막이 (파랑, 두 장)", "partition", { foot: 1 });
add("divider-green-l", "B01", 2, 6, 2, 2, "칸막이 (초록, 꺾임 왼쪽)", "partition");
add("divider-green-r", "B01", 4, 6, 2, 2, "칸막이 (초록, 꺾임 오른쪽)", "partition");
add("divider-green", "B01", 6, 6, 2, 2, "칸막이 (초록, 기둥)", "partition", { foot: 1 });
// 의자 — 색은 그림에서 잰다(importOffice3). 줄 8~10.
for (let c = 0; c < 16; c += 1) add(`chair-a${c + 1}`, "B01", c, 8, 1, 1, "사무 의자", "chair", { colorName: true });
for (let c = 0; c < 16; c += 1) add(`chair-b${c + 1}`, "B01", c, 9, 1, 1, "사무 의자", "chair", { colorName: true });
for (let c = 0; c < 12; c += 1) add(`chair-c${c + 1}`, "B01", c, 10, 1, 1, "사무 의자", "chair", { colorName: true });
add("desk-part-white", "B01", 12, 10, 1, 1, "책상 조각 (흰색)", "pc");
add("pc-desk-white-1", "B01", 13, 10, 1, 1, "PC 책상 (흰색)", "pc");
add("pc-desk-wood-1", "B01", 14, 10, 1, 1, "PC 책상 (원목)", "pc");
add("pc-desk-wood-2", "B01", 15, 10, 1, 1, "PC 책상 (원목) 2", "pc");
row("pc-desk-white-", "B01", 8, 11, 1, 1, 4, (i) => `PC 책상 (흰색) ${i + 1}`, "pc");
row("pc-desk-wood-", "B01", 12, 11, 1, 1, 4, (i) => `PC 책상 (원목) ${i + 2}`, "pc");
row("pc-desk-white-", "B01", 8, 12, 1, 1, 4, (i) => `PC 책상 (흰색) ${i + 5}`, "pc");
row("pc-desk-wood-", "B01", 12, 12, 1, 1, 4, (i) => `PC 책상 (원목) ${i + 6}`, "pc");
// 위 두 row 가 이름을 겹쳐 쓰지 않도록 번호를 다시 매긴다
{
  let wi = 0, di = 0;
  for (const o of O) { if (o.name.startsWith("pc-desk-white-")) { wi += 1; o.name = `pc-desk-white-${wi}`; o.label = `PC 책상 (흰색)${wi > 1 ? ` ${wi}` : ""}`; } if (o.name.startsWith("pc-desk-wood-")) { di += 1; o.name = `pc-desk-wood-${di}`; o.label = `PC 책상 (원목)${di > 1 ? ` ${di}` : ""}`; } }
}
add("monitor-blue-1", "B01", 0, 11, 1, 1, "모니터 (파란 화면)", "pc");
add("monitor-blue-2", "B01", 1, 11, 1, 1, "모니터 (파란 화면) 2", "pc");
add("monitor-dark-1", "B01", 2, 11, 1, 1, "모니터 (검정)", "pc");
add("monitor-dark-2", "B01", 3, 11, 1, 1, "모니터 (검정) 2", "pc");
add("monitor-navy-1", "B01", 4, 11, 1, 1, "모니터 (남색)", "pc");
add("monitor-navy-2", "B01", 5, 11, 1, 1, "모니터 (남색) 2", "pc");
add("monitor-flat-1", "B01", 6, 11, 1, 1, "모니터 (검정, 납작)", "pc");
add("monitor-flat-2", "B01", 7, 11, 1, 1, "모니터 (검정, 납작) 2", "pc");
add("monitor-blue-3", "B01", 0, 12, 1, 1, "모니터 (파란 화면) 3", "pc");
add("monitor-blue-4", "B01", 1, 12, 1, 1, "모니터 (파란 화면) 4", "pc");
add("monitor-dark-3", "B01", 2, 12, 1, 1, "모니터 (검정) 3", "pc");
add("monitor-dark-4", "B01", 3, 12, 1, 1, "모니터 (검정) 4", "pc");
add("monitor-navy-3", "B01", 4, 12, 1, 1, "모니터 (남색) 3", "pc");
add("monitor-navy-4", "B01", 5, 12, 1, 1, "모니터 (남색) 4", "pc");
add("monitor-flat-3", "B01", 6, 12, 1, 1, "모니터 (검정, 납작) 3", "pc");
add("monitor-flat-4", "B01", 7, 12, 1, 1, "모니터 (검정, 납작) 4", "pc");
add("keyboard-white", "B01", 0, 13, 2, 1, "키보드·마우스 (흰색)", "pc");
add("keyboard-gray", "B01", 2, 13, 2, 1, "키보드·마우스 (회색)", "pc");
add("keyboard-dark", "B01", 4, 13, 2, 1, "키보드·마우스 (검정)", "pc");
add("keyboard-light", "B01", 6, 13, 2, 1, "키보드·마우스 (밝은 회색)", "pc");
add("desk-drawer-white", "B01", 0, 14, 2, 1, "서랍 책상 (흰색)", "desk");
add("desk-drawer-blue", "B01", 2, 14, 2, 1, "서랍 책상 (파랑)", "desk");
add("desk-drawer-pink", "B01", 4, 14, 2, 1, "서랍 책상 (분홍)", "desk");
add("desk-drawer-gray", "B01", 6, 14, 2, 1, "서랍 책상 (회색)", "desk");
add("desk-drawer-yellow", "B01", 0, 15, 2, 1, "서랍 책상 (노랑)", "desk");
add("desk-drawer-green", "B01", 2, 15, 2, 1, "서랍 책상 (초록)", "desk");
add("desk-drawer-orange", "B01", 4, 15, 2, 1, "서랍 책상 (주황)", "desk");
add("desk-drawer-gray-2", "B01", 6, 15, 2, 1, "서랍 책상 (회색) 2", "desk");
add("board-white", "B01", 8, 13, 2, 1, "화이트보드 (벽걸이)", "wall", { wall: true });
add("board-cork", "B01", 10, 13, 2, 1, "코르크 게시판", "wall", { wall: true });
add("board-black", "B01", 12, 13, 2, 1, "블랙보드", "wall", { wall: true });
add("board-black-tray", "B01", 8, 14, 2, 1, "블랙보드 (받침)", "wall", { wall: true });
add("board-cork-notes", "B01", 10, 14, 2, 1, "코르크 게시판 (메모)", "wall", { wall: true });
add("plant-small-1", "B01", 14, 13, 1, 1, "화분 (작은)", "plant");
add("plant-small-2", "B01", 15, 13, 1, 1, "화분 (작은) 2", "plant");
add("plant-bush-blue", "B01", 12, 14, 1, 1, "화분 (둥근, 파란 화분)", "plant");
add("plant-aloe", "B01", 12, 15, 1, 1, "화분 (알로에)", "plant");
add("plant-small-3", "B01", 10, 15, 1, 1, "화분 (작은) 3", "plant");
add("plant-small-4", "B01", 11, 15, 1, 1, "화분 (작은) 4", "plant");
add("cooler-1", "B01", 13, 14, 1, 2, "정수기", "misc", { foot: 1 });
add("cooler-2", "B01", 14, 14, 1, 2, "정수기 2", "misc", { foot: 1 });
add("cooler-3", "B01", 15, 14, 1, 2, "정수기 3", "misc", { foot: 1 });

// ── B02: 수납장·사무기기 ─────────────────────────────────────────
add("cabinet-file-gray-1", "B02", 0, 0, 1, 2, "서류 캐비닛 (회색)", "storage", { foot: 1 });
add("cabinet-file-gray-2", "B02", 0, 2, 1, 2, "서류 캐비닛 (회색) 2", "storage", { foot: 1 });
add("cabinet-file-tan-1", "B02", 1, 0, 1, 2, "서류 캐비닛 (황갈색)", "storage", { foot: 1 });
add("cabinet-file-tan-2", "B02", 1, 2, 1, 2, "서류 캐비닛 (황갈색) 2", "storage", { foot: 1 });
add("cabinet-file-cream-open-1", "B02", 2, 0, 2, 2, "서류 캐비닛 (크림, 열린 서랍)", "storage", { foot: 1 });
add("cabinet-file-cream-open-2", "B02", 2, 2, 2, 2, "서류 캐비닛 (크림, 열린 서랍) 2", "storage", { foot: 1 });
add("cabinet-file-gray-3", "B02", 4, 0, 1, 2, "서류 캐비닛 (회색) 3", "storage", { foot: 1 });
add("cabinet-file-gray-4", "B02", 4, 2, 1, 2, "서류 캐비닛 (회색) 4", "storage", { foot: 1 });
add("cabinet-file-gray-5", "B02", 5, 0, 1, 2, "서류 캐비닛 (회색) 5", "storage", { foot: 1 });
add("cabinet-file-gray-6", "B02", 5, 2, 1, 2, "서류 캐비닛 (회색) 6", "storage", { foot: 1 });
add("cabinet-file-wide-gray-1", "B02", 6, 0, 2, 2, "서류 캐비닛 (회색, 넓은)", "storage", { foot: 1 });
add("cabinet-file-wide-gray-2", "B02", 6, 2, 2, 2, "서류 캐비닛 (회색, 넓은) 2", "storage", { foot: 1 });
add("cabinet-file-gray-7", "B02", 8, 0, 1, 2, "서류 캐비닛 (회색) 7", "storage", { foot: 1 });
add("cabinet-file-gray-8", "B02", 8, 2, 1, 2, "서류 캐비닛 (회색) 8", "storage", { foot: 1 });
add("cabinet-file-wood-1", "B02", 9, 0, 1, 2, "서류 캐비닛 (원목)", "storage", { foot: 1 });
add("cabinet-file-wood-2", "B02", 9, 2, 1, 2, "서류 캐비닛 (원목) 2", "storage", { foot: 1 });
add("cabinet-door-cream", "B02", 10, 0, 2, 2, "양문 캐비닛 (크림)", "storage", { foot: 1 });
add("cabinet-lateral-gray", "B02", 10, 2, 1, 2, "3단 서랍장 (회색)", "storage", { foot: 1 });
add("cabinet-lateral-tan", "B02", 11, 2, 1, 2, "3단 서랍장 (황갈색, 서류)", "storage", { foot: 1 });
add("cabinet-door-gray-1", "B02", 12, 0, 2, 2, "양문 캐비닛 (회색)", "storage", { foot: 1 });
add("cabinet-door-gray-2", "B02", 12, 2, 2, 2, "양문 캐비닛 (회색) 2", "storage", { foot: 1 });
add("cabinet-door-wood-1", "B02", 14, 0, 2, 2, "양문 캐비닛 (원목)", "storage", { foot: 1 });
add("cabinet-door-wood-2", "B02", 14, 2, 2, 2, "양문 캐비닛 (원목) 2", "storage", { foot: 1 });
add("credenza-cream", "B02", 0, 4, 2, 2, "미닫이 수납장 (크림)", "storage", { foot: 1 });
add("credenza-gray", "B02", 0, 6, 2, 2, "미닫이 수납장 (회색)", "storage", { foot: 1 });
add("bookshelf-cream", "B02", 2, 4, 2, 2, "책장 (크림, 바인더)", "storage", { foot: 1 });
add("bookshelf-gray", "B02", 2, 6, 2, 2, "책장 (회색, 바인더)", "storage", { foot: 1 });
add("drawers-printer-cream", "B02", 4, 4, 2, 2, "서랍장 + 프린터 (크림)", "machine", { foot: 1 });
add("desk-printer-cream", "B02", 4, 6, 2, 2, "프린터 책상 (크림)", "machine", { foot: 1 });
add("bookshelf-wood-1", "B02", 6, 4, 2, 2, "책장 (원목, 바인더)", "storage", { foot: 1 });
add("bookshelf-wood-2", "B02", 6, 6, 2, 2, "책장 (원목, 바인더) 2", "storage", { foot: 1 });
add("credenza-gray-2", "B02", 8, 4, 2, 2, "미닫이 수납장 (회색) 2", "storage", { foot: 1 });
add("credenza-wood", "B02", 8, 6, 2, 2, "미닫이 수납장 (원목)", "storage", { foot: 1 });
add("bookshelf-gray-2", "B02", 10, 4, 2, 2, "책장 (회색, 바인더) 2", "storage", { foot: 1 });
add("bookshelf-wood-3", "B02", 10, 6, 2, 2, "책장 (원목, 바인더) 3", "storage", { foot: 1 });
add("drawers-printer-gray", "B02", 12, 4, 2, 2, "서랍장 + 프린터 (회색)", "machine", { foot: 1 });
add("desk-printer-wood", "B02", 12, 6, 2, 2, "프린터 책상 (원목)", "machine", { foot: 1 });
add("bookshelf-wood-4", "B02", 14, 4, 2, 2, "책장 (원목, 바인더) 4", "storage", { foot: 1 });
add("bookshelf-wood-5", "B02", 14, 6, 2, 2, "책장 (원목, 바인더) 5", "storage", { foot: 1 });
row("copier-cream-", "B02", 0, 8, 2, 2, 4, (i) => `복합기 (크림)${i > 1 ? ` ${i}` : ""}`, "machine", { foot: 1 });
row("copier-gray-", "B02", 8, 8, 2, 2, 4, (i) => `복합기 (회색)${i > 1 ? ` ${i}` : ""}`, "machine", { foot: 1 });
row("copier-cream-b", "B02", 0, 10, 2, 2, 4, (i) => `복합기 (크림) ${i + 4}`, "machine", { foot: 1 });
row("copier-gray-b", "B02", 8, 10, 2, 2, 4, (i) => `복합기 (회색) ${i + 4}`, "machine", { foot: 1 });
// 이 줄의 1·3번째 복합기는 오른쪽 옆판이 옆 칸으로 2px 넘어간다 — 그 몫을 제 그림으로 가져오고(pad), 옆 칸(2·4번째)에서는 지운다(inset)
for (const o of O) {
  if (/^copier-(cream|gray)-b[13]$/.test(o.name)) o.pad = { r: 2 };
  if (/^copier-(cream|gray)-b[24]$/.test(o.name)) o.inset = { l: 2 };
}
row("shredder-", "B02", 0, 12, 1, 2, 15, (i) => `파쇄기${i > 1 ? ` ${i}` : ""}`, "machine", { foot: 1 });
add("cooler-4", "B02", 15, 12, 1, 2, "정수기 4", "misc", { foot: 1 });
row("cooler-b", "B02", 0, 14, 1, 2, 15, (i) => `정수기 ${i + 4}`, "misc", { foot: 1 });

// ── B03: 회의·라운지 ───────────────────────────────────────────
add("meeting-8-dark", "B03", 0, 0, 4, 2, "회의 탁자 (8인, 진갈색)", "meeting");
add("meeting-8-dark-2", "B03", 4, 0, 4, 2, "회의 탁자 (8인, 진갈색, 둘)", "meeting");
add("meeting-8-light", "B03", 0, 2, 4, 2, "회의 탁자 (8인, 밝은 원목)", "meeting");
add("meeting-8-light-2", "B03", 4, 2, 4, 2, "회의 탁자 (8인, 밝은 원목, 황갈 의자)", "meeting");
add("meeting-8-wood", "B03", 0, 4, 4, 2, "회의 탁자 (8인, 원목)", "meeting");
add("meeting-6-wood", "B03", 4, 4, 4, 2, "회의 탁자 (6인, 원목)", "meeting");
add("meeting-8-brown", "B03", 0, 6, 4, 2, "회의 탁자 (8인, 갈색 의자)", "meeting");
add("meeting-8-brown-2", "B03", 0, 8, 4, 2, "회의 탁자 (8인, 갈색·검정 의자)", "meeting");
// 오른쪽 좌석의 밑단이 아래 칸(5,7) 위쪽으로 6px 내려온다 — 그 칸도 잘라 오고, 같은 칸의 유리 탁자는 isolate 로 뗀다
// (5,7) 칸 위 8줄이 소파 밑단, 그 아래는 유리 탁자다. 탁자 줄을 지우고, 소파 오른쪽 모서리에 겹쳐 그려진 화분 잎도 지운다.
add("sofa-l-brown", "B03", 4, 6, 2, 2, "ㄱ자 소파 (갈색)", "lounge", {
  cells: [[4, 6], [5, 6], [4, 7], [5, 7]],
  clear: [{ x0: 48, y0: 56, x1: 96, y1: 96 }, { x0: 48, y0: 40, x1: 96, y1: 56, keep: "notLeaf" }],
  isolate: true,
  // (5,7) 칸은 유리 탁자와 나눠 쓴다 — 서로의 몫을 clear 로 지웠다(office3.test 가 이 선언이 있을 때만 겹침을 허락한다)
  shares: ["table-glass-plant"],
});
add("armchair-brown", "B03", 7, 6, 1, 2, "1인 소파 (갈색)", "lounge", { foot: 1 });
// 화분 잎이 칸 위로 솟는다(pad). 왼쪽 칸 위 8줄에 겹쳐 그려진 소파 밑단은 잎만 남기고 지운다(clear) — 떨어진 부스러기는 isolate
add("table-glass-plant", "B03", 5, 7, 2, 1, "유리 탁자 (화분·노트북)", "lounge", { pad: { t: 4 }, clear: [{ x0: 0, y0: 0, x1: 48, y1: 12, keep: "leaf" }], isolate: true });
add("sofa-l-white", "B03", 4, 8, 2, 2, "ㄱ자 소파 (흰색)", "lounge", { cells: [[4, 8], [5, 8], [4, 9]] });
add("sofa-l-white-2", "B03", 6, 8, 2, 2, "ㄱ자 소파 (흰색, 반대)", "lounge", { cells: [[6, 8], [7, 8], [7, 9]] });
add("whiteboard-wheel-1", "B03", 8, 0, 2, 2, "화이트보드 (이동식)", "meeting", { foot: 1 });
add("whiteboard-wheel-2", "B03", 10, 0, 2, 2, "화이트보드 (이동식) 2", "meeting", { foot: 1 });
add("picture-mountain", "B03", 12, 0, 1, 1, "액자 (산)", "wall", { wall: true });
add("picture-abstract-1", "B03", 13, 0, 1, 1, "액자 (추상)", "wall", { wall: true });
add("cooler-c1", "B03", 14, 0, 1, 2, "정수기 (회의실)", "misc", { foot: 1 });
add("bin-tall-gray", "B03", 15, 0, 1, 2, "쓰레기통 (큰, 회색)", "misc", { foot: 1 });
add("bin-dark", "B03", 13, 1, 1, 1, "쓰레기통 (검정)", "misc");
add("whiteboard-wheel-3", "B03", 8, 2, 2, 2, "화이트보드 (이동식) 3", "meeting", { foot: 1 });
add("screen-white-1", "B03", 10, 2, 2, 2, "프로젝터 스크린 (흰색)", "meeting", { foot: 1 });
add("screen-cream-1", "B03", 12, 2, 2, 2, "프로젝터 스크린 (크림)", "meeting", { foot: 1 });
add("plant-tall-1", "B03", 14, 2, 1, 2, "화분 (키 큰)", "plant", { foot: 1 });
add("plant-palm-1", "B03", 15, 2, 1, 2, "야자 화분", "plant", { foot: 1 });
add("whiteboard-wheel-4", "B03", 8, 4, 2, 2, "화이트보드 (이동식) 4", "meeting", { foot: 1 });
add("projector-white", "B03", 10, 4, 2, 1, "프로젝터 (흰색)", "meeting");
add("projector-gray", "B03", 12, 4, 2, 1, "프로젝터 (회색)", "meeting");
add("cooler-c2", "B03", 14, 4, 1, 2, "정수기 (회의실) 2", "misc", { foot: 1 });
add("cooler-c3", "B03", 15, 4, 1, 2, "정수기 (회의실) 3", "misc", { foot: 1 });
add("whiteboard-wheel-5", "B03", 8, 6, 2, 2, "화이트보드 (이동식) 5", "meeting", { foot: 1 });
add("screen-white-2", "B03", 10, 6, 2, 2, "프로젝터 스크린 (흰색) 2", "meeting", { foot: 1 });
add("screen-cream-2", "B03", 12, 6, 2, 2, "프로젝터 스크린 (크림) 2", "meeting", { foot: 1 });
add("plant-tall-2", "B03", 14, 6, 1, 2, "화분 (키 큰) 2", "plant", { foot: 1 });
add("bin-gray", "B03", 15, 7, 1, 1, "쓰레기통 (회색)", "misc");
add("sofa-l-brown-2", "B03", 8, 8, 2, 2, "ㄱ자 소파 (갈색) 2", "lounge");
add("sofa-l-blue", "B03", 10, 8, 2, 2, "ㄱ자 소파 (파랑)", "lounge");
add("armchair-blue", "B03", 12, 8, 1, 2, "1인 소파 (파랑)", "lounge", { foot: 1 });
add("table-food-1", "B03", 13, 8, 1, 2, "작은 탁자 (음식)", "lounge", { foot: 1 });
add("sofa-blue", "B03", 14, 8, 2, 2, "소파 (파랑, 2인)", "lounge");
add("desk-exec-chair", "B03", 0, 10, 2, 2, "임원 책상 (의자)", "desk");
add("plant-tall-3", "B03", 2, 10, 1, 2, "화분 (키 큰) 3", "plant", { foot: 1 });
add("picture-tall", "B03", 3, 10, 1, 2, "액자 (세로)", "wall", { wall: true });
add("desk-chair-monitor", "B03", 4, 10, 2, 2, "책상 (의자·모니터)", "desk");
add("desk-chair-food", "B03", 6, 10, 2, 2, "책상 (의자·음식)", "desk");
// 오른쪽 팔걸이가 유리 탁자 칸으로 2px 넘어간다
add("armchair-brown-2", "B03", 8, 10, 1, 2, "1인 소파 (갈색) 2", "lounge", { foot: 1, pad: { r: 2 } });
// 양옆 칸 경계에 이웃 물건의 세로선이 한 줄씩 붙는다 — 몸통만 남긴다
add("table-glass-food", "B03", 9, 10, 2, 2, "유리 탁자 (음식)", "lounge", { isolate: true });
add("armchair-brown-3", "B03", 11, 10, 1, 2, "1인 소파 (갈색) 3", "lounge", { foot: 1 });
add("plant-tall-4", "B03", 12, 10, 1, 2, "화분 (키 큰) 4", "plant", { foot: 1 });
add("side-table-wood", "B03", 13, 10, 1, 2, "작은 탁자 (원목)", "lounge", { foot: 1 });
add("plant-tall-5", "B03", 14, 10, 1, 2, "화분 (키 큰) 5", "plant", { foot: 1 });
add("picture-sea", "B03", 15, 10, 1, 1, "액자 (바다)", "wall", { wall: true });
add("plant-small-5", "B03", 15, 11, 1, 1, "화분 (작은) 5", "plant");
add("bin-gray-2", "B03", 8, 12, 1, 2, "쓰레기통 (큰, 회색) 2", "misc", { foot: 1 });
add("whiteboard-wheel-6", "B03", 9, 12, 2, 2, "화이트보드 (이동식) 6", "meeting", { foot: 1 });
add("cooler-c4", "B03", 11, 12, 1, 2, "정수기 (회의실) 4", "misc", { foot: 1 });
add("cooler-c5", "B03", 12, 12, 1, 2, "정수기 (회의실) 5", "misc", { foot: 1 });
add("projector-small", "B03", 13, 12, 1, 1, "프로젝터 (소형)", "meeting");
add("picture-abstract-2", "B03", 14, 12, 1, 2, "액자 (추상, 세로)", "wall", { wall: true });
add("picture-abstract-3", "B03", 15, 12, 1, 1, "액자 (추상) 3", "wall", { wall: true });
add("plant-small-6", "B03", 15, 13, 1, 1, "화분 (작은) 6", "plant");
add("seat-pair-brown-1", "B03", 0, 13, 2, 1, "2인 좌석 (갈색)", "lounge");
add("seat-pair-blue-1", "B03", 2, 13, 2, 1, "2인 좌석 (파랑)", "lounge");
add("seat-pair-brown-2", "B03", 4, 13, 2, 1, "2인 좌석 (갈색) 2", "lounge");
add("seat-pair-blue-2", "B03", 6, 13, 2, 1, "2인 좌석 (파랑, 컵)", "lounge");
add("board-white-big", "B03", 0, 14, 2, 2, "화이트보드 (벽걸이, 큰)", "wall", { wall: true });
add("board-white-tray", "B03", 2, 14, 2, 2, "화이트보드 (벽걸이, 받침)", "wall", { wall: true });
add("board-white-notes", "B03", 4, 14, 2, 2, "화이트보드 (벽걸이, 메모)", "wall", { wall: true });
add("whiteboard-notes", "B03", 6, 14, 2, 2, "화이트보드 (이동식, 메모)", "meeting", { foot: 1 });
add("mat-blue", "B03", 8, 15, 2, 1, "매트 (파랑)", "misc", { walk: true });
add("screen-white-3", "B03", 10, 14, 2, 2, "프로젝터 스크린 (흰색) 3", "meeting", { foot: 1 });
add("screen-white-4", "B03", 12, 14, 2, 2, "프로젝터 스크린 (흰색) 4", "meeting", { foot: 1 });

// ── B04: 탕비실 ──────────────────────────────────────────────────
add("counter-tan-coffee", "B04", 0, 0, 3, 2, "조리대 (황갈색, 커피머신·싱크)", "kitchen");
add("counter-gray-espresso", "B04", 4, 0, 4, 2, "조리대 (회색, 에스프레소·싱크·간식)", "kitchen");
row("microwave-", "B04", 8, 0, 1, 1, 4, (i) => `전자레인지${i > 1 ? ` ${i}` : ""}`, "kitchen");
row("microwave-b", "B04", 8, 1, 1, 1, 4, (i) => `전자레인지 ${i + 4}`, "kitchen");
add("upper-cabinet-tan-1", "B04", 12, 0, 2, 1, "상부장 (황갈색)", "wall", { wall: true });
add("upper-cabinet-white-1", "B04", 14, 0, 2, 1, "상부장 (흰색)", "wall", { wall: true });
add("lower-cabinet-tan-1", "B04", 12, 1, 2, 1, "하부장 (황갈색)", "kitchen");
add("lower-cabinet-white-1", "B04", 14, 1, 2, 1, "하부장 (흰색)", "kitchen");
add("counter-dark-coffee", "B04", 0, 2, 3, 2, "조리대 (짙은 회색, 커피머신·싱크)", "kitchen");
add("counter-wood-espresso", "B04", 4, 2, 4, 2, "조리대 (원목, 에스프레소·싱크·간식)", "kitchen");
add("fridge-white", "B04", 8, 2, 1, 2, "냉장고 (흰색)", "kitchen", { foot: 1 });
add("fridge-glass-1", "B04", 9, 2, 1, 2, "쇼케이스 냉장고", "kitchen", { foot: 1 });
add("vending-drink-1", "B04", 10, 2, 1, 2, "음료 자판기", "kitchen", { foot: 1 });
add("vending-drink-2", "B04", 11, 2, 1, 2, "음료 자판기 2", "kitchen", { foot: 1 });
add("upper-cabinet-tan-2", "B04", 12, 2, 2, 1, "상부장 (황갈색) 2", "wall", { wall: true });
add("upper-cabinet-gray", "B04", 14, 2, 2, 1, "상부장 (회색)", "wall", { wall: true });
add("lower-cabinet-tan-2", "B04", 12, 3, 2, 1, "하부장 (황갈색) 2", "kitchen");
add("lower-cabinet-gray", "B04", 14, 3, 2, 1, "하부장 (회색)", "kitchen");
add("upper-cabinet-white-2", "B04", 12, 4, 2, 1, "상부장 (흰색) 2", "wall", { wall: true });
add("lower-cabinet-white-2", "B04", 12, 5, 2, 1, "하부장 (흰색, 서랍)", "kitchen");
add("wardrobe-gray", "B04", 14, 4, 2, 2, "양문 장 (회색, 큰)", "storage", { foot: 1 });
add("counter-dark-plates", "B04", 0, 4, 3, 2, "조리대 (짙은 회색, 소화기·접시)", "kitchen");
add("snack-rack-1", "B04", 3, 4, 1, 2, "간식 선반", "kitchen", { foot: 1 });
add("counter-wood-espresso-2", "B04", 4, 4, 4, 2, "조리대 (원목, 에스프레소·싱크·간식) 2", "kitchen");
add("fridge-gray", "B04", 8, 4, 1, 2, "냉장고 (회색)", "kitchen", { foot: 1 });
add("fridge-glass-2", "B04", 9, 4, 1, 2, "쇼케이스 냉장고 2", "kitchen", { foot: 1 });
add("vending-drink-3", "B04", 10, 4, 1, 2, "음료 자판기 3", "kitchen", { foot: 1 });
add("vending-drink-4", "B04", 11, 4, 1, 2, "음료 자판기 4", "kitchen", { foot: 1 });
add("locker-gray", "B04", 0, 6, 1, 2, "사물함 (회색)", "storage", { foot: 1 });
add("locker-white", "B04", 1, 6, 1, 2, "사물함 (흰색)", "storage", { foot: 1 });
add("cabinet-open-tan", "B04", 2, 6, 1, 2, "장 (황갈색, 열린 선반)", "storage", { foot: 1 });
add("wardrobe-tan", "B04", 3, 6, 1, 2, "장 (황갈색, 문)", "storage", { foot: 1 });
add("counter-white-toaster", "B04", 4, 6, 4, 2, "조리대 (흰색, 토스터·주전자·과일)", "kitchen");
const stoolColor = ["빨강", "파랑", "초록", "노랑"];
for (let i = 0; i < 8; i += 1) add(`barchair-${i + 1}`, "B04", 8 + i, 6, 1, 2, `바 의자 (${stoolColor[i % 4]})${i >= 4 ? " 2" : ""}`, "kitchen", { foot: 1 });
add("counter-gray-appliances", "B04", 0, 8, 4, 2, "조리대 (회색, 커피머신·정수·양념·오븐)", "kitchen");
add("counter-wood-toaster", "B04", 4, 8, 4, 2, "조리대 (원목, 토스터·주전자·과일)", "kitchen");
for (let i = 0; i < 8; i += 1) add(`barchair-${i + 9}`, "B04", 8 + i, 8, 1, 2, `바 의자 (${stoolColor[i % 4]}) ${i >= 4 ? 4 : 3}`, "kitchen", { foot: 1 });
add("table-wood-1", "B04", 0, 10, 2, 2, "탁자 (원목)", "kitchen");
add("table-gray-1", "B04", 2, 10, 2, 2, "탁자 (회색)", "kitchen");
add("cafe-blue-1", "B04", 4, 10, 2, 2, "카페 테이블 (파랑, 스툴)", "kitchen");
add("cafe-green-1", "B04", 6, 10, 2, 2, "카페 테이블 (초록, 스툴)", "kitchen");
for (let i = 0; i < 4; i += 1) add(`chair-k${i + 1}`, "B04", 8 + i, 10, 1, 2, `식탁 의자 (${stoolColor[i]})`, "kitchen", { foot: 1 });
for (let i = 0; i < 4; i += 1) add(`chair-k${i + 5}`, "B04", 12 + i, 10, 1, 2, `식탁 의자 (${stoolColor[i]}, 프레임)`, "kitchen", { foot: 1 });
add("table-wood-2", "B04", 0, 12, 2, 2, "탁자 (원목) 2", "kitchen");
add("cafe-brown-1", "B04", 2, 12, 2, 2, "카페 테이블 (갈색, 스툴)", "kitchen");
add("cafe-blue-2", "B04", 4, 12, 2, 2, "카페 테이블 (파랑, 스툴) 2", "kitchen");
add("cafe-brown-2", "B04", 6, 12, 2, 2, "카페 테이블 (갈색, 스툴) 2", "kitchen");
add("counter-coffee-station", "B04", 8, 12, 2, 2, "커피 스테이션 (회색)", "kitchen");
add("counter-oven-station", "B04", 10, 12, 2, 2, "조리대 (오븐·양념)", "kitchen");
add("counter-condiments", "B04", 12, 12, 2, 2, "조리대 (양념·선반)", "kitchen");
add("snack-rack-2", "B04", 14, 12, 1, 2, "간식 선반 2", "kitchen", { foot: 1 });
add("bin-gray-3", "B04", 15, 12, 1, 2, "쓰레기통 (큰, 회색) 3", "misc", { foot: 1 });
add("table-gray-2", "B04", 0, 14, 2, 2, "탁자 (회색) 2", "kitchen");
add("cafe-brown-3", "B04", 2, 14, 2, 2, "카페 테이블 (갈색·회색 스툴)", "kitchen");
add("cafe-white-1", "B04", 4, 14, 2, 2, "카페 테이블 (흰색, 스툴)", "kitchen");
add("cafe-white-2", "B04", 6, 14, 2, 2, "카페 테이블 (흰색, 회색 스툴)", "kitchen");
add("shelf-mugs", "B04", 8, 14, 2, 2, "머그 선반장", "kitchen", { foot: 1 });
add("shelf-dishes", "B04", 10, 14, 2, 2, "식기 선반장", "kitchen", { foot: 1 });
add("shelf-snacks", "B04", 12, 14, 2, 2, "간식 선반장", "kitchen", { foot: 1 });
add("cooler-k1", "B04", 14, 14, 1, 2, "정수기 (탕비실)", "misc", { foot: 1 });
add("bin-gray-4", "B04", 15, 14, 1, 2, "쓰레기통 (큰, 회색) 4", "misc", { foot: 1 });

// ── B05: 유리벽·조명·안내데스크·업무 자리 ─────────────────────────
add("glass-wall-1", "B05", 0, 0, 2, 2, "유리벽 (두 장)", "partition", { foot: 1 });
add("glass-wall-2", "B05", 2, 0, 2, 2, "유리벽 (두 장) 2", "partition", { foot: 1 });
add("glass-wall-wide", "B05", 4, 0, 2, 2, "유리벽 (한 장)", "partition", { foot: 1 });
add("glass-corner-1", "B05", 6, 0, 2, 2, "유리벽 (꺾임)", "partition");
add("glass-wall-3", "B05", 8, 0, 2, 2, "유리벽 (두 장) 3", "partition", { foot: 1 });
add("window-slide", "B05", 10, 0, 2, 2, "창문 (미닫이)", "wall", { wall: true });
add("plant-hanging-big", "B05", 12, 0, 2, 2, "행잉 플랜트 (큰)", "wall", { wall: true });
add("plant-palm-2", "B05", 14, 0, 1, 2, "야자 화분 2", "plant", { foot: 1 });
add("plant-tall-6", "B05", 15, 0, 1, 2, "화분 (키 큰) 6", "plant", { foot: 1 });
add("light-panel", "B05", 0, 2, 2, 1, "천장등 (패널)", "wall", { wall: true });
add("light-fluorescent", "B05", 2, 2, 2, 1, "천장등 (형광)", "wall", { wall: true });
add("light-round-1", "B05", 0, 3, 1, 1, "천장등 (둥근)", "wall", { wall: true });
add("light-round-2", "B05", 2, 3, 1, 1, "천장등 (둥근, 작은)", "wall", { wall: true });
add("glass-corner-2", "B05", 4, 2, 2, 2, "유리벽 (꺾임) 2", "partition");
add("glass-corner-window", "B05", 6, 2, 2, 2, "유리벽 (꺾임, 창)", "partition");
add("light-spot-1", "B05", 8, 2, 1, 1, "스포트라이트", "wall", { wall: true });
add("light-spot-2", "B05", 9, 2, 1, 1, "스포트라이트 2", "wall", { wall: true });
add("light-spot-3", "B05", 8, 3, 1, 1, "스포트라이트 3", "wall", { wall: true });
add("light-spot-4", "B05", 9, 3, 1, 1, "스포트라이트 4", "wall", { wall: true });
add("lamp-pendant-1", "B05", 10, 2, 1, 2, "펜던트 조명", "wall", { wall: true });
add("lamp-pendant-2", "B05", 11, 2, 1, 2, "펜던트 조명 2", "wall", { wall: true });
add("lamp-pendant-cream", "B05", 12, 2, 1, 2, "펜던트 조명 (크림)", "wall", { wall: true });
add("lamp-pendant-glass", "B05", 13, 2, 1, 2, "펜던트 조명 (유리)", "wall", { wall: true });
add("lamp-ring", "B05", 14, 2, 1, 2, "펜던트 조명 (링)", "wall", { wall: true });
add("lamp-pendant-3", "B05", 15, 2, 1, 2, "펜던트 조명 3", "wall", { wall: true });
add("glass-wall-4", "B05", 0, 4, 2, 2, "유리벽 (틀) ", "partition", { foot: 1 });
add("glass-wall-5", "B05", 2, 4, 2, 2, "유리벽 (틀) 2", "partition", { foot: 1 });
add("glass-corner-3", "B05", 4, 4, 2, 2, "유리벽 (꺾임) 3", "partition");
add("door-glass", "B05", 6, 4, 2, 2, "유리 칸막이 (여닫이)", "wall", { wall: true });
add("plant-palm-3", "B05", 8, 4, 1, 2, "야자 화분 3", "plant", { foot: 1 });
add("clock-blue", "B05", 9, 4, 1, 1, "벽시계 (파랑)", "wall", { wall: true });
add("plant-aloe-2", "B05", 9, 5, 1, 1, "화분 (알로에) 2", "plant");
add("coffee-station-1", "B05", 10, 4, 2, 2, "커피 스테이션 (커피머신·컵)", "kitchen", { cells: [[10, 4], [10, 5], [11, 5]] });
add("clock-dark", "B05", 11, 4, 1, 1, "벽시계 (검정)", "wall", { wall: true });
add("coffee-station-2", "B05", 12, 4, 2, 2, "커피 스테이션 (커피머신·드립)", "kitchen");
add("plant-hanging-1", "B05", 14, 4, 1, 2, "행잉 플랜트", "wall", { wall: true });
add("plant-hanging-2", "B05", 15, 4, 1, 2, "행잉 플랜트 2", "wall", { wall: true });
add("reception-gray", "B05", 0, 6, 4, 2, "안내 데스크 (회색, 모니터)", "desk");
add("reception-display", "B05", 4, 6, 4, 2, "안내 데스크 (진열장·모니터)", "desk");
add("reception-dark", "B05", 8, 6, 4, 2, "안내 데스크 (짙은 회색)", "desk");
add("cooler-r1", "B05", 12, 6, 1, 2, "정수기 (로비)", "misc", { foot: 1 });
add("cooler-r2", "B05", 13, 6, 1, 2, "정수기 (로비) 2", "misc", { foot: 1 });
add("plant-bush-1", "B05", 14, 6, 1, 2, "화분 (둥근)", "plant", { foot: 1 });
add("plant-tall-7", "B05", 15, 6, 1, 2, "화분 (키 큰) 7", "plant", { foot: 1 });
add("reception-brown", "B05", 0, 8, 2, 2, "안내 데스크 (갈색, 둥근)", "desk", { pad: { r: 13 } });
add("desk-monitor-chair", "B05", 2, 8, 2, 2, "책상 (모니터·의자)", "desk", { foot: 1, inset: { l: 13 } });
add("plant-palm-blue", "B05", 4, 8, 1, 2, "야자 화분 (파란 화분)", "plant", { foot: 1 });
add("picture-map", "B05", 5, 8, 1, 1, "액자 (지도)", "wall", { wall: true });
add("plant-hanging-3", "B05", 6, 8, 1, 2, "행잉 플랜트 3", "wall", { wall: true });
add("plant-tall-8", "B05", 7, 8, 1, 2, "화분 (키 큰) 8", "plant", { foot: 1 });
add("credenza-plants", "B05", 8, 8, 2, 2, "수납장 (화분 둘)", "storage", { foot: 1 });
add("desk-monitor-phone", "B05", 10, 8, 2, 2, "책상 (모니터·전화)", "desk", { foot: 1 });
add("chair-blue-side", "B05", 12, 8, 1, 2, "의자 (파랑, 옆)", "lounge", { foot: 1 });
add("table-food-2", "B05", 13, 8, 1, 2, "작은 탁자 (음식) 2", "lounge", { foot: 1 });
add("plant-tall-9", "B05", 14, 8, 1, 2, "화분 (키 큰) 9", "plant", { foot: 1 });
add("picture-abstract-4", "B05", 15, 8, 1, 1, "액자 (추상) 4", "wall", { wall: true });
add("desk-chair-gray", "B05", 0, 10, 2, 2, "책상 (회색, 의자)", "desk");
add("plant-palm-4", "B05", 2, 10, 1, 2, "야자 화분 4", "plant", { foot: 1 });
add("clock-white", "B05", 3, 10, 1, 1, "벽시계 (흰색)", "wall", { wall: true });
add("desk-chair-laptop", "B05", 4, 10, 2, 2, "책상 (의자·노트북)", "desk");
add("desk-chair-food-2", "B05", 6, 10, 2, 2, "책상 (의자·음식) 2", "desk");
add("chair-gray-side", "B05", 8, 10, 1, 2, "의자 (회색, 옆)", "lounge", { foot: 1 });
add("counter-appliances", "B05", 9, 10, 3, 2, "조리대 (전자레인지·커피머신)", "kitchen", { foot: 1 });
add("chair-gray-side-2", "B05", 12, 10, 1, 2, "의자 (회색, 옆) 2", "lounge", { foot: 1 });
add("coffee-cart", "B05", 13, 10, 1, 2, "커피머신 카트", "kitchen", { foot: 1 });
add("chair-gray-side-3", "B05", 14, 10, 1, 2, "의자 (회색, 옆) 3", "lounge", { foot: 1 });
add("cabinet-door-wood-3", "B05", 15, 10, 1, 2, "양문 캐비닛 (원목, 좁은)", "storage", { foot: 1 });
add("round-table-wood-1", "B05", 0, 12, 2, 2, "원탁 (원목)", "meeting");
add("round-table-blue-1", "B05", 2, 12, 2, 2, "원탁 (파랑)", "meeting");
add("round-table-wood-2", "B05", 4, 12, 2, 2, "원탁 (원목) 2", "meeting");
add("round-table-blue-2", "B05", 6, 12, 2, 2, "원탁 (파랑, 컵)", "meeting");
add("chair-blue-side-2", "B05", 9, 12, 1, 2, "의자 (파랑, 옆) 2", "lounge", { foot: 1 });
add("table-food-3", "B05", 10, 12, 1, 2, "작은 탁자 (음식) 3", "lounge", { foot: 1 });
add("chair-blue-side-3", "B05", 11, 12, 1, 2, "의자 (파랑, 옆) 3", "lounge", { foot: 1 });
add("cooler-r3", "B05", 12, 12, 1, 2, "정수기 (로비) 3", "misc", { foot: 1 });
add("cooler-glass", "B05", 13, 12, 1, 2, "정수기 (유리)", "misc", { foot: 1 });
add("picture-abstract-5", "B05", 14, 12, 1, 1, "액자 (추상) 5", "wall", { wall: true });
add("picture-abstract-6", "B05", 15, 12, 1, 1, "액자 (추상) 6", "wall", { wall: true });
add("plant-small-7", "B05", 15, 13, 1, 1, "화분 (작은) 7", "plant");
add("workstation-1", "B05", 0, 14, 2, 2, "업무 자리 (PC·의자)", "desk", { foot: 1 });
add("workstation-2", "B05", 2, 14, 2, 2, "업무 자리 (PC·의자) 2", "desk", { foot: 1 });
add("workstation-3", "B05", 4, 14, 2, 2, "업무 자리 (PC·의자) 3", "desk", { foot: 1 });
add("workstation-4", "B05", 6, 14, 2, 2, "업무 자리 (PC·의자) 4", "desk", { foot: 1 });
add("server-kiosk", "B05", 10, 14, 1, 2, "서버 랙", "machine", { foot: 1 });
add("vending-coffee", "B05", 11, 14, 1, 2, "커피 자판기", "kitchen", { foot: 1 });
add("cooler-r4", "B05", 12, 14, 1, 2, "정수기 (로비) 4", "misc", { foot: 1 });
add("mat-blue-2", "B05", 8, 15, 2, 1, "매트 (파랑) 2", "misc", { walk: true });

/** 장면이 부르던 옛 이름 → 이 팩의 이름. 장면 파일은 새 이름으로 고쳤고, 관리자가 저장한 프리셋은 이 표로 옮긴다. */
export const LEGACY_NAMES = {
  plant: "plant-small-1", clock: "clock-blue", cabinet: "cabinet-file-gray-1", bin: "bin-dark", standDesk: "standDesk",
  rack: "server-kiosk", drawer: "cabinet-lateral-gray", corkboard: "board-cork", coffeeTable: "table-glass-plant",
  whiteboard: "whiteboard-wheel-1", recycle: "bin-gray", cooler: "cooler-1", bookshelf: "bookshelf-wood-1",
  sofa: "sofa-blue", firstAid: "picture-map", extinguisher: "picture-abstract-1", divider: "divider-glass-gray", coffee: "coffee-cart",
  vendingA: "vending-drink-1", vendingB: "vending-drink-2", printer: "drawers-printer-gray", meetingTable: "meeting-6-wood",
  lamp: "plant-tall-1", copier: "copier-cream-1", console: "desk-monitor-chair", elevator: "door-glass",
};

/** 업무 시작 지점 — 모니터·전화가 놓인 책상(2×2, 발자국 2×1). 장면의 start 가 이 이름을 쓴다. */
O.push({ ...O.find((o) => o.name === "desk-monitor-phone"), name: "standDesk", label: "업무 시작 책상" });

export const OBJECTS = O;

{
  const seen = new Set();
  for (const o of O) { if (seen.has(o.name)) throw new Error(`[office3] 이름이 겹친다: ${o.name}`); seen.add(o.name); }
}

/** 벽 스타일 — A4 시트의 블록(bx 0..7, by 0..2). 사무실에 어울리는 것만 고른다. 첫 것이 기본. */
export const WALL_STYLES = [
  { key: "office", sheet: "Auto-tile-A4-walls-3", bx: 6, by: 2, label: "베이지 벽" },
  { key: "white", sheet: "Auto-tile-A4-walls-3", bx: 3, by: 2, label: "크림 벽" },
  { key: "gray", sheet: "Auto-tile-A4-walls-3", bx: 0, by: 0, label: "회색 콘크리트" },
  { key: "panel", sheet: "Auto-tile-A4-walls-3", bx: 0, by: 1, label: "회색 패널" },
  { key: "bluegray", sheet: "Auto-tile-A4-walls-3", bx: 3, by: 0, label: "청회색 벽" },
  { key: "wood", sheet: "Auto-tile-A4-walls-3", bx: 4, by: 0, label: "원목 패널" },
  { key: "tile", sheet: "Auto-tile-A4-walls-3", bx: 5, by: 0, label: "흰 타일" },
  { key: "bluetile", sheet: "Auto-tile-A4-walls-3", bx: 3, by: 1, label: "파란 타일" },
  { key: "brick", sheet: "Auto-tile-A4-walls-3", bx: 6, by: 1, label: "붉은 벽돌" },
  { key: "navy", sheet: "Auto-tile-A4-walls-3", bx: 5, by: 2, label: "남색 패널" },
  { key: "wainscot", sheet: "Auto-tile-A4-walls-3", bx: 7, by: 2, label: "원목 하부 패널" },
  { key: "green", sheet: "Auto-tile-A4-walls-3", bx: 1, by: 1, label: "초록 패널" },
  { key: "glass", sheet: "Auto-tile-A4-walls-2", bx: 0, by: 0, label: "유리 파티션" },
  { key: "cream2", sheet: "Auto-tile-A4-walls-2", bx: 1, by: 0, label: "크림 패널" },
  { key: "white2", sheet: "Auto-tile-A4-walls-2", bx: 6, by: 0, label: "흰 벽" },
];
