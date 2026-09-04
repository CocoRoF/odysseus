"""시네마틱 인트로(게이미피케이션) 검증.

기본 꺼짐 → 관리자 설정에서 켜기 → 검은 화면 타이핑 연출 → 건너뛰기 →
시작 버튼 → 데스크톱 진입까지. Playwright 가 설치된 환경에서 실행:

  python3 tests/smoke/ui_intro.py
"""
import asyncio, json, urllib.request
from http.cookiejar import CookieJar
from playwright.async_api import async_playwright

BASE, API = "http://localhost:3100", "http://localhost:8100"
SHOT = "/tmp/claude-1000/shots"


def call_factory():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    def call(m, p, b=None):
        d = json.dumps(b).encode() if b is not None else None
        r = urllib.request.Request(f"{API}{p}", data=d, method=m, headers={"Content-Type": "application/json"})
        with op.open(r, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
    return call


async def open_exam(pg, fresh=True):
    await pg.goto(f"{BASE}/login")
    await pg.fill('input[type="email"]', "candidate@odysseus.dev")
    await pg.fill('input[type="password"]', "cand1234")
    await pg.click('button[type="submit"]')
    await pg.wait_for_url("**/dashboard", timeout=15000)
    await pg.wait_for_selector('button:has-text("응시")', timeout=15000)
    await pg.locator('button:has-text("응시")').first.click()
    await pg.wait_for_url("**/exam/**", timeout=20000)


async def main():
    class OkList(list):
        def append(self, item):
            print("  PASS", item, flush=True)
            super().append(item)
    ok = OkList()
    call = call_factory()

    # 운영 설정은 건드리지 않는다 — 시작값을 기억해 두고 끝에 그대로 되돌린다.
    # (한 번 이 테스트가 관리자가 켜 둔 시네마틱 모드를 꺼 버려 "저장이 안 된다"는
    #  오해를 낳았다.)
    original = call("GET", "/admin/settings/ui")
    call("PUT", "/admin/settings/ui", {"gamified_intro": False})
    ui = call("GET", "/admin/settings/ui")
    assert ui["gamified_intro"] is False, ui
    ok.append("꺼짐 상태로 시작")

    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ── 꺼짐: 기존 카드 인트로 ──
        for a in call("GET", "/review/attempts") or []:
            call("DELETE", f"/attempts/{a['id']}")
        pg = await b.new_page(viewport={"width": 1500, "height": 950})
        await open_exam(pg)
        await pg.wait_for_selector("text=업무 시작하기", timeout=20000)
        assert await pg.locator(".intro-stage").count() == 0
        ok.append("off → 기존 카드 브리핑")
        await pg.close()

        # ── 관리자 화면에서 켜기 ──
        adm = await b.new_page(viewport={"width": 1400, "height": 950})
        await adm.goto(f"{BASE}/login")
        await adm.fill('input[type="email"]', "admin@odysseus.dev")
        await adm.fill('input[type="password"]', "admin1234")
        await adm.click('button[type="submit"]')
        await adm.wait_for_url("**/admin/scenarios", timeout=15000)
        await adm.goto(f"{BASE}/admin/settings")
        await adm.wait_for_selector("text=시네마틱 인트로", timeout=15000)
        ok.append("admin toggle present")
        # 설정 카드가 늘어도 흔들리지 않도록 라벨로 집는다
        await adm.locator('label:has-text("시네마틱 인트로") input[type="checkbox"]').check()
        await adm.wait_for_selector("text=응시 환경 설정을 저장했습니다", timeout=8000)
        ok.append("toggle saves")
        assert call("GET", "/admin/settings/ui")["gamified_intro"] is True
        ok.append("persisted to server")
        await adm.screenshot(path=f"{SHOT}/intro-setting.png")
        await adm.close()

        # ── 켜짐: 시네마틱 인트로 ──
        for a in call("GET", "/review/attempts") or []:
            call("DELETE", f"/attempts/{a['id']}")
        pg = await b.new_page(viewport={"width": 1500, "height": 950})
        await open_exam(pg)
        await pg.wait_for_selector(".intro-stage", timeout=20000)
        ok.append("on → 시네마틱 무대 진입")
        # 타이핑 도중에는 시작 버튼이 없다
        await pg.wait_for_timeout(1800)
        mid = await pg.locator(".intro-stage").inner_text()
        assert "임무 시작" not in mid, "낭독 중에 시작 버튼이 이미 보임"
        assert await pg.locator(".intro-caret").count() >= 1, "타이핑 커서 없음"
        ok.append("타이핑 진행 중 (커서 O, 시작 버튼 X)")
        await pg.screenshot(path=f"{SHOT}/intro-typing.png")
        # 건너뛰기
        await pg.click("text=건너뛰기")
        await pg.wait_for_selector(".intro-stage >> text=임무 시작", timeout=8000)
        full = await pg.locator(".intro-stage").inner_text()
        assert "월요일 오전 9시 12분" in full and "메신저에 새 메시지가 와 있습니다" in full, full[:200]
        assert "**" not in full
        ok.append("건너뛰기 → 전문 노출 + 시작 버튼")
        assert "과제는 명시적으로 제시되지 않습니다" in full
        ok.append("안내 문구 표시")
        await pg.screenshot(path=f"{SHOT}/intro-done.png")
        # 시작 → 데스크톱
        await pg.click(".intro-stage >> text=임무 시작")
        # 임무 시작 → 부팅 연출(실제 사양이 흐른다) → 데스크톱
        await pg.wait_for_selector("[data-boot]", timeout=8000)
        assert await pg.locator('[data-boot] img[alt="Odysseus"]').count() == 1, "로고 스플래시 없음"
        await pg.wait_for_selector("[data-boot] >> text=ODYSSEUS BIOS", timeout=15000)
        await pg.wait_for_selector("[data-boot] >> text=Started messenger daemon", timeout=20000)
        boot = await pg.locator("[data-boot]").inner_text()
        assert "김수진" in boot, boot[-300:]
        ok.append("부팅 연출 — BIOS → 서비스 기동에 실제 등장인물이 흐른다")
        # 작업 표시줄은 부팅 화면 아래에 이미 있으므로, 부팅 화면이 **사라지는 것**을 기다린다
        await pg.wait_for_selector("[data-boot]", state="detached", timeout=40000)
        await pg.wait_for_selector("text=의 컴퓨터", timeout=10000)
        assert await pg.locator(".intro-stage").count() == 0
        ok.append("시작 → 데스크톱 진입 (메신저 오픈)")
        await pg.close()

        # 원복 — 테스트 전 값으로
        call("PUT", "/admin/settings/ui", original)
        assert call("GET", "/admin/settings/ui")["gamified_intro"] is original["gamified_intro"]
        ok.append("원래 설정으로 복구")
        await b.close()
    print("PASS:", len(ok), "checks")


asyncio.run(main())
