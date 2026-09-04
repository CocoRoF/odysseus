"""마감 점검 — 화면 전반에서 마크다운 누수·깨진 값·레이아웃 넘침·콘솔 오류를 훑는다.

평문 자리에 마크다운 문법이 새는 부류의 결함은 눈으로 잡기 어려워 자동화해 둔다.
Playwright 가 설치된 환경에서 실행:

  python3 tests/smoke/ui_polish.py
"""
import asyncio, json, re, urllib.request
from http.cookiejar import CookieJar
from playwright.async_api import async_playwright

BASE = "http://localhost:3100"
API = "http://localhost:8100"

MD_LEAK = re.compile(r"\*\*[^*\n]{1,60}\*\*|(?<!\w)__[^_\n]{1,60}__(?!\w)|(?<!`)`[^`\n]{1,40}`(?!`)")
BAD_VALUE = re.compile(r"\b(undefined|NaN|\[object Object\])\b")

problems = []


def reset():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    def call(m, p, b=None):
        d = json.dumps(b).encode() if b is not None else None
        r = urllib.request.Request(f"{API}{p}", data=d, method=m, headers={"Content-Type": "application/json"})
        with op.open(r, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
    for a in call("GET", "/review/attempts") or []:
        call("DELETE", f"/attempts/{a['id']}")


async def scan(pg, label, *, allow_md=False):
    """보이는 텍스트에서 마크다운 잔재/깨진 값 탐지."""
    text = await pg.evaluate("""() => {
        const skip = new Set(['SCRIPT','STYLE','TEXTAREA','PRE','CODE']);
        const walk = (el, out) => {
            for (const n of el.childNodes) {
                if (n.nodeType === 3) { out.push(n.textContent); continue; }
                if (n.nodeType !== 1) continue;
                const e = n;
                if (skip.has(e.tagName)) continue;
                if (e.closest('.prose')) continue;      // 마크다운 렌더 영역은 제외
                if (e.classList.contains('monaco-editor')) continue;
                walk(e, out);
            }
        };
        const out = [];
        walk(document.body, out);
        return out.join(' ');
    }""")
    if not allow_md:
        for m in MD_LEAK.findall(text):
            hit = m if isinstance(m, str) else str(m)
            if hit.strip():
                problems.append(f"[{label}] 마크다운 누수: {hit[:60]!r}")
    for m in BAD_VALUE.findall(text):
        problems.append(f"[{label}] 깨진 값: {m}")
    # 가로 스크롤(레이아웃 넘침)
    overflow = await pg.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 4")
    if overflow:
        problems.append(f"[{label}] 가로 스크롤 발생(레이아웃 넘침)")


async def main():
    reset()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1500, "height": 950})
        pg = await ctx.new_page()
        errors = []
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text[:160]))
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {str(e)[:160]}"))

        # ── 관리자 화면 ──
        await pg.goto(f"{BASE}/login")
        await scan(pg, "login")
        await pg.fill('input[type="email"]', "admin@odysseus.dev")
        await pg.fill('input[type="password"]', "admin1234")
        await pg.click('button[type="submit"]')
        await pg.wait_for_url("**/admin/scenarios", timeout=15000)
        await pg.wait_for_timeout(600)
        await scan(pg, "admin/scenarios")

        for path, wait in [("/admin/assessments", "시험 관리"), ("/admin/users", "사용자"),
                           ("/admin/settings", "LLM 공급자"), ("/review", "응시 리뷰")]:
            await pg.goto(f"{BASE}{path}")
            await pg.wait_for_selector(f"text={wait}", timeout=15000)
            await pg.wait_for_timeout(500)
            await scan(pg, path)

        # 스튜디오 전체 탭
        await pg.goto(f"{BASE}/admin/scenarios")
        await pg.click("text=LLM 추론 서비스가 GPU 노드에서 계속 죽는다")
        await pg.wait_for_selector("text=시작 화면 안내", timeout=15000)
        for tab in ["기본 정보", "등장인물", "오프닝 메시지", "초기 파일", "정답 · 평가"]:
            await pg.click(f"button:has-text('{tab}')")
            await pg.wait_for_timeout(400)
            await scan(pg, f"studio/{tab}")

        # 시험 편집
        await pg.goto(f"{BASE}/admin/assessments")
        await pg.wait_for_selector("text=시험 관리", timeout=10000)
        await pg.click("text=인프라 심화")
        await pg.wait_for_selector("text=시나리오 구성", timeout=15000)
        await pg.wait_for_timeout(600)
        await scan(pg, "assessment/edit")

        # ── 응시 화면 ──
        cand = await ctx.new_page()
        cand.on("console", lambda m: m.type == "error" and errors.append(f"exam: {m.text[:160]}"))
        cand.on("pageerror", lambda e: errors.append(f"exam pageerror: {str(e)[:160]}"))
        await cand.goto(f"{BASE}/login")
        await cand.fill('input[type="email"]', "candidate@odysseus.dev")
        await cand.fill('input[type="password"]', "cand1234")
        await cand.click('button[type="submit"]')
        await cand.wait_for_url("**/dashboard", timeout=15000)
        await cand.wait_for_selector('button:has-text("응시")', timeout=15000)
        await scan(cand, "dashboard")
        await cand.locator('button:has-text("응시")').first.click()
        await cand.wait_for_url("**/exam/**", timeout=20000)
        # 브리핑은 설정에 따라 카드("업무 시작하기") 또는 시네마틱("건너뛰기" → "임무 시작" → 부팅)
        await cand.wait_for_selector("text=업무 시작하기, text=건너뛰기", timeout=20000)
        cinematic = await cand.locator("text=건너뛰기").count() > 0
        if cinematic:
            await cand.click("text=건너뛰기")
            await cand.wait_for_selector(".intro-stage >> text=임무 시작", timeout=8000)
        await scan(cand, "exam/briefing", allow_md=True)  # 브리핑은 prose 렌더
        if cinematic:
            await cand.click(".intro-stage >> text=임무 시작")
            await cand.wait_for_selector("[data-boot]", timeout=5000)
            await cand.keyboard.press("Escape")
            await cand.wait_for_selector("[data-boot]", state="detached", timeout=8000)
        else:
            await cand.click("text=업무 시작하기")
        await cand.wait_for_selector("text=의 컴퓨터", timeout=15000)
        await cand.wait_for_timeout(1200)
        await scan(cand, "exam/messenger")

        for title in ["IDE", "폴더", "AI 에이전트"]:
            btn = cand.locator(f'div.z-\\[9000\\] button[title="{title}"]')
            if await btn.count():
                await btn.click()
                await cand.wait_for_timeout(1000)
                await scan(cand, f"exam/{title}")

        # 확인 다이얼로그 (마크다운 누수 지점)
        await cand.click('button:has-text("시험 종료")')
        await cand.wait_for_selector("text=시험을 종료할까요", timeout=5000)
        await scan(cand, "exam/confirm")
        await cand.keyboard.press("Escape")
        await cand.wait_for_timeout(300)
        still = await cand.locator("text=시험을 종료할까요").count()
        if still:
            problems.append("[exam/confirm] Escape 로 닫히지 않음")

        await b.close()

    if errors:
        for e in dict.fromkeys(errors):
            problems.append(f"[console] {e}")
    if problems:
        print("발견된 문제:")
        for p_ in dict.fromkeys(problems):
            print("  ·", p_)
        print(f"\n=== {len(set(problems))} problems ===")
    else:
        print("=== 마감 점검 통과 (마크다운 누수·깨진 값·넘침·콘솔 오류 없음) ===")


asyncio.run(main())
