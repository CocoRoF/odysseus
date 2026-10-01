# 바꿔 끼울 수 있는 스프라이트

`node tools/tileset/build.mjs` 가 만든 표. `assets/office/sprites/<이름>.png` 를 두면 그 소품이 그림 대신 쓰인다.
크기는 무엇이든 되며(32·64·128·256 …) 아래 px 로 면적 평균 축소된다. 투명 배경(PNG 알파)이어야 한다.

| 이름 | 칸 | 기준 px |
|---|---|---|
| `desk` | 2×1 칸 | 128×64 px |
| `standDesk` | 2×1 칸 | 128×64 px |
| `console` | 2×1 칸 (+위로 1) | 128×128 px |
| `drawer` | 1×1 칸 | 64×64 px |
| `cabinet` | 1×1 칸 (+위로 1) | 64×128 px |
| `bookshelf` | 2×1 칸 (+위로 1) | 128×128 px |
| `plant` | 1×1 칸 (+위로 1) | 64×128 px |
| `printer` | 1×1 칸 | 64×64 px |
| `cooler` | 1×1 칸 (+위로 1) | 64×128 px |
| `vendingA` | 1×1 칸 (+위로 1) | 64×128 px |
| `vendingB` | 1×1 칸 (+위로 1) | 64×128 px |
| `coffee` | 1×1 칸 (+위로 1) | 64×128 px |
| `bin` | 1×1 칸 | 64×64 px |
| `recycle` | 1×1 칸 | 64×64 px |
| `whiteboard` | 2×1 칸 (+위로 1) | 128×128 px |
| `lamp` | 1×1 칸 (+위로 1) | 64×128 px |
| `sofa` | 3×1 칸 (+위로 1) | 192×128 px |
| `coffeeTable` | 2×1 칸 | 128×64 px |
| `meetingTable` | 3×1 칸 (+위로 1) | 192×128 px |
| `divider` | 2×1 칸 | 128×64 px |
| `rack` | 1×1 칸 (+위로 1) | 64×128 px |
| `copier` | 1×1 칸 (+위로 1) | 64×128 px |
| `corkboard` | 2×1 칸 · 벽 | 128×64 px |
| `clock` | 1×1 칸 (+위로 1) · 벽 | 70×128 px |
| `extinguisher` | 1×1 칸 (+위로 1) · 벽 | 64×128 px |
| `firstAid` | 1×1 칸 · 벽 | 64×64 px |
| `elevator` | 2×1 칸 · 벽 | 128×64 px |

바닥·벽은 `assets/office/tiles/`: `floor-<key>.png`·`hall.png`·`carpet.png`(128×128), `wall-h.png`(128×64)·`wall-v.png`(64×128). 기준 px 는 아틀라스 배율(2배) 기준이다. 산출물 이름에는 내용 해시가 붙는다(캐시 안전).
