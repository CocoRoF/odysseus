/** 편집기 저장기 — 응시자의 편집이 조용히 사라지는 길이 없는가.
 *   node --test lib/ */
import assert from "node:assert/strict";
import test from "node:test";

import { classifySaveError, FileSaver, saveStatusText, type SaveFailure, type ServerFile } from "./autosave.ts";

/** 손으로 돌리는 타이머 — 시간이 흐르는 순서를 테스트가 정한다 */
function manualTimers() {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        seq += 1;
        queue.set(seq, { at: now + ms, fn });
        return seq;
      },
      clear: (handle: unknown) => void queue.delete(handle as number),
    },
    pending: () => [...queue.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      now += ms;
      for (const [id, t] of [...queue.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && queue.has(id)) {
          queue.delete(id);
          t.fn();
        }
      }
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Call {
  path: string;
  content: string;
  base: string | null;
  resolve: (sha: string) => void;
  reject: (err: unknown) => void;
}

/** 쓰기 요청을 붙잡아 두고 테스트가 응답 시점을 정한다 */
function harness(opts: { server?: Map<string, ServerFile> } = {}) {
  const clock = manualTimers();
  const calls: Call[] = [];
  const server = opts.server ?? new Map<string, ServerFile>();
  let inFlight = 0;
  let maxInFlight = 0;
  const saver = new FileSaver({
    timers: clock.timers,
    debounceMs: 2000,
    backoffMs: [2000, 4000],
    write: (path, content, base) =>
      new Promise((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push({
          path,
          content,
          base,
          resolve: (sha) => {
            inFlight -= 1;
            server.set(path, { content, sha256: sha });
            resolve({ sha256: sha });
          },
          reject: (err) => {
            inFlight -= 1;
            reject(err);
          },
        });
      }),
    read: async (path) => server.get(path) ?? null,
    classify: classifySaveError,
    onChange: () => undefined,
  });
  return { saver, calls, clock, server, maxInFlight: () => maxInFlight };
}

const offline = () => new TypeError("Failed to fetch");
const apiError = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });

test("저장 요청이 떠 있는 사이 친 글자는 '저장됨' 이 되지 않고 다음 쓰기로 간다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("app.py", "v0", "sha-v0");
  saver.edit("app.py", "v1");
  await clock.advance(2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, "v1");
  assert.equal(saver.status("app.py")?.kind, "saving");

  saver.edit("app.py", "v1 + 마지막 줄"); // 응답 전에 친다
  calls[0].resolve("sha-v1");
  await settle();

  assert.equal(saver.isDirty("app.py"), true, "응답이 온 뒤에도 마지막 줄은 아직 서버에 없다");
  assert.equal(saver.status("app.py")?.kind, "pending");
  assert.deepEqual(clock.pending(), [2000], "남은 편집의 자동 저장이 다시 예약된다");
  await clock.advance(2000);
  assert.equal(calls[1].content, "v1 + 마지막 줄");
  assert.equal(calls[1].base, "sha-v1");
});

test("flush 가 마지막 줄까지 쓰고, 두 번째 쓰기는 첫 번째가 받은 버전을 기준으로 삼는다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("app.py", "v0", "sha-v0");
  saver.edit("app.py", "v1");
  await clock.advance(2000);
  saver.edit("app.py", "v2");
  const flushed = saver.flush();
  await settle();
  assert.equal(calls.length, 1, "첫 쓰기가 끝나기 전에는 두 번째를 보내지 않는다");
  calls[0].resolve("sha-v1");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].content, "v2");
  assert.equal(calls[1].base, "sha-v1");
  calls[1].resolve("sha-v2");
  assert.deepEqual(await flushed, []);
  assert.equal(saver.isDirty("app.py"), false);
  assert.equal(saver.status("app.py")?.kind, "saved");
});

test("한 경로의 쓰기는 동시에 하나 — 겹친 요청은 최신 내용 한 번으로 합쳐진다", async () => {
  const { saver, calls, maxInFlight } = harness();
  saver.open("a.md", "0", "s0");
  saver.edit("a.md", "1");
  const first = saver.save("a.md");
  await settle();
  saver.edit("a.md", "2");
  const second = saver.save("a.md");
  saver.edit("a.md", "3");
  const third = saver.save("a.md");
  calls[0].resolve("s1");
  await settle();
  calls[1].resolve("s3");
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(maxInFlight(), 1);
  assert.deepEqual(
    calls.map((c) => c.content),
    ["1", "3"],
    "줄 선 쓰기는 실행되는 순간의 최신 내용을 쓰고, 이미 쓴 내용은 다시 보내지 않는다",
  );
});

