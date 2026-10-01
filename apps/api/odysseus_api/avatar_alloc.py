"""인물 → 아바타 프리셋 할당 — 한 화면(방)에서 같은 얼굴이 최대한 겹치지 않게.

지정된 것(`avatar_preset`)은 그대로 둔다. 빈 것만 채우되, 규칙은 셋이다.

 1. **성별이 맞는 프리셋** 중에서 고른다. 성별이 비어 있으면 전체에서 고른다.
 2. **이미 쓰인 프리셋은 피한다.** 지정된 것이든 방금 채운 것이든, 이 방에서 가장 덜
    쓰인 프리셋을 먼저 쓴다. 그래서 프리셋이 인물보다 많으면 한 방에 같은 얼굴이 없고,
    모자라면 가장 고르게 돌아간다.
 3. **같은 인물은 같은 얼굴.** 한 시험의 여러 문제에 같은 키가 나오면 한 번만 정한다.
    동점일 때는 인물 키의 해시로 시작점을 돌려 방마다 첫 사람이 늘 같은 얼굴이 되지
    않게 한다 — 그래도 입력이 같으면 결과는 언제나 같다(결정론).

한 방 = 한 시험이 단위다. 사무실도 시험 화면(메신저)도 **같은 시험의 같은 인물 목록**
으로 이 함수를 부르므로, 사무실에서 본 얼굴이 메신저에서 바뀌지 않는다.
"""

from __future__ import annotations

from typing import Iterable

from .people_presets import PRESET_IDS, PRESETS


def _fnv1a(text: str) -> int:
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    # murmur3 fmix32 — 짧고 비슷한 키가 낮은 비트에서 뭉치지 않게
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h


def _pool(gender: str) -> list[str]:
    want = (gender or "").strip().lower()
    pool = [p["id"] for p in PRESETS if p["gender"] == want] if want else []
    return pool or [p["id"] for p in PRESETS]


def allocate(characters: Iterable[dict]) -> dict[str, str]:
    """인물 dict 들(key·gender·avatar_preset 만 본다) → {key: preset_id}.

    입력 순서가 곧 우선순위다 — 앞 인물이 먼저 고른다. 같은 키는 처음 것만 센다.
    """
    used: dict[str, int] = {}
    chosen: dict[str, str] = {}

    # 1) 인물마다 첫 등장 순서·성별·지정값을 모은다. 같은 인물이 어느 문제에서는 지정되고
    #    다른 문제에서는 비어 있으면 **지정이 이긴다** — 등장 순서와 무관하게.
    order: list[str] = []
    gender_of: dict[str, str] = {}
    explicit_of: dict[str, str] = {}
    for c in characters:
        key = str((c or {}).get("key") or "").strip()
        if not key:
            continue
        if key not in gender_of:
            order.append(key)
            gender_of[key] = str(c.get("gender") or "")
        explicit = str(c.get("avatar_preset") or "").strip()
        if explicit in PRESET_IDS and key not in explicit_of:
            explicit_of[key] = explicit

    # 지정된 것부터 — 이것들이 '피해야 할 얼굴'의 출발점이다
    for key, pid in explicit_of.items():
        chosen[key] = pid
        used[pid] = used.get(pid, 0) + 1
    pending = [(key, gender_of[key]) for key in order if key not in explicit_of]

    # 2) 빈 것은 가장 덜 쓰인 프리셋으로. 동점은 키 해시로 시작점을 돌려 고른다.
    for key, gender in pending:
        pool = _pool(gender)
        start = _fnv1a(key) % len(pool)
        best: str | None = None
        best_n = None
        for i in range(len(pool)):
            pid = pool[(start + i) % len(pool)]
            n = used.get(pid, 0)
            if best_n is None or n < best_n:
                best, best_n = pid, n
                if n == 0:
                    break
        assert best is not None
        chosen[key] = best
        used[best] = used.get(best, 0) + 1
    return chosen
