import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError, isReadOnly, resetIdentityState, setReadOnly } from "./api.ts";

/** 서버에 실제로 나간 요청을 기록하는 가짜 fetch */
function stubFetch(status = 200, body: unknown = {}) {
  const calls: { path: string; method: string }[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ path: String(url), method: (init?.method || "GET").toUpperCase() });
    return {
      ok: status < 400,
      status,
      statusText: "",
      json: async () => body,
    } as Response;
  };
  return calls;
}

afterEach(() => resetIdentityState());

test("둘러보기 잠금은 바꾸는 요청을 막는다", async () => {
  const calls = stubFetch();
  setReadOnly(true);
  await assert.rejects(() => api.post("/admin/scenarios", {}), (e: ApiError) => e.code === "READ_ONLY");
  assert.equal(calls.length, 0, "막힌 요청은 서버로 나가지 않는다");
  await api.get("/admin/scenarios");
  assert.equal(calls.length, 1, "읽기는 그대로 나간다");
});

test("신분을 바꾸는 길은 둘러보기 잠금의 대상이 아니다", async () => {
  // 둘러보기로 보다가 나가서 게스트로 응시하려던 사람이 "둘러보기 모드입니다" 를 맞았다.
  // 다른 사람으로 들어가는 것은 이 계정의 쓰기가 아니다.
  const calls = stubFetch();
  setReadOnly(true);
  await api.post("/auth/guest", { name: "손님" });
  await api.post("/auth/guest/admin", {});
  await api.post("/auth/login", {});
  await api.post("/auth/logout");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/auth/guest", "/api/auth/guest/admin", "/api/auth/login", "/api/auth/logout"],
  );
});

test("나가면 이 브라우저에 남은 잠금이 걷힌다", () => {
  // 화면 이동이 클라이언트 라우팅이라 모듈 값은 저절로 사라지지 않는다.
  setReadOnly(true);
  assert.equal(isReadOnly(), true);
  resetIdentityState();
  assert.equal(isReadOnly(), false);
});
