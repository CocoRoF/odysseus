/**
 * 평면도의 기하 불변식 — 겹치지 않는다는 약속을 CI 가 지킨다.
 *
 * `layoutRoom()` 과 `buildFloor()` 안에는 겹침·고립을 잡는 검사가 있지만
 * `process.env.NODE_ENV !== "production"` 안에 있다. 실제로 배포되는 빌드에서는
 * 꺼져 있으므로, 그 약속을 지키는 것은 결국 이 파일이다.
 *
 * 의존성을 늘리지 않는다 — Node 내장 test 러너와 타입 스트리핑으로 돈다:
 *   node --test apps/web/components/office/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildFloor, canStand, decorZOf, doorGapOf, findPath, layoutRoom, roomDoorCols, roomSolidGrid, walkableRects, FACE, MAX_COLS, MAX_ROOMS, MAX_ROWS, TILE, WALL, type Room, type RoomLayout } from "./floorplan.ts";
import { WALL_FACE_VARIANT, WALL_TOP_COUNT, WALL_TOP_VARIANT } from "./atlas.ts";
import { SCENES, SCENE_IDS, WALKABLE_PROPS, doorCols, doorColsOf, footprintOf, sceneFor, type SceneSpec } from "./scenes.ts";
import { validateScene } from "./scene-check.ts";

const EMPTY = 0;
const SOLID = 1;
const PROP = 5;
/** 사람 수는 장면의 자리(6)를 넘겨 봐야 '곁에 더 세우기'가 드러난다 */
const CREW_COUNTS = [0, 1, 3, 6, 8, 11];
const CATEGORIES = ["infra", "dev", "ai", "data", "office", "communication", "planning", "problem", "compliance", ""];

const rooms = (n: number, category = (i: number) => CATEGORIES[i % CATEGORIES.length]) =>
  Array.from({ length: n }, (_, i) => ({
    slug: `room-${i}`,
    label: `방 ${i}`,
    accent: "#62A8C8",
    category: category(i),
  }));

const stable = (layout: ReturnType<typeof layoutRoom>) => JSON.stringify({ ...layout, grid: [...layout.grid] });

/** 모든 장면 × 남/북 × 거울 — 배치기가 받을 수 있는 방의 전 경우 */
function everyRoom(): Room[] {
  const out: Room[] = [];
  for (const id of SCENE_IDS) {
    const sc = SCENES[id];
    for (const side of ["north", "south"] as const) {
      for (const mirror of [false, true]) {
        out.push({
          id: `${id}-${side}${mirror ? "-m" : ""}`,
          label: id,
          x: 2 * TILE,
          y: TILE,
          w: (sc.cols + 2) * TILE,
          h: (sc.rows + 3) * TILE,
          cols: sc.cols,
          rows: sc.rows,
          side,
          accent: "#62A8C8",
          scene: id,
          spec: sc,
          floorKey: sc.floor,
          doorC: mirror ? sc.cols - doorColsOf(sc)[0] - 2 : doorColsOf(sc)[0],
          category: "",
          mirror,
        });
      }
    }
  }
  return out;
}

