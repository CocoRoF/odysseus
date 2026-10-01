/** 사무실 에셋 팩(images/office_pixel_assets_128)의 매니페스트 — 원본 README 보다 한 단계 더 안다.
 *
 *  팩의 README 는 "전부 128×128 RGBA" 까지만 말한다. 게임에 넣으려면 그 위에 세 가지를 더 알아야 한다:
 *   1. **한 칸이 몇 px 인가.** 책상이 76px, 사람이 96px(48 월드 px × 2) 이면 64px = 한 칸이 맞다.
 *      그래서 아틀라스는 2배(64px/칸)로 짓고 화면은 월드 32px 로 그린다(고해상도).
 *   2. **바닥 발자국.** 그림의 불투명 상자에서 계산한다 — 너비는 칸 올림, 깊이는 1칸, 키가 크면 위로 솟는다.
 *   3. **파일의 사정.** 자판기 L/R 은 서로 다른 두 기계, 소파 L/R 은 한 소파의 두 반쪽(합친다),
 *      회의탁자 R 은 캔버스 전체에 노이즈가 깔린 불량 파일(쓰지 않는다 — 왼쪽이 그 자체로 탁자다),
 *      바닥 타일 11장은 알파가 반투명한 오버레이라 **바탕색 위에 합성해야** 바닥이 된다.
 *
 *  여기 적힌 이름(`desk`, `vendingA` …)이 장면(scenes.ts)이 부르는 이름이다.
 */

export const PACK_DIR = "images/office_pixel_assets_128";
/** 아틀라스 배율 — 팩 64px 가 월드 한 칸(32px) */
export const PACK_SCALE = 2;
export const PACK_TILE = 64;

/** 바닥 — 반투명 오버레이를 어떤 바탕 위에 합성할지. 밝기(lum)는 사람이 서 있는 바닥으로 읽힐 만큼 밝게.
 *  server 만 일부러 어둡다(서버실 그레이팅) — 대신 벽·소품이 밝아 사람은 읽힌다. */
export const FLOORS = {
  speckle: { file: "floor_01_light_speckle", base: [152, 158, 172] },
  dense: { file: "floor_02_dense_speckle", base: [140, 146, 160] },
  panel: { file: "floor_03_light_panel", base: [128, 138, 154] },
  blueGrid: { file: "floor_04_blue_grid", base: [130, 146, 162] },
  grayGrid: { file: "floor_05_gray_grid", base: [126, 136, 152] },
  paleGrid: { file: "floor_06_pale_grid", base: [140, 150, 164] },
  oak: { file: "floor_07_light_oak", base: [176, 168, 158] },
  walnut: { file: "floor_08_walnut", base: [128, 122, 118] },
  concrete: { file: "floor_09_concrete", base: [124, 134, 150] },
  server: { file: "floor_10_server_access", base: [92, 98, 110] },
  mat: { file: "floor_11_entry_mat", base: [70, 76, 88] },
};

/** 벽 — 팩의 네 띠. 벽은 **한 칸(64px) 두께**다:
 *   - 가로벽(wall-h, 128×64): 윗면 캡(wall_top 16px) + 앞면(wall_bottom 의 얼굴 24px 를 두 번 이어 48px).
 *     방의 뒷벽·복도벽이 이것이다. 앞면이 있어야 벽에 높이가 생긴다.
 *   - 세로벽(wall-v, 64×128): 안쪽 레일(wall_right 16px) + 몸통 32px + 바깥 레일 16px. 좌우 대칭이라
 *     옆방과 **한 칸을 나눠 써도**(방 사이 벽은 하나다) 어느 쪽에서 그려도 같다.
 *   - wall_left 는 위아래가 둥근 기둥 하나라(104px) 반복하면 마디가 생긴다 — 쓰지 않는다. */
export const WALLS = { top: "wall_top", bottom: "wall_bottom", left: "wall_left", right: "wall_right" };
/** 벽 몸통 색 — 컷(방에서 도려낸 모서리)과 모서리 칸을 채우는 색. wall_bottom 의 얼굴에서 뽑았다. */
export const WALL_BODY = [74, 84, 102];

