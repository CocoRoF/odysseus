/** 그리기 여력 — 이 브라우저가 화면을 GPU 없이(소프트웨어 래스터) 그리고 있는가.
 *
 *  사무실은 캔버스 한 장을 프레임마다 다시 그린다. GPU 가 있으면 공짜에 가깝지만, 하드웨어 가속이 꺼진 PC(회사 정책·
 *  원격 데스크톱·오래된 드라이버·가상 머신)에서는 그 한 장을 CPU 가 칠한다 — 1600×1000 에 프레임당 20ms 남짓, 고해상도
 *  (DPR 2) 면 그 네 배라 10fps 아래로 떨어진다(2026-09-21 헤드리스 소프트웨어 크로미움 실측: 프레임 시간의 93% 가 캔버스 래스터).
 *
 *  두 갈래로 알아본다.
 *   1. **바로**: WebGL 이 말해 주는 렌더러 이름. SwiftShader·llvmpipe·softpipe·Microsoft Basic Render 는 소프트웨어다.
 *      이때만 캔버스 해상도까지 낮춘다(DPR 상한 1) — 확실할 때만 그림을 거칠게 한다.
 *   2. **재서**: 캔버스 루프가 프레임 간격을 재다가 그리기가 잦은데도 30fps 를 못 넘기면(중앙값 > 33ms, 두 창 연속) 알린다
 *      (OfficeCanvas onSlow). 이쪽은 해상도는 그대로 두고 25Hz·장식 끄기만 한다 — GPU 가 있는 PC 가 잠깐 바빴던 것일 수
 *      있어서, 흐려지는 쪽으로는 가지 않는다. 한 번 판정하면 이 탭에서는 계속 — 오락가락하면 더 나쁘다.
 *
 *  가볍게 간다(lite)는 뜻: 다시 그리기를 25Hz 로 묶고, 옮기는 중엔 최근접 보간으로 늘이고, 장식 애니메이션(책상 표식·이름표
 *  까닥임·숨쉬기)을 끄고, 출근길 연출은 검은 막으로 대신한다. 걷기·카메라·대화 같은 **기능**은 그대로다 — 덜 예쁠 뿐 덜 되는
 *  것은 없다. GPU 가 있는 PC 는 어느 길로도 들어오지 않는다 — 예전과 똑같이 그린다.
 */

const KEY = "odysseus:render-lite";
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|mesa offscreen|basic render|microsoft basic|warp/i;

let probed: boolean | null = null;

/** WebGL 렌더러 이름으로 소프트웨어 래스터를 알아본다. 서버·오류에서는 false(모른다 = 가볍게 가지 않는다). */
export function softwareRenderer(): boolean {
  if (probed !== null) return probed;
  if (typeof document === "undefined") return false;
  let soft = false;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ||
      c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    // WebGL 이 안 열리는 것만으로는 판정하지 않는다 — 정책으로 WebGL 만 막힌 GPU PC 가 있다. 그런 곳은 재서 알아낸다.
    if (!gl) soft = false;
    else {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "") : String(gl.getParameter(gl.RENDERER) ?? "");
      soft = SOFTWARE.test(name);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    soft = false;
  }
  probed = soft;
  return soft;
}

/** 이 탭에서 이미 "느리다" 고 판정했는가 */
export function rememberedLite(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** 느리다고 판정했다 — 이 탭이 살아 있는 동안 기억한다 */
export function rememberLite(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // 기억 못 하면 다음 화면에서 다시 재서 알아낸다
  }
}

/** 처음부터 가볍게 갈 것인가 — 소프트웨어 렌더러이거나 이 탭에서 이미 느렸다 */
export function startLite(): boolean {
  return rememberedLite() || softwareRenderer();
}