test("buildFloor: 방들이 벽 한 칸만 나눠 쓰며 층 밖으로 나가거나 복도를 밟지 않는다", () => {
  for (let n = 1; n <= MAX_ROOMS; n += 1) {
    const floor = buildFloor(rooms(n));
    assert.equal(floor.rooms.length, n, `시험 ${n}개인데 방이 ${floor.rooms.length}개`);
    for (const room of floor.rooms) {
      assert.ok(room.x >= 0 && room.y >= 0, "방이 층 밖(음수)이다");
      assert.ok(room.x + room.w <= floor.world.width, "방이 층 오른쪽 밖으로 나갔다");
      assert.ok(room.y + room.h <= floor.world.height, "방이 층 아래 밖으로 나갔다");
      const overlapsCorridor = room.y < floor.corridor.bottom && room.y + room.h > floor.corridor.top;
      assert.ok(!overlapsCorridor, "방이 복도를 밟았다");
      if (room.side === "north") assert.equal(room.y + room.h, floor.corridor.top, `${room.id} 북쪽 방이 복도에 닿지 않는다`);
      else assert.equal(room.y, floor.corridor.bottom, `${room.id} 남쪽 방이 복도에 닿지 않는다`);
      assert.ok(SCENE_IDS.includes(room.scene), `모르는 장면 ${room.scene}`);
      assert.equal(room.w, (room.cols + 2) * TILE);
      assert.equal(room.h, (room.rows + 3) * TILE, "고리 두 줄 + 앞면 한 줄");
      // 방은 복도보다 안쪽에서 시작한다 — 엘리베이터 자리가 비어 있다
      assert.ok(room.x >= floor.corridor.left + 3 * TILE, `${room.id} 가 엘리베이터 자리를 덮는다`);
    }
    for (let i = 0; i < floor.rooms.length; i += 1) {
      for (let j = i + 1; j < floor.rooms.length; j += 1) {
        const a = floor.rooms[i];
        const b = floor.rooms[j];
        const ax1 = a.x + a.w, bx1 = b.x + b.w;
        const overlapX = Math.min(ax1, bx1) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlapX > 0 && overlapY > 0) {
          // 겹친다면 같은 줄의 옆방이고, 겹치는 폭은 정확히 벽 한 칸이다
          assert.equal(a.side, b.side, `${a.id} 와 ${b.id} 가 줄을 넘어 겹친다`);
          assert.equal(overlapX, WALL, `${a.id} 와 ${b.id} 가 ${overlapX}px 겹친다 (벽 한 칸이어야 한다)`);
        }
        // 안쪽 칸은 절대 겹치지 않는다
        const ia = { x: a.x + WALL, y: a.y + WALL + FACE, w: a.cols * TILE, h: a.rows * TILE };
        const ib = { x: b.x + WALL, y: b.y + WALL + FACE, w: b.cols * TILE, h: b.rows * TILE };
        const apart = ia.x + ia.w <= ib.x || ib.x + ib.w <= ia.x || ia.y + ia.h <= ib.y || ib.y + ib.h <= ia.y;
        assert.ok(apart, `방 ${a.id} 와 ${b.id} 의 안쪽이 겹친다`);
      }
    }
    // 벽 — 복도 고리 칸(문 칸 빼고)은 윗면, 복도 앞면 줄(문 아래 빼고)은 앞면. 변형 번호는 이웃에서 다시 계산한 것과 같다.
    const wallAt = new Map(floor.walls.map((w) => [`${w.x / TILE},${w.y / TILE}`, w] as const));
    assert.equal(wallAt.size, floor.walls.length, `벽 칸이 겹친다 (방 ${n}개)`);
    const open = new Set(floor.rooms.flatMap((r) => { const g = doorGapOf(r); return [0, 1].flatMap((i) => [`${g.x / TILE + i},${g.y / TILE}`, `${g.x / TILE + i},${g.y / TILE + 1}`]); }));
    const cx0 = (floor.corridor.left - WALL) / TILE, cx1 = (floor.corridor.right + WALL) / TILE;
    const cyTop = floor.corridor.top / TILE - 1, cyFace = floor.corridor.top / TILE, cyBot = floor.corridor.bottom / TILE;
    for (let cx = cx0; cx < cx1; cx += 1) {
      for (const cy of [cyTop, cyBot]) { const k = `${cx},${cy}`; assert.equal(wallAt.get(k)?.kind, open.has(k) ? undefined : "top", `복도 고리 칸 ${k} (방 ${n}개)`); }
      if (cx > cx0 && cx < cx1 - 1) { const k = `${cx},${cyFace}`; assert.equal(wallAt.get(k)?.kind, open.has(k) ? undefined : "face", `복도 앞면 칸 ${k} (방 ${n}개)`); }
    }
    for (let cy = cyTop; cy <= cyBot; cy += 1) for (const cx of [cx0, cx1 - 1]) assert.equal(wallAt.get(`${cx},${cy}`)?.kind, "top", `복도 끝 기둥 ${cx},${cy}`);
    for (const w of floor.walls) {
      const cx = w.x / TILE, cy = w.y / TILE;
      assert.ok(Number.isInteger(cx) && Number.isInteger(cy), "벽 칸이 격자에 맞지 않는다");
      if (w.kind === "top") {
        const has = (dx: number, dy: number) => wallAt.get(`${cx + dx},${cy + dy}`)?.kind === "top";
        const mask = (has(0, -1) ? 1 : 0) | (has(1, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(1, 1) ? 8 : 0) | (has(0, 1) ? 16 : 0) | (has(-1, 1) ? 32 : 0) | (has(-1, 0) ? 64 : 0) | (has(-1, -1) ? 128 : 0);
        assert.equal(w.variant, WALL_TOP_VARIANT[mask], `윗면 ${cx},${cy} 변형`);
        assert.ok(w.variant < WALL_TOP_COUNT);
      } else {
        const has = (dx: number, dy: number) => wallAt.get(`${cx + dx},${cy + dy}`)?.kind === "face";
        const bits = (has(-1, 0) ? 1 : 0) | (has(0, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(0, 1) ? 8 : 0);
        assert.equal(w.variant, WALL_FACE_VARIANT[bits], `앞면 ${cx},${cy} 변형`);
        // 앞면 위에는 언제나 윗면이 있다
        assert.equal(wallAt.get(`${cx},${cy - 1}`)?.kind, "top", `앞면 ${cx},${cy} 위에 윗면이 없다`);
      }
    }
    // 방의 위 고리 아래 앞면 줄: 문 아래(남쪽 방)와 컷 위(윗면) 빼고 전부 앞면
    for (const r of floor.rooms) {
      const g0 = roomSolidGrid(r);
      const [d0, d1] = roomDoorCols(r);
      for (let c = 0; c < r.cols; c += 1) {
        const k = `${(r.x + WALL) / TILE + c},${(r.y + WALL) / TILE}`;
        const want = r.side === "south" && (c === d0 || c === d1) ? undefined : g0[c] === SOLID ? "top" : "face";
        assert.equal(wallAt.get(k)?.kind, want, `${r.id} 앞면 줄 칸 ${c} (방 ${n}개)`);
      }
    }
    // 복도 벽걸이는 앞면 줄에 걸리고 출근 자리(왼쪽 끝) 위에는 없다
    for (const d of floor.decor) {
      assert.equal(d.y + d.h, floor.corridor.top + FACE, `복도 벽걸이 ${d.kind} 의 아래가 앞면 아래선이 아니다`);
      assert.ok(d.x >= floor.corridor.left + 3 * TILE, `복도 벽걸이 ${d.kind} 가 출근 자리 위에 걸렸다`);
    }
    // 출입구는 복도 왼쪽 끝, 출근 자리와 같은 줄이다
    assert.equal(floor.gate.y, floor.corridorY);
    assert.ok(floor.gate.x <= floor.spawn.x && floor.gate.x >= floor.corridor.left, "출입구가 복도 왼쪽 끝이 아니다");
    // 출근 자리는 복도 안이고 화분에 막히지 않는다
    const layouts = new Map(floor.rooms.map((r) => [r.id, layoutRoom(r, 3)]));
    const rects = walkableRects(floor, layouts);
    assert.ok(canStand(floor.spawn.x, floor.spawn.y, rects, 14, floor.blocked), "출근 자리에 설 수 없다");
    // 길찾기 — 출근 자리에서 모든 방의 서는 자리·시작 지점 앞까지 걷는 칸만 밟는 길이 있고, 꺾는 점마다 설 수 있다.
    // 같은 방의 자리끼리도 길이 있다(동료가 옮겨 다닌다). 직선으로 가면 책상을 뚫으므로 길이 곧 검증이다.
    for (const r of floor.rooms) {
      const L = layouts.get(r.id) as RoomLayout;
      const goals = [L.start.stand, ...L.standing.map((s) => ({ x: s.x, y: s.y }))];
      for (const g of goals) {
        const path = findPath(rects, floor.spawn, g);
        assert.ok(path && path.length > 0, `${r.id}: 출근 자리에서 (${g.x},${g.y}) 까지 길이 없다 (방 ${n}개)`);
        for (const p of (path ?? []).slice(0, -1)) assert.ok(canStand(p.x, p.y, rects, 14, floor.blocked), `${r.id}: 꺾는 점 (${p.x},${p.y}) 에 설 수 없다 (방 ${n}개)`);
      }
      for (const a of L.standing) for (const b of L.standing) if (a !== b) assert.ok(findPath(rects, a, b), `${r.id}: 자리 (${a.cell.c},${a.cell.r}) 에서 (${b.cell.c},${b.cell.r}) 로 길이 없다`);
    }
    // 걷는 칸이 아닌 곳으로는 길이 없다
    assert.equal(findPath(rects, floor.spawn, { x: floor.corridor.left - TILE, y: floor.corridorY }), null);
    for (const p of floor.props) assert.ok(!canStand(p.x + TILE / 2, p.y + TILE / 2, rects, 14, floor.blocked), "복도 화분을 밟을 수 있다");
    // 복도 한가운데 줄은 끝에서 끝까지 걸을 수 있다 — 화분이 길을 막지 않는다
    for (let x = floor.corridor.left + 14; x <= floor.corridor.right - 14; x += 8) {
      assert.ok(canStand(x, floor.corridorY, rects, 14, floor.blocked), `복도 x=${x} 에 설 수 없다`);
    }
    assert.equal(JSON.stringify(buildFloor(rooms(n))), JSON.stringify(floor), "buildFloor 결정론");
  }
});

test("buildFloor: 장면이 층 안에서 최대한 겹치지 않고, 겹치면 거울로 뒤집는다", () => {
  const same = buildFloor(rooms(3, () => "office")).rooms.map((r) => r.scene);
  assert.equal(new Set(same).size, 3, `같은 분야 세 방이 같은 장면이다: ${same.join(",")}`);
  const pair = buildFloor(rooms(2, (i) => ["problem", "data"][i])).rooms.map((r) => r.scene);
  assert.notEqual(pair[0], pair[1], `첫 선호가 같은 두 분야가 같은 장면이다: ${pair.join(",")}`);
  const nine = buildFloor(rooms(9)).rooms.map((r) => r.scene);
  assert.equal(new Set(nine).size, 9, `방 9개에 장면 ${new Set(nine).size}종: ${nine.join(",")}`);
  for (const cat of CATEGORIES) for (let k = 0; k < 4; k += 1) assert.ok(SCENE_IDS.includes(sceneFor(cat, k)));
  // 방 16개 — 장면 아홉이 다 쓰이면 두 번째는 거울
  const many = buildFloor(rooms(MAX_ROOMS)).rooms;
  const seen = new Map<string, number>();
  for (const r of many) {
    const n = seen.get(r.scene) ?? 0;
    assert.equal(r.mirror, n % 2 === 1, `${r.id}/${r.scene} 의 거울 여부가 틀렸다`);
    seen.set(r.scene, n + 1);
  }
});

test("layoutRoom: 소품·컷·벽이 겹치지 않고, 시작 지점과 서는 자리가 전부 문에서 닿는다 (남/북 × 거울)", () => {
  const all = [...everyRoom(), ...buildFloor(rooms(MAX_ROOMS)).rooms];
  for (const room of all) {
    for (const count of CREW_COUNTS) {
      const layout = layoutRoom(room, count);
      const where = `${room.id}/${room.scene}/${room.side}${room.mirror ? "/거울" : ""}/${count}`;
      const cols = room.cols, rows = room.rows;
      const originX = room.x + WALL;
      const originY = room.y + WALL + FACE;
      const cellOf = (x: number, y: number) => ({
        col: Math.floor((x - originX) / TILE),
        row: Math.floor((y - originY) / TILE),
      });
      const inside = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows;
      const at = (c: number, r: number) => layout.grid[r * cols + c];

      // 컷은 방 안에 있고 SOLID 로 새겨졌다
      let solid = 0;
      for (const cut of layout.cuts) {
        const { col, row } = cellOf(cut.x, cut.y);
        for (let dr = 0; dr < cut.h / TILE; dr += 1) for (let dc = 0; dc < cut.w / TILE; dc += 1) {
          assert.ok(inside(col + dc, row + dr), `${where} 컷이 방 밖이다`);
          assert.equal(at(col + dc, row + dr), SOLID, `${where} 컷 칸 (${col + dc},${row + dr}) 이 벽이 아니다`);
          solid += 1;
        }
      }
      assert.equal([...layout.grid].filter((v) => v === SOLID).length, solid, `${where} 컷 밖에 SOLID 가 있다`);

      for (const p of layout.props) {
        const { col, row } = cellOf(p.x, p.y);
        const size = footprintOf(p.kind);
        assert.ok(inside(col, row) && inside(col + size.w - 1, row + size.h - 1), `${where} 소품 ${p.kind} 이 방을 벗어났다`);
        if (WALKABLE_PROPS.has(p.kind)) continue;
        for (let dr = 0; dr < size.h; dr += 1) for (let dc = 0; dc < size.w; dc += 1) {
          assert.equal(at(col + dc, row + dr), PROP, `${where} 소품 ${p.kind} 칸이 덮였다`);
        }
      }

      const s = cellOf(layout.start.x, layout.start.y);
      assert.equal(at(s.col, s.row), PROP, `${where} 시작 지점 칸이 비어 있다`);
      const stand = cellOf(layout.start.stand.x, layout.start.stand.y);
      assert.ok(inside(stand.col, stand.row), `${where} 시작 지점 앞이 방 밖이다`);
      for (const c of [s.col, s.col + 1]) {
        assert.equal(at(c, stand.row), EMPTY, `${where} 시작 지점 앞 칸 (${c},${stand.row}) 이 막혔다`);
      }

      assert.ok(layout.standing.length >= Math.min(count, 30), `${where} 서는 자리가 ${layout.standing.length}개뿐이다 (사람 ${count})`);
      const cells = new Set<number>();
      for (const sp of layout.standing) {
        const { col, row } = cellOf(sp.x, sp.y);
        assert.ok(inside(col, row), `${where} 서는 자리가 방 밖이다`);
        assert.equal(at(col, row), EMPTY, `${where} 서는 자리 (${col},${row}) 가 소품이나 벽 위다`);
        const key = row * cols + col;
        assert.ok(!cells.has(key), `${where} 서는 자리 (${col},${row}) 가 겹친다`);
        cells.add(key);
        assert.ok(["up", "down", "left", "right"].includes(sp.face), `${where} 방향 ${sp.face}`);
      }

      // 문에서 시작 지점 앞과 모든 서는 자리에 닿는다 — 가정하지 않고 훑는다
      const doorRow = room.side === "north" ? rows - 1 : 0;
      const reached = new Set<number>();
      const frontier: number[] = [];
      for (const c of roomDoorCols(room)) if (at(c, doorRow) === EMPTY) { reached.add(doorRow * cols + c); frontier.push(doorRow * cols + c); }
      assert.ok(frontier.length > 0, `${where} 문 앞이 막혔다`);
      while (frontier.length) {
        const cur = frontier.shift() as number;
        const cc = cur % cols;
        const rr = (cur - cc) / cols;
        for (const [a, b] of [[cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]]) {
          if (!inside(a, b) || at(a, b) !== EMPTY) continue;
          const n = b * cols + a;
          if (!reached.has(n)) { reached.add(n); frontier.push(n); }
        }
      }
      assert.ok(reached.has(stand.row * cols + stand.col), `${where} 문에서 시작 지점에 닿지 않는다`);
      for (const sp of layout.standing) {
        const { col, row } = cellOf(sp.x, sp.y);
        assert.ok(reached.has(row * cols + col), `${where} 문에서 서는 자리 (${col},${row}) 에 닿지 않는다`);
      }

      // 벽걸이 — 위쪽 벽에, 문·컷·솟는 소품 위가 아닌 칸에, 서로 겹치지 않게
      const hung = new Set<number>();
      for (const d of layout.decor) {
        const f = footprintOf(d.kind);
        assert.ok(f.wall, `${where} ${d.kind} 은 벽걸이가 아니다`);
        assert.equal(d.z, decorZOf(room.y + WALL), `${where} 벽걸이 ${d.kind} 의 깊이가 앞면 줄의 것이 아니다`);
        assert.equal(d.y + d.h, room.y + WALL + FACE, `${where} 벽걸이 ${d.kind} 의 아래가 앞면 아래선이 아니다`);
        const c0 = (d.x - originX) / TILE;
        assert.ok(Number.isInteger(c0) && c0 >= 0 && c0 + f.w <= cols, `${where} 벽걸이 ${d.kind} 가 벽 밖이다`);
        for (let dc = 0; dc < f.w; dc += 1) {
          const c = c0 + dc;
          assert.ok(!hung.has(c), `${where} 벽걸이가 (${c}) 에서 겹친다`);
          hung.add(c);
          assert.notEqual(at(c, 0), SOLID, `${where} 벽걸이 ${d.kind} 가 컷 위에 걸렸다`);
          if (room.side === "south") assert.ok(!roomDoorCols(room).includes(c), `${where} 벽걸이 ${d.kind} 가 문 위에 걸렸다`);
          const under = layout.props.find((p) => {
            const pc = cellOf(p.x, p.y);
            return pc.row === 0 && c >= pc.col && c < pc.col + footprintOf(p.kind).w && footprintOf(p.kind).rise > 0;
          });
          assert.ok(!under, `${where} 벽걸이 ${d.kind} 아래에 솟는 소품 ${under?.kind} 이 있다`);
        }
      }
      // 장면의 벽걸이는 (자리가 있는 한) 다 걸린다
      assert.equal(layout.decor.length, SCENES[room.scene].decor.length, `${where} 벽걸이가 빠졌다`);

      // 벽 — 고리 칸(문 빼고)은 윗면, 앞면 줄은 앞면(컷 위는 윗면, 남쪽 방 문 아래는 뚫림), 컷 칸은 아래가 바닥이면 앞면 아니면 윗면
      const wallAt = new Map(layout.walls.map((w) => [`${(w.x - room.x) / TILE},${(w.y - room.y) / TILE}`, w] as const));
      assert.equal(wallAt.size, layout.walls.length, `${where} 벽 칸이 겹친다`);
      const [d0, d1] = roomDoorCols(room);
      const north = room.side === "north";
      const floorCell = (c: number, r: number) => inside(c, r) && at(c, r) !== SOLID;
      for (let R = 0; R < rows + 3; R += 1) for (let C = 0; C < cols + 2; C += 1) {
        const c = C - 1, r = R - 2;
        const doorCol = c === d0 || c === d1;
        let want: "top" | "face" | undefined;
        if (R === 0) want = !north && doorCol ? undefined : "top";
        else if (R === rows + 2) want = north && doorCol ? undefined : "top";
        else if (C === 0 || C === cols + 1) want = "top";
        else if (R === 1) want = !north && doorCol ? undefined : inside(c, 0) && at(c, 0) === SOLID ? "top" : "face";
        else want = inside(c, r) && at(c, r) === SOLID ? (floorCell(c, r + 1) ? "face" : "top") : undefined;
        assert.equal(wallAt.get(`${C},${R}`)?.kind, want, `${where} 벽 칸 (${C},${R}) 이 ${want ?? "없어야"} 하는데 ${wallAt.get(`${C},${R}`)?.kind ?? "없다"}`);
      }
      for (const w of layout.walls) {
        const C = (w.x - room.x) / TILE, R = (w.y - room.y) / TILE;
        assert.ok(Number.isInteger(C) && Number.isInteger(R) && w.w === TILE && w.h === TILE, `${where} 벽 칸이 격자에 맞지 않는다`);
        if (w.kind === "top") {
          const has = (dx: number, dy: number) => wallAt.get(`${C + dx},${R + dy}`)?.kind === "top";
          const mask = (has(0, -1) ? 1 : 0) | (has(1, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(1, 1) ? 8 : 0) | (has(0, 1) ? 16 : 0) | (has(-1, 1) ? 32 : 0) | (has(-1, 0) ? 64 : 0) | (has(-1, -1) ? 128 : 0);
          assert.equal(w.variant, WALL_TOP_VARIANT[mask], `${where} 윗면 (${C},${R}) 변형`);
        } else {
          const has = (dx: number, dy: number) => wallAt.get(`${C + dx},${R + dy}`)?.kind === "face";
          assert.equal(w.variant, WALL_FACE_VARIANT[(has(-1, 0) ? 1 : 0) | (has(0, -1) ? 2 : 0) | (has(1, 0) ? 4 : 0) | (has(0, 1) ? 8 : 0)], `${where} 앞면 (${C},${R}) 변형`);
        }
      }
      // 문 통로는 고리 칸 + 앞면 칸, 두 칸 높이
      const gap = doorGapOf(room);
      assert.equal(gap.h, WALL + FACE, `${where} 문 통로 높이`);
      assert.equal(gap.w, 2 * TILE);

      assert.equal(stable(layout), stable(layoutRoom(room, count)), `${where} 결정론`);
    }
  }
});

test("scenes: 장면 정의가 제 크기 안에 있고 소품·컷·시작 지점·자리가 겹치지 않는다", () => {
  let shaped = 0;
  for (const id of SCENE_IDS) {
    const sc = SCENES[id];
    assert.ok(sc.cols >= 6 && sc.cols <= MAX_COLS && sc.rows >= 5 && sc.rows <= MAX_ROWS, `${id}: 크기 ${sc.cols}×${sc.rows} 가 허용 범위 밖이다`);
    const used = new Set<string>();
    const mark = (c: number, r: number, what: string) => {
      assert.ok(c >= 0 && c < sc.cols && r >= 0 && r < sc.rows, `${id}: ${what} (${c},${r}) 가 ${sc.cols}×${sc.rows} 밖이다`);
      const k = `${c},${r}`;
      assert.ok(!used.has(k), `${id}: ${what} 이 (${c},${r}) 에서 다른 것과 겹친다`);
      used.add(k);
    };
    for (const cut of sc.cuts ?? []) {
      assert.ok(cut.w >= 1 && cut.h >= 1, `${id}: 빈 컷`);
      for (let dr = 0; dr < cut.h; dr += 1) for (let dc = 0; dc < cut.w; dc += 1) mark(cut.c + dc, cut.r + dr, "컷");
      shaped += 1;
    }
    for (const p of sc.props) {
      const size = footprintOf(p.kind);
      assert.ok(!size.wall, `${id}: ${p.kind} 은 벽걸이다`);
      if (WALKABLE_PROPS.has(p.kind)) continue;
      for (let dr = 0; dr < size.h; dr += 1) for (let dc = 0; dc < size.w; dc += 1) mark(p.c + dc, p.r + dr, p.kind);
    }
    mark(sc.start.c, sc.start.r, "start");
    mark(sc.start.c + 1, sc.start.r, "start");
    // 시작 지점 앞 줄이 방 안에 있고, 그 두 칸은 문 칸이 아니다
    assert.ok(sc.start.r <= sc.rows - 2, `${id}: 시작 지점이 마지막 줄이다 — 앞에 설 곳이 없다`);
    for (const c of [sc.start.c, sc.start.c + 1]) {
      assert.ok(!doorCols(sc.cols).includes(c) || sc.start.r + 1 !== sc.rows - 1, `${id}: 시작 지점 앞 (${c},${sc.start.r + 1}) 이 문 칸이다`);
    }
    for (const sp of sc.spots) mark(sp.c, sp.r, "spot");
    for (const d of sc.decor) {
      const f = footprintOf(d.kind);
      assert.ok(f.wall, `${id}: ${d.kind} 은 벽걸이가 아니다`);
      assert.ok(d.c >= 0 && d.c + f.w <= sc.cols, `${id}: 벽걸이 ${d.kind} 가 벽 밖이다`);
    }
    assert.ok(sc.spots.length >= 4, `${id}: 서는 자리가 ${sc.spots.length}개뿐이다`);
    // 문 앞 두 칸은 비어 있어야 들어온다
    const [d0, d1] = doorCols(sc.cols);
    for (const c of [d0, d1]) assert.ok(!used.has(`${c},${sc.rows - 1}`), `${id}: 문 앞 (${c},${sc.rows - 1}) 이 막혔다`);
  }
  assert.ok(shaped >= 5, `모양이 다른(컷이 있는) 장면이 ${shaped}개뿐이다 — 크기만 다르면 방이 다 같은 상자로 보인다`);
});

/** 관리자가 만드는 장면의 모양 — 문이 왼쪽, 칸마다 다른 바닥, 벽은 1×1 컷의 모음 */
const CUSTOM: SceneSpec = {
  id: "custom-1",
  label: "내 방",
  cols: 8,
  rows: 6,
  floor: "oak",
  door: 0,
  tiles: [{ c: 0, r: 5, floor: "mat" }, { c: 1, r: 5, floor: "mat" }, { c: 3, r: 2, floor: "walnut" }, { c: 4, r: 2, floor: "walnut" }, { c: 4, r: 3, floor: "oak" }],
  cuts: [{ c: 7, r: 0, w: 1, h: 1 }, { c: 6, r: 0, w: 1, h: 1 }, { c: 7, r: 1, w: 1, h: 1 }],
  props: [{ kind: "sofa-blue", c: 0, r: 0 }, { kind: "plant-small-1", c: 3, r: 0 }, { kind: "cooler-1", c: 5, r: 0 }],
  decor: [{ kind: "clock-blue", c: 4 }],
  spots: [{ c: 1, r: 2, face: "right" }, { c: 3, r: 3, face: "left" }],
  start: { c: 5, r: 3 },
};

test("custom scene: 관리자 장면이 문 위치·칸별 바닥·컷과 함께 층에 깔린다 (남/북 × 거울)", () => {
  assert.deepEqual(validateScene(CUSTOM).filter((p) => p.level === "error"), [], "검증기가 오류를 낸다");
  const floor = buildFloor([
    { slug: "a", label: "A", accent: "#fff", category: "dev", scene: CUSTOM },
    { slug: "b", label: "B", accent: "#fff", category: "dev", scene: CUSTOM },
    { slug: "c", label: "C", accent: "#fff", category: "dev" },
    { slug: "d", label: "D", accent: "#fff", category: "dev", scene: CUSTOM },
  ]);
  const [a, b, c, d] = floor.rooms;
  assert.equal(a.scene, "custom-1");
  assert.equal(a.spec, CUSTOM);
  assert.equal(c.scene, "whiteboard", "장면이 정해지지 않은 방은 분야에서 고른다");
  assert.equal(a.mirror, false);
  assert.equal(b.mirror, true, "같은 관리자 장면이 두 번이면 거울");
  assert.equal(d.mirror, false);
  assert.equal(a.doorC, 0, "문이 왼쪽");
  assert.equal(b.doorC, 6, "거울 방은 문이 오른쪽");
  for (const room of [a, b, d]) {
    for (const count of [0, 2, 5]) {
      const L = layoutRoom(room, count);
      const where = `${room.id}/${room.side}${room.mirror ? "/거울" : ""}/${count}`;
      // 컷 세 칸이 벽이다
      assert.equal([...L.grid].filter((v) => v === 1).length, 3, `${where} 컷 칸 수`);
      // 바닥 줄: 바닥 칸마다 정확히 한 사각형이 그 칸 가운데를 덮고, 컷 칸은 아무것도 덮지 않는다. 벽 쪽으로는 벽 선까지(반 칸) 나간다.
      const inner = { x: room.x + WALL, y: room.y + WALL + FACE };
      for (let r = 0; r < room.rows; r += 1) for (let c = 0; c < room.cols; c += 1) {
        const cx = inner.x + c * TILE + TILE / 2, cy = inner.y + r * TILE + TILE / 2;
        // 벽 선(칸 한가운데)까지 나간 이웃 바닥이 컷 칸의 가운데 점에 정확히 닿으므로 경계는 뺀다
        const covering = L.floors.filter((f) => cx > f.x && cx < f.x + f.w && cy > f.y && cy < f.y + f.h);
        assert.equal(covering.length, L.grid[r * room.cols + c] === 1 ? 0 : 1, `${where} 칸 (${c},${r}) 을 바닥 ${covering.length}개가 덮는다`);
      }
      for (const f of L.floors) {
        assert.ok(f.x >= inner.x && f.x + f.w <= inner.x + room.cols * TILE, `${where} 바닥이 방 밖이다`);
        assert.ok(f.y >= inner.y && f.y + f.h <= inner.y + room.rows * TILE, `${where} 바닥이 방 밖이다`);
      }
      // 덮어쓰기: 기본과 같은 oak 는 사라지고, 같은 줄의 walnut 둘과 매트 둘은 각각 한 사각형
      const overrides = L.floors.filter((f) => f.floor !== "oak");
      assert.deepEqual(overrides.map((f) => f.floor).sort(), ["mat", "walnut"], `${where} 덮어쓴 바닥: ${JSON.stringify(overrides.map((f) => f.floor))}`);
      const mats = overrides.find((f) => f.floor === "mat");
      assert.ok(mats && mats.w >= 2 * TILE, `${where} 매트 두 칸이 한 사각형이 아니다`);
      // 문 칸은 벽이 아니고 걸을 수 있다
      const doorRow = room.side === "north" ? room.rows - 1 : 0;
      for (const dc of roomDoorCols(room)) assert.equal(L.grid[doorRow * room.cols + dc], 0, `${where} 문 칸 (${dc},${doorRow}) 이 막혔다`);
      // 벽 조각이 문 칸을 덮지 않는다
      const doorY = room.side === "north" ? room.y + room.h - WALL : room.y;
      const doorX = room.x + WALL + room.doorC * TILE;
      for (const w of L.walls) {
        const covers = w.x < doorX + 2 * TILE && w.x + w.w > doorX && w.y < doorY + WALL + (room.side === "south" ? FACE : 0) && w.y + w.h > doorY;
        assert.ok(!covers, `${where} 벽이 문 칸을 덮는다`);
      }
      assert.equal(L.decor.length, 1, `${where} 시계가 빠졌다`);
      assert.ok(L.standing.length >= count, `${where} 서는 자리 부족`);
    }
  }
  // 층에서 두 방이 걸어서 닿는다 — 문이 복도에 열려 있다
  const layouts = new Map(floor.rooms.map((r) => [r.id, layoutRoom(r, 2)]));
  const rects = walkableRects(floor, layouts);
  for (const room of floor.rooms) {
    const gapX = room.x + WALL + room.doorC * TILE + TILE;
    const gapY = room.side === "north" ? room.y + room.h - WALL / 2 : room.y + WALL / 2;
    assert.ok(canStand(gapX, gapY, rects, 14, floor.blocked), `${room.id} 문 칸에 설 수 없다`);
  }
});

/** 검증기의 오류 코드를 시험하는 작은 방 — 아래 좌표는 이 방에 맞춰 적었다. 기본 장면을 다시 꾸며도(2026-09-14 넓이 두 배)
 *  이 시험이 흔들리지 않게 옛 휴게실(8×6)을 따로 둔다. */
const SMALL: SceneSpec = {
  id: "small",
  label: "작은 방",
  cols: 8,
  rows: 6,
  floor: "slate",
  props: [
    { kind: "vending-drink-1", c: 0, r: 0 },
    { kind: "vending-drink-2", c: 1, r: 0 },
    { kind: "coffee-cart", c: 2, r: 0 },
    { kind: "cooler-1", c: 7, r: 0 },
    { kind: "table-glass-plant", c: 3, r: 2 },
    { kind: "bin-gray", c: 7, r: 4 },
    { kind: "plant-small-1", c: 0, r: 4 },
  ],
  decor: [{ kind: "clock-blue", c: 5 }],
  spots: [
    { c: 2, r: 3, face: "right" },
    { c: 5, r: 3, face: "left" },
    { c: 3, r: 4, face: "up" },
    { c: 1, r: 2, face: "up" },
    { c: 4, r: 4, face: "up" },
    { c: 6, r: 1, face: "left" },
  ],
  start: { c: 5, r: 4 },
};

test("validateScene: 기본 장면은 깨끗하고, 망가진 장면은 무엇이 틀렸는지 말한다", () => {
  for (const id of SCENE_IDS) {
    const errors = validateScene(SCENES[id]).filter((p) => p.level === "error");
    assert.deepEqual(errors, [], `${id}: ${errors.map((e) => e.message).join(" / ")}`);
  }
  const codes = (spec: SceneSpec) => validateScene(spec).filter((p) => p.level === "error").map((p) => p.code);
  const base = SMALL;
  assert.deepEqual(validateScene(base).filter((p) => p.level === "error"), [], "작은 방 자체는 깨끗하다");
  assert.ok(codes({ ...base, cols: 3 }).includes("size"));
  assert.ok(codes({ ...base, door: 7 }).includes("door"));
  assert.ok(codes({ ...base, props: [...base.props, { kind: "plant-small-1", c: 0, r: 0 }] }).includes("overlap"));
  assert.ok(codes({ ...base, props: [...base.props, { kind: "plant-small-1", c: 3, r: 5 }] }).includes("prop-door"));
  assert.ok(codes({ ...base, start: { c: 0, r: 5 } }).includes("start-front"));
  assert.ok(codes({ ...base, start: { c: 7, r: 4 } }).includes("start-bounds"));
  assert.ok(codes({ ...base, spots: [{ c: 0, r: 0, face: "up" }] }).includes("spot-blocked"));
  assert.ok(codes({ ...base, cuts: [{ c: 3, r: 5, w: 1, h: 1 }] }).includes("cut-door"));
  // 벽으로 가둔 자리
  const walled = { ...base, cuts: [{ c: 6, r: 3, w: 2, h: 1 }, { c: 6, r: 5, w: 2, h: 1 }, { c: 6, r: 4, w: 1, h: 1 }], spots: [{ c: 7, r: 4, face: "up" as const }], start: { c: 3, r: 3 }, props: base.props.filter((p) => p.kind !== "bin-gray" && p.kind !== "table-glass-plant") };
  assert.ok(codes(walled).includes("spot-unreachable"), JSON.stringify(validateScene(walled)));
  assert.ok(codes({ ...base, props: [{ kind: "clock-blue", c: 0, r: 0 }] }).includes("prop-wall"));
  assert.ok(codes({ ...base, decor: [{ kind: "sofa-blue", c: 0 }] }).includes("decor-floor"));
  assert.ok(codes({ ...base, tiles: [{ c: 99, r: 0, floor: "oak" }] }).includes("tile-bounds"));
  // 경고: 걸 자리 없음
  const stuffed = { ...base, props: [{ kind: "vending-drink-1", c: 0, r: 0 }, { kind: "vending-drink-2", c: 1, r: 0 }, { kind: "vending-drink-1", c: 2, r: 0 }, { kind: "vending-drink-2", c: 3, r: 0 }, { kind: "vending-drink-1", c: 4, r: 0 }, { kind: "vending-drink-2", c: 5, r: 0 }, { kind: "vending-drink-1", c: 6, r: 0 }, { kind: "vending-drink-2", c: 7, r: 0 }], decor: [{ kind: "clock-blue", c: 3 }], start: { c: 2, r: 3 }, spots: [] };
  assert.ok(validateScene(stuffed).some((p) => p.code === "decor-no-room"));
});