test("서버가 밖에서 바뀌었으면 덮지 않고 멈춘다 — 응시자가 고를 때까지", async () => {
  const { saver, calls, clock } = harness();
  saver.open("report.py", "mine-0", "sha-0");
  saver.edit("report.py", "mine-1");
  await clock.advance(2000);
  calls[0].reject(apiError(409, "다른 곳에서 이 파일이 바뀌었습니다", "FILE_CHANGED"));
  await settle();
  assert.deepEqual(saver.status("report.py"), { kind: "conflict", deleted: false });

  saver.edit("report.py", "mine-2");
  await clock.advance(10_000);
  assert.equal(calls.length, 1, "충돌 중에는 편집해도 자동 저장이 나가지 않는다");
  assert.deepEqual(await saver.flush(), ["report.py"], "제출 전 저장도 충돌 파일을 저장됐다고 하지 않는다");

  const kept = saver.keepMine("report.py");
  await settle();
  assert.equal(calls[1].base, null, "덮어쓰기는 응시자가 고른 경우에만, 기준 없이");
  assert.equal(calls[1].content, "mine-2");
  calls[1].resolve("sha-mine-2");
  assert.equal(await kept, true);
  assert.equal(saver.status("report.py")?.kind, "saved");
});

test("충돌에서 '바뀐 내용 불러오기' 는 편집을 버리고 새 기준으로 다시 시작한다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("x.py", "old", "sha-old");
  saver.edit("x.py", "mine");
  saver.noteServerVersion("x.py", "sha-agent");
  assert.deepEqual(saver.status("x.py"), { kind: "conflict", deleted: false });
  saver.open("x.py", "agent", "sha-agent");
  assert.equal(saver.isDirty("x.py"), false);
  saver.edit("x.py", "agent + 내 수정");
  await clock.advance(2000);
  assert.equal(calls.at(-1)?.base, "sha-agent");
});

test("파일 목록의 새 버전: 편집하지 않았으면 다시 읽고, 편집 중이면 충돌, 내가 쓴 버전이면 그대로", async () => {
  const { saver, calls, clock } = harness();
  saver.open("clean.py", "a", "sha-a");
  assert.equal(saver.noteServerVersion("clean.py", "sha-a"), "same");
  assert.equal(saver.noteServerVersion("clean.py", "sha-agent"), "reload");

  saver.open("mine.py", "a", "sha-a");
  saver.edit("mine.py", "b");
  await clock.advance(2000);
  assert.equal(saver.noteServerVersion("mine.py", "sha-b"), "same", "쓰는 중에는 판단하지 않는다");
  calls[0].resolve("sha-b");
  await settle();
  assert.equal(saver.noteServerVersion("mine.py", "sha-a"), "same", "뒤늦게 온 옛 목록은 밖의 변경이 아니다");
  assert.equal(saver.noteServerVersion("mine.py", "sha-b"), "same");

  saver.edit("mine.py", "c");
  assert.equal(saver.noteServerVersion("mine.py", "sha-agent"), "conflict");
  await clock.advance(5000);
  assert.equal(calls.length, 1, "충돌로 판단한 뒤에는 예약된 자동 저장도 나가지 않는다");
});

