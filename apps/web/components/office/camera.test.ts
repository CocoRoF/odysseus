/** 사무실 카메라 셈 — 확대가 커서 밑을 붙잡는가, 층 밖을 비추지 않는가, 옮기기가 끝점에서 정확히 멈추는가.
 *   node --test components/office/ */
import assert from "node:assert/strict";
import test from "node:test";
import { clampAxis, clampFocus, coastFocus, focusKeeping, focusRange, rubberBand, rubberFocus, snapScale, tweenAt, worldAt, type Cam, type Tween } from "./camera.ts";

const view = { w: 1200, h: 700 };
const world = { width: 4000, height: 1800 };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("snapScale: 한 칸이 기기 픽셀 정수가 되게 내림하고 0 이 되지 않는다", () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const unit = 48 * dpr;
    for (const raw of [0.31, 0.4375, 0.8, 1, 1.37, 2.49]) {
      const s = snapScale(raw, unit);
      assert.ok(s <= raw + 1e-9, "올림하면 층이 화면을 넘는다");
      assert.ok(Number.isInteger(Math.round(s * unit * 1e6) / 1e6), `${raw}·${dpr}: 한 칸 ${s * unit}px`);
    }
    assert.ok(snapScale(0, unit) > 0);
  }
  assert.equal(snapScale(0.5, 48), 0.5, "이미 정수면 그대로(부동소수 오차로 한 칸 내려가지 않는다)");
});

test("clampFocus: 층이 화면보다 넓으면 가장자리까지만, 좁으면 층이 화면 안에 남는 범위에서", () => {
  // 보이는 폭 1000 > 층 800 — 초점은 [300, 500] 안에서 움직인다(층 왼쪽 끝이 화면 왼쪽 끝, 오른쪽 끝이 오른쪽 끝까지)
  assert.equal(clampAxis(10, 500, 800), 300);
  assert.equal(clampAxis(400, 500, 800), 400, "가운데는 그대로");
  assert.equal(clampAxis(9999, 500, 800), 500);
  assert.equal(clampAxis(10, 300, 800), 300);
  assert.equal(clampAxis(790, 300, 800), 500);
  const c = clampFocus(-100, 99999, 1, view, world);
  assert.deepEqual(c, { fx: 600, fy: 1450 });
});

test("worldAt/focusKeeping: 배율을 바꿔도 붙잡은 화면 점 밑의 월드 점이 그대로다", () => {
  const cam: Cam = { s: 0.75, fx: 1800, fy: 900 };
  const sx = 930, sy = 210;
  const w = worldAt(cam, view, sx, sy);
  for (const s of [0.5, 1, 1.9]) {
    const f = focusKeeping(w.x, w.y, sx, sy, s, view);
    const back = worldAt({ s, ...f }, view, sx, sy);
    assert.ok(near(back.x, w.x) && near(back.y, w.y), `배율 ${s}: 커서 밑 점이 (${back.x},${back.y}) 로 밀렸다`);
  }
});

test("tweenAt: 끝점에서 정확히 멈추고, 배율은 두 끝 사이를 넘지 않으며, anchor 는 도중에도 커서 밑을 붙잡는다", () => {
  const from: Cam = { s: 0.5, fx: 2000, fy: 900 };
  const sx = 300, sy = 500;
  const w = worldAt(from, view, sx, sy);
  const s1 = 1;
  const f1 = focusKeeping(w.x, w.y, sx, sy, s1, view);
  const tw: Tween = { from, to: { s: s1, ...f1 }, t0: 1000, dur: 200, kind: "anchor", anchor: { sx, sy, wx: w.x, wy: w.y } };
  let prevS = from.s;
  for (let t = 1000; t <= 1200; t += 10) {
    const { cam, done } = tweenAt(tw, t, view);
    assert.ok(cam.s >= prevS - 1e-12 && cam.s <= s1 + 1e-12, "배율이 되돌아가거나 넘친다");
    prevS = cam.s;
    const under = worldAt(cam, view, sx, sy);
    assert.ok(near(under.x, w.x, 1e-6) && near(under.y, w.y, 1e-6), `t=${t}: 커서 밑이 흔들렸다`);
    if (t === 1200) assert.ok(done && cam.s === s1 && cam.fx === f1.fx && cam.fy === f1.fy, "끝에서 목표와 정확히 같아야 한다");
  }
  // 가두기 때문에 목표 초점이 커서 기준과 다를 때 — 끝에서는 목표로 간다
  const tw2: Tween = { ...tw, to: { s: s1, fx: 600, fy: 350 } };
  const end = tweenAt(tw2, 1200, view).cam;
  assert.deepEqual(end, { s: s1, fx: 600, fy: 350 });
  // glide: 시작은 출발점, 끝은 목표, 도중 배율은 로그 공간(가운데에서 기하평균)
  const g: Tween = { from: { s: 0.5, fx: 0, fy: 0 }, to: { s: 2, fx: 100, fy: 50 }, t0: 0, dur: 100, kind: "glide" };
  assert.deepEqual(tweenAt(g, 0, view).cam, { s: 0.5, fx: 0, fy: 0 });
  assert.ok(near(tweenAt(g, 50, view).cam.s, 1, 1e-9), "가운데 배율은 0.5 와 2 의 기하평균(1)");
  assert.ok(tweenAt(g, 100, view).done);
  assert.ok(tweenAt({ ...g, dur: 0 }, 0, view).done, "길이 0 은 곧장 끝(움직임 줄이기 설정)");
});

