/** 연결 판단 — 서버에 닿지 못하면 네트워크가 멀쩡해도 알리고, 앱의 정상 오류로는 알리지 않는다.
 *   node --test lib/ */
import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionMonitor, isGatewayStatus, onApiSignal, reportApiFailure, type Connection } from "./reachability.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(results: boolean[]) {
  const changes: [Connection, Connection][] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let probes = 0;
  const monitor = new ConnectionMonitor({
    probe: async () => {
      probes += 1;
      return results.shift() ?? true;
    },
    onChange: (state, previous) => changes.push([state, previous]),
    timers: {
      set: (fn, ms) => timers.push({ at: ms, fn }),
      clear: () => undefined,
    },
    backoffMs: [2000, 4000],
  });
  const fire = async () => {
    const t = timers.shift();
    t?.fn();
    await settle();
    return t?.at;
  };
  return { monitor, changes, timers, fire, probes: () => probes };
}

test("서버가 멈추면 브라우저가 온라인이어도 끊김으로 알리고, 닿는 순간 복구를 알린다", async () => {
  const { monitor, changes, fire, probes } = setup([false, false, true]);
  monitor.apiSignal("failure"); // 저장 요청이 응답 없이 실패
  await settle();
  assert.deepEqual(changes, [["unreachable", "online"]]);
  assert.equal(await fire(), 2000);
  assert.equal(await fire(), 4000, "확인 간격이 늘어난다");
  assert.equal(probes(), 3);
  assert.deepEqual(changes.at(-1), ["online", "unreachable"]);
});

test("앱이 낸 오류(설정 없음 503 등)는 health 확인이 통과하면 알리지 않는다", async () => {
  const { monitor, changes } = setup([true]);
  monitor.apiSignal("failure");
  await settle();
  assert.deepEqual(changes, []);
});

test("확인이 도는 동안 실패 신호가 몰려도 확인은 한 번만 나간다", async () => {
  const { monitor, probes } = setup([true]);
  for (let i = 0; i < 5; i += 1) monitor.apiSignal("failure");
  await settle();
  assert.equal(probes(), 1);
});

test("브라우저가 오프라인이면 바로 알리고, 온라인 이벤트 뒤에는 서버를 확인해서 정한다", async () => {
  const { monitor, changes, fire } = setup([false, true]);
  monitor.browserOffline();
  assert.deepEqual(changes, [["offline", "online"]]);
  monitor.apiSignal("failure"); // 오프라인 동안의 실패는 확인하지 않는다
  await settle();
  monitor.browserOnline(); // 네트워크는 돌아왔지만 서버는 아직
  await settle();
  assert.deepEqual(changes.at(-1), ["unreachable", "offline"]);
  await fire();
  assert.deepEqual(changes.at(-1), ["online", "unreachable"]);
});

test("끊김 중에 다른 요청이 응답을 받으면 바로 복구로 본다", async () => {
  const { monitor, changes } = setup([false]);
  monitor.apiSignal("failure");
  await settle();
  monitor.apiSignal("success");
  assert.deepEqual(changes, [["unreachable", "online"], ["online", "unreachable"]]);
});

test("게이트웨이 상태 코드와 신호 전달", () => {
  assert.equal(isGatewayStatus(502), true);
  assert.equal(isGatewayStatus(504), true);
  assert.equal(isGatewayStatus(500), false, "앱이 낸 500 은 서버가 응답한 것이다");
  assert.equal(isGatewayStatus(429), false);
  const seen: string[] = [];
  const off = onApiSignal((s) => seen.push(s));
  reportApiFailure();
  off();
  reportApiFailure();
  assert.deepEqual(seen, ["failure"]);
});