test("연결이 끊기면 간격을 늘려 다시 시도하고, 응답을 못 받은 쓰기가 실제로 들어갔으면 충돌로 보지 않는다", async () => {
  const { saver, calls, clock, server } = harness();
  server.set("notes.md", { content: "v0", sha256: "sha-v0" });
  saver.open("notes.md", "v0", "sha-v0");
  saver.edit("notes.md", "v1");
  await clock.advance(2000);
  // 서버는 v1 을 받았지만 응답이 오기 전에 연결이 끊겼다
  server.set("notes.md", { content: "v1", sha256: "sha-v1" });
  calls[0].reject(offline());
  await settle();
  assert.deepEqual(saver.status("notes.md"), { kind: "retrying", attempt: 1 });
  assert.equal(saveStatusText(saver.status("notes.md")), "저장 실패 — 연결되면 다시 저장합니다");
  assert.deepEqual(clock.pending(), [2000]);

  saver.edit("notes.md", "v2"); // 끊긴 동안에도 계속 쓴다
  assert.deepEqual(clock.pending(), [2000], "타이핑이 재시도를 앞당기지 않는다");
  await clock.advance(2000);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].content, "v2");
  assert.equal(calls[1].base, "sha-v1", "서버가 이미 가진 v1 을 기준으로 삼는다 — 가짜 충돌이 나지 않는다");
  calls[1].resolve("sha-v2");
  await settle();
  assert.equal(saver.status("notes.md")?.kind, "saved");
});

test("재시도가 거듭 실패하면 간격이 늘어나고, 제출 전 저장은 기다리지 않고 바로 시도한다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("a.py", "0", "s0");
  saver.edit("a.py", "1");
  await clock.advance(2000);
  calls[0].reject(offline());
  await settle();
  await clock.advance(2000);
  calls[1].reject(apiError(502, "Bad Gateway"));
  await settle();
  assert.deepEqual(saver.status("a.py"), { kind: "retrying", attempt: 2 });
  assert.deepEqual(clock.pending(), [4000]);
  const flushed = saver.flush();
  await settle();
  assert.equal(calls.length, 3, "flush 는 예약을 기다리지 않는다");
  calls[2].resolve("s1");
  assert.deepEqual(await flushed, []);
});

test("다시 해도 안 되는 실패는 이유를 보여 주고 재시도로 두드리지 않는다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("big.csv", "x", "s");
  saver.edit("big.csv", "y");
  await clock.advance(2000);
  calls[0].reject(apiError(400, "이미 종료된 시험입니다"));
  await settle();
  assert.deepEqual(saver.status("big.csv"), { kind: "blocked", message: "이미 종료된 시험입니다" });
  assert.equal(saveStatusText(saver.status("big.csv")), "저장할 수 없음 — 이미 종료된 시험입니다");
  assert.deepEqual(clock.pending(), []);
  const flushed = saver.flush();
  await settle();
  calls[1].reject(apiError(400, "이미 종료된 시험입니다"));
  assert.deepEqual(await flushed, ["big.csv"], "제출 전 저장은 한 번 더 시도하고, 안 되면 이름을 돌려준다");
});

test("창을 닫아도 남은 편집은 끝까지 저장하고, 끝내 못 한 것만 알린다", async () => {
  const { saver, calls, clock } = harness();
  saver.open("ok.md", "0", "s0");
  saver.open("clash.md", "0", "t0");
  saver.edit("ok.md", "1");
  saver.edit("clash.md", "1");
  let result: string[] | null = null;
  saver.retire((unsaved) => {
    result = unsaved;
  });
  await settle();
  calls.find((c) => c.path === "clash.md")!.reject(apiError(409, "바뀜", "FILE_CHANGED"));
  calls.find((c) => c.path === "ok.md")!.reject(offline());
  await settle();
  assert.equal(result, null, "재시도가 남아 있으면 아직 포기하지 않는다");
  await clock.advance(2000);
  calls.at(-1)!.resolve("s1");
  await settle();
  assert.deepEqual(result, ["clash.md"]);
});

test("저장 실패의 분류 — 응답이 없거나 5xx·429 면 재시도, 충돌 코드면 충돌, 나머지는 멈춤", () => {
  const cases: [unknown, SaveFailure][] = [
    [offline(), { kind: "retryable" }],
    [apiError(503, "Service Unavailable"), { kind: "retryable" }],
    [apiError(429, "요청이 너무 잦습니다"), { kind: "retryable" }],
    [apiError(409, "다른 곳에서 이 파일이 삭제되었습니다", "FILE_DELETED"), { kind: "conflict", deleted: true }],
    [apiError(409, "파일 수 한도(200)에 도달했습니다"), { kind: "blocked", message: "파일 수 한도(200)에 도달했습니다" }],
    [apiError(423, "이미 제출한 문제입니다"), { kind: "blocked", message: "이미 제출한 문제입니다" }],
  ];
  for (const [err, expected] of cases) assert.deepEqual(classifySaveError(err), expected);
});
