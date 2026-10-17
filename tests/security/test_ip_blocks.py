"""주소 차단 판정 로직: 스택 없이 도는 순수 단위 검사.

  python3 tests/security/test_ip_blocks.py

여기서 보는 것은 '차단이 실제로 걸리는가'가 아니라 '무엇을 차단으로 세는가'다.
주소 표기는 같은 대상을 여러 형태로 쓸 수 있어서(203.0.113.7 과 /32, IPv6 축약),
표기가 갈리면 관리자가 막았다고 믿는 것과 서버가 막는 것이 어긋난다.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api"))

from odysseus_api.ip_blocks import is_blocked, normalize_cidr  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


print("차단 대상 판정")
check("단일 주소", is_blocked("203.0.113.7", ["203.0.113.7"]))
check("대역 안", is_blocked("203.0.113.99", ["203.0.113.0/24"]))
check("대역 밖", not is_blocked("203.0.114.1", ["203.0.113.0/24"]))
check("무관한 주소", not is_blocked("198.51.100.1", ["203.0.113.7", "10.0.0.0/8"]))
check("IPv6 대역", is_blocked("2001:db8::5", ["2001:db8::/32"]))
check("버전이 다르면 안 걸린다", not is_blocked("203.0.113.7", ["2001:db8::/32"]))

# 판정할 수 없는 값에서 fail-open 인지. 프록시 뒤에서 주소를 못 읽는 일이 있고,
# 그때 '모르니까 차단'은 서비스 전체를 잠그는 쪽으로 실패한다.
check("빈 주소는 막지 않는다", not is_blocked("", ["0.0.0.0/0"]))
check("주소가 아니면 막지 않는다", not is_blocked("?", ["0.0.0.0/0"]))
check("깨진 항목은 건너뛴다", is_blocked("203.0.113.7", ["쓰레기", "203.0.113.0/24"]))

print("표기 정규화 — 같은 대상은 한 행으로만 저장된다")
check("단일 주소는 /32 를 떼고", normalize_cidr("203.0.113.7") == "203.0.113.7", normalize_cidr("203.0.113.7"))
check("/32 도 같은 형태로", normalize_cidr("203.0.113.7/32") == "203.0.113.7", normalize_cidr("203.0.113.7/32"))
check("공백은 무시", normalize_cidr("  203.0.113.7  ") == "203.0.113.7")
check("호스트 비트가 켜진 대역도 받는다", normalize_cidr("203.0.113.7/24") == "203.0.113.0/24", normalize_cidr("203.0.113.7/24"))
for bad in ("", "abc", "203.0.113.999", "203.0.113.0/33"):
    try:
        normalize_cidr(bad)
        check(f"잘못된 값 거절: {bad!r}", False, "예외가 나오지 않음")
    except Exception as e:
        check(f"잘못된 값 거절: {bad!r}", getattr(e, "status_code", None) == 400, e)

print(f"\n통과 {ok} / 실패 {fail}")
sys.exit(1 if fail else 0)
