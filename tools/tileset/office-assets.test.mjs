/** 사무실 그림 파일의 계약 — 좌표표(atlas.ts)가 가리키는 파일이 전부 있고, 이름에 내용 해시가 붙어 있고, 옛 파일이 없다.
 *   node --test tools/tileset/
 *
 *  /office/*.png 는 4시간 캐시된다. 이름이 같은 채 그림만 바뀌면 옛 그림을 새 좌표로 잘라 랙이 커피머신으로 보인다.
 *  이 검사가 그 사고를 빌드 단계에서 막는다. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PUB = join(ROOT, "apps/web/public/office");

test("office assets: atlas.ts 의 모든 그림 주소가 내용 해시 이름이고 파일이 있으며 옛 파일이 남아 있지 않다", (t) => {
  const src = readFileSync(join(ROOT, "apps/web/components/office/atlas.ts"), "utf8");
  const urls = [...src.matchAll(/"\/office\/([^"]+\.png)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 20, `그림 주소가 ${urls.length}개뿐이다 (소품 시트 12 + 바닥 12 + 홀·카펫 2 + 벽 스타일 15)`);
  // 구입 팩에서 만든 소품·벽 시트는 비공개 서브모듈(office/licensed)에 산다 — 공개 저장소에 들어오면 안 된다
  const licensed = urls.filter((f) => f.startsWith("licensed/")).map((f) => f.slice("licensed/".length));
  const own = urls.filter((f) => !f.startsWith("licensed/"));
  assert.ok(licensed.some((f) => f.startsWith("atlas-")), "소품 시트(licensed/atlas-*.png) 주소가 없다");
  assert.ok(licensed.some((f) => f.startsWith("wall-")), "벽 스타일 시트(licensed/wall-*.png) 주소가 없다");
  assert.ok(!own.some((f) => /^(atlas-|wall-)/.test(f)), "구입 팩에서 만든 시트가 공개 경로(/office/)를 가리킨다 — /office/licensed/ 여야 한다");
  const LIC = join(PUB, "licensed");
  // 서브모듈을 받을 권한이 없는 곳(공개 클론·CI)에서는 그 파일들을 확인하지 않는다
  const haveLicensed = existsSync(join(LIC, "source"));
  if (!haveLicensed) t.diagnostic("구입 에셋 서브모듈이 없다 — licensed/ 파일 확인은 건너뛴다");
  const check = (dir, f) => {
    assert.match(f, /^[a-zA-Z0-9-]+\.[0-9a-f]{10}\.png$/, `${f}: 이름에 내용 해시가 없다`);
    const path = join(dir, f);
    assert.ok(existsSync(path), `${f} 이 없다 — node tools/tileset/build.mjs 를 다시 돌려라`);
    const hash = createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 10);
    assert.ok(f.includes(`.${hash}.`), `${f}: 이름의 해시가 내용과 다르다 — 그림이 바뀌었는데 빌드를 안 돌렸다`);
  };
  for (const f of own) check(PUB, f);
  if (haveLicensed) for (const f of licensed) check(LIC, f);
  // globals.css 는 주소를 모른다 — 변수만 쓴다
  const css = readFileSync(join(ROOT, "apps/web/app/globals.css"), "utf8");
  assert.ok(!/url\("?\/office\//.test(css), "globals.css 에 /office/ 그림 주소가 박혀 있다 — atlas.ts 의 OFFICE_ASSET_VARS 를 써라");
  // 옛 파일 없음
  const OURS = /^(atlas|atlas-[a-z]+|floor-[A-Za-z]+|hall|carpet|walls|wall-[a-z0-9]+|corner-[a-z]+|pillar-[lr])(\.[0-9a-f]+)?\.png$/;
  const stale = readdirSync(PUB).filter((f) => OURS.test(f) && !own.includes(f));
  if (haveLicensed) stale.push(...readdirSync(LIC).filter((f) => OURS.test(f) && !licensed.includes(f)).map((f) => `licensed/${f}`));
  assert.deepEqual(stale, [], `옛 그림 파일이 남아 있다: ${stale.join(", ")}`);
});