/**
 * 소품. `w`,`h` 는 바닥 발자국(칸). 그림이 발자국보다 크면(자판기·캐비닛·램프) 위로 솟는다.
 *  - file: 원본 하나
 *  - merge: [왼쪽, 오른쪽] 두 반쪽을 이어 붙인다 (소파·회의탁자)
 *  - over: 다른 소품 위에 얹는다 (책상 위 노트북·모니터) — [{file, dx, dy, scale}] 는 바탕 그림 상자의
 *    왼쪽 위 기준 오프셋. 캔버스는 얹은 것까지 담게 늘어난다(위로 솟으면 rise 가 는다).
 *  - despeckle: 가장 큰 덩어리만 남긴다 (불량 파일)
 *  - wall: 벽에 거는 것 — 바닥 칸을 쓰지 않는다. 가로벽의 앞면(24 월드 px)에 걸린다.
 *
 *  쓰지 않는 파일: prop_02 의자(앉기가 없다), prop_25 회의탁자 R(불량). 의자를 뺀 나머지는 전부 쓴다.
 */
export const PROPS = {
  desk: { file: "prop_01_work_desk", w: 2, h: 1 },
  // 얹는 것은 **원본 크기 그대로**(scale 1) — 줄이면 화면 속 글자 무늬가 뭉개져 노이즈로 보였다
  standDesk: { file: "prop_01_work_desk", w: 2, h: 1, over: [{ file: "prop_04_open_laptop", dx: 13, dy: -22 }] },
  /** 콘솔 — 모니터·키보드가 놓인 책상. 의자는 없다(서서 본다). 서버실 앞의 관제 자리. */
  console: {
    file: "prop_01_work_desk", w: 2, h: 1,
    over: [
      { file: "prop_03_desktop_monitor", dx: 5, dy: -36 },
      { file: "prop_05_keyboard_mouse", dx: 8, dy: 8, scale: 0.75 },
    ],
  },
  drawer: { file: "prop_06_mobile_drawer", w: 1, h: 1 },
  cabinet: { file: "prop_07_filing_cabinet", w: 1, h: 1 },
  bookshelf: { file: "prop_08_bookshelf", w: 2, h: 1 },
  plant: { file: "prop_09_potted_plant", w: 1, h: 1 },
  printer: { file: "prop_10_desktop_printer", w: 1, h: 1 },
  cooler: { file: "prop_11_water_dispenser", w: 1, h: 1 },
  vendingA: { file: "prop_12_vending_machine_left", w: 1, h: 1 },
  vendingB: { file: "prop_13_vending_machine_right", w: 1, h: 1 },
  coffee: { file: "prop_14_coffee_machine", w: 1, h: 1 },
  bin: { file: "prop_15_trash_bin", w: 1, h: 1 },
  recycle: { file: "prop_16_recycle_bin", w: 1, h: 1 },
  whiteboard: { file: "prop_17_whiteboard", w: 2, h: 1 }, // 바퀴 달린 이동식 — 바닥에 선다
  lamp: { file: "prop_20_floor_lamp", w: 1, h: 1 },
  sofa: { merge: ["prop_21_sofa_left", "prop_22_sofa_right"], w: 3, h: 1 },
  coffeeTable: { file: "prop_23_coffee_table", w: 2, h: 1 },
  meetingTable: { merge: ["prop_24_meeting_table_left", "prop_25_meeting_table_right"], despeckle: true, w: 3, h: 1 },
  divider: { file: "prop_26_office_divider", w: 2, h: 1 },
  rack: { file: "prop_27_server_rack", w: 1, h: 1 },
  copier: { file: "prop_28_photocopier", w: 1, h: 1 },
  // 벽걸이
  corkboard: { file: "prop_18_cork_board", w: 2, h: 1, wall: true },
  clock: { file: "prop_19_clock", w: 1, h: 1, wall: true },
  extinguisher: { file: "prop_29_fire_extinguisher", w: 1, h: 1, wall: true },
  firstAid: { file: "prop_30_first_aid_box", w: 1, h: 1, wall: true },
};
