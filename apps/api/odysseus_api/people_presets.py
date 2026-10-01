"""생성 파일 — 직접 고치지 말 것. `node tools/tileset/characters-import.mjs` 가 만든다.

apps/web/lib/people.ts 와 같은 목록이다. 서버는 그림을 모르지만 프리셋의 id 와 성별은
알아야 한다 — 빈 자리를 겹치지 않게 채우는 할당기(avatar_alloc)와 게스트가 고른
프리셋의 검증이 여기서 본다.
"""

PRESETS: tuple[dict, ...] = (
    {"id": "charactor-01", "name": "정장 여성", "gender": "female"},
    {"id": "charactor-02", "name": "정장 남성", "gender": "male"},
    {"id": "charactor-03", "name": "가디건 여성", "gender": "female"},
    {"id": "charactor-04", "name": "포니테일 여성", "gender": "female"},
    {"id": "charactor-05", "name": "아이보리 정장 여성", "gender": "female"},
    {"id": "charactor-06", "name": "조끼 여성", "gender": "female"},
    {"id": "charactor-07", "name": "원피스 여성", "gender": "female"},
    {"id": "charactor-08", "name": "짙은 정장 남성", "gender": "male"},
    {"id": "charactor-09", "name": "스웨터 남성", "gender": "male"},
    {"id": "charactor-10", "name": "장발 남성", "gender": "male"},
    {"id": "charactor-11", "name": "조끼 남성", "gender": "male"},
    {"id": "charactor-12", "name": "그린 재킷 남성", "gender": "male"},
    {"id": "charactor-13", "name": "라벤더 가디건 여성", "gender": "female"},
    {"id": "charactor-14", "name": "땋은 머리 여성", "gender": "female"},
    {"id": "charactor-15", "name": "흰 정장 단발 여성", "gender": "female"},
    {"id": "charactor-16", "name": "로즈 재킷 여성", "gender": "female"},
    {"id": "charactor-17", "name": "체크 스커트 여성", "gender": "female"},
    {"id": "charactor-18", "name": "하늘색 셔츠 여성", "gender": "female"},
    {"id": "charactor-19", "name": "초록 블라우스 여성", "gender": "female"},
    {"id": "charactor-20", "name": "네이비 니트 여성", "gender": "female"},
    {"id": "charactor-21", "name": "네이비 스커트 여성", "gender": "female"},
    {"id": "charactor-22", "name": "살구 가디건 여성", "gender": "female"},
    {"id": "charactor-23", "name": "버건디 블라우스 여성", "gender": "female"},
    {"id": "charactor-24", "name": "세이지 원피스 여성", "gender": "female"},
    {"id": "charactor-25", "name": "검은 재킷 단발 여성", "gender": "female"},
    {"id": "charactor-26", "name": "아이보리 재킷 남성", "gender": "male"},
    {"id": "charactor-27", "name": "네이비 더블 정장 남성", "gender": "male"},
    {"id": "charactor-28", "name": "니트 가디건 남성", "gender": "male"},
    {"id": "charactor-29", "name": "검은 조끼 남성", "gender": "male"},
    {"id": "charactor-30", "name": "카키 셔츠 남성", "gender": "male"},
    {"id": "charactor-31", "name": "야구 점퍼 남성", "gender": "male"},
    {"id": "charactor-32", "name": "와이드 팬츠 남성", "gender": "male"},
    {"id": "charactor-33", "name": "트위드 재킷 남성", "gender": "male"},
    {"id": "charactor-34", "name": "하늘색 반팔 셔츠 남성", "gender": "male"},
    {"id": "charactor-35", "name": "회색 블레이저 남성", "gender": "male"},
)

PRESET_IDS: frozenset[str] = frozenset(p["id"] for p in PRESETS)