test("coast: 빠르게 놓으면 그 방향으로 더 미끄러지고, 멈췄다 놓으면 그대로이며, 빨리 출발해 서서히 멈춘다", () => {
  assert.equal(coastFocus(100, 100, 0.0001, 0, 1), null, "거의 멈춘 손");
  const c = coastFocus(100, 100, -0.5, 0.25, 0.5, 200);
  assert.deepEqual(c, { fx: 0, fy: 150 }, "화면 이동 56px — 상한 아래라 그대로");
  // 세게 튕기면(화면 2px/ms × 160ms = 320px) 상한 220px 로 줄인다
  const hard = coastFocus(0, 0, 4, 0, 0.5) as { fx: number; fy: number };
  assert.ok(Math.abs(hard.fx * 0.5 - 220) < 1e-9, `화면 ${hard.fx * 0.5}px 미끄러졌다`);
  const tw: Tween = { from: { s: 1, fx: 0, fy: 0 }, to: { s: 1, fx: 100, fy: 0 }, t0: 0, dur: 100, kind: "coast" };
  const early = tweenAt(tw, 25, view).cam.fx, late = tweenAt(tw, 75, view).cam.fx;
  assert.ok(early > 25 && late - early < early, `처음 1/4 에 ${early} — 빠르게 출발해야 한다`);
});

test("rubberBand: 범위 안은 그대로, 밖으로 끌수록 버티며 dim 을 넘지 않는다", () => {
  assert.equal(rubberBand(50, 0, 100, 40), 50);
  const a = rubberBand(120, 0, 100, 40), b = rubberBand(200, 0, 100, 40), c = rubberBand(1e6, 0, 100, 40);
  assert.ok(a > 100 && a < 120, `조금 넘기면 조금만 따라온다 (${a})`);
  assert.ok(b > a && b - 100 < 100, "더 끌면 더 가지만 끈 만큼은 아니다");
  assert.ok(c < 140 + 1e-9, "아무리 끌어도 dim 을 넘지 않는다");
  assert.ok(rubberBand(-20, 0, 100, 40) < 0 && rubberBand(-20, 0, 100, 40) > -20);
  assert.deepEqual(focusRange(500, 800), [300, 500]);
  assert.deepEqual(focusRange(300, 800), [300, 500]);
  const r = rubberFocus(600, 350, 1, view, world);
  assert.deepEqual(r, { fx: 600, fy: 350 }, "범위 안 초점은 그대로");
});

test("작은 층(화면보다 좁음)에서도 확대가 커서 밑을 붙잡는다 — 층이 화면 안에 남는 한", () => {
  const small = { width: 900, height: 500 };
  const v = { w: 1600, h: 800 };
  const cam: Cam = { s: 0.6, fx: 450, fy: 250 };
  const sx = 420, sy = 300;
  const w = worldAt(cam, v, sx, sy);
  const s1 = 1.05; // 층 945px < 화면 1600px — 여전히 좁다
  const keep = focusKeeping(w.x, w.y, sx, sy, s1, v);
  const c = clampFocus(keep.fx, keep.fy, s1, v, small);
  const back = worldAt({ s: s1, ...c }, v, sx, sy);
  assert.ok(near(back.x, w.x, 1e-6) && near(back.y, w.y, 1e-6), `커서 밑이 (${(back.x - w.x).toFixed(1)}, ${(back.y - w.y).toFixed(1)}) 밀렸다`);
});
