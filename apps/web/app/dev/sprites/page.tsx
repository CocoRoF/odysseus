"use client";

/** 캐릭터 시트 검사대 — /dev/sprites
 *
 * 사무실에 넣기 전에 **여덟 장이 제대로 그려지는지 눈으로 보는 곳**이다. 사무실과 똑같은
 * `Person` 컴포넌트로 그린다. 여기서 맞으면 사무실에서도 맞고, 여기서 틀리면 사무실을
 * 아무리 고쳐도 소용없다. 그래서 별도 구현 없이 같은 컴포넌트를 쓴다.
 *
 * 보여 주는 것:
 *  1. 프리셋마다 방향 4 × 자세 2 = 여덟 칸, 1배와 4배
 *  2. 걷는 모습 — 방향마다 idle/move 를 번갈아 (사무실의 걸음 간격과 같다)
 *  3. 시트 원본에 칸 눈금을 겹친 것 — 잘못 잘렸으면 여기서 바로 보인다
 *
 * 비밀은 없다. 시트는 이미 /office/ 아래 공개 자산이다.
 */
import { useEffect, useState } from "react";
import { Person } from "@/components/office/Person";
import { DIRS, PEOPLE, PEOPLE_SRC, PERSON_H, PERSON_W, POSES, type Pose } from "@/lib/people";

const STEP_MS = 190;

export default function SpritesPage() {
  const [pose, setPose] = useState<Pose>("idle");
  useEffect(() => {
    const t = setInterval(() => setPose((p) => (p === "idle" ? "move" : "idle")), STEP_MS);
    return () => clearInterval(t);
  }, []);

  const cols = DIRS.length * POSES.length;
  return (
    <main className="sprite-lab" data-sheet={PEOPLE_SRC}>
      <h1>캐릭터 시트 검사대</h1>
      <p className="sprite-lab-meta">
        시트 <code>{PEOPLE_SRC}</code> · 칸 {PERSON_W}×{PERSON_H} · 프리셋 {PEOPLE.length}개 · 칸 순서{" "}
        {DIRS.flatMap((d) => POSES.map((p) => `${p}-${d}`)).join(" | ")}
      </p>

      {PEOPLE.map((person) => (
        <section key={person.id} className="sprite-lab-preset" data-preset={person.id}>
          <h2>
            {person.name} <small>{person.id} · row {person.row} · {person.gender || "성별 없음"}</small>
          </h2>

          {[1, 4].map((zoom) => (
            <div key={zoom} className="sprite-lab-row" data-zoom={zoom}>
              {DIRS.map((dir) =>
                POSES.map((p) => (
                  <figure key={`${dir}-${p}`} className="sprite-lab-cell" data-dir={dir} data-pose={p}>
                    <div
                      className="sprite-lab-stage"
                      style={{ width: PERSON_W * zoom, height: PERSON_H * zoom }}
                    >
                      <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", width: PERSON_W, height: PERSON_H, position: "relative" }}>
                        {/* 사무실과 같은 기준: x 는 발 가운데, y 는 발끝 */}
                        <Person row={person.row} dir={dir} pose={p} x={PERSON_W / 2} y={PERSON_H} title={`${person.id} ${p}-${dir}`} />
                      </div>
                    </div>
                    <figcaption>{p}-{dir}</figcaption>
                  </figure>
                )),
              )}
            </div>
          ))}

          <div className="sprite-lab-row sprite-lab-walk" data-zoom={3}>
            {DIRS.map((dir) => (
              <figure key={dir} className="sprite-lab-cell" data-dir={dir} data-pose={pose}>
                <div className="sprite-lab-stage" style={{ width: PERSON_W * 3, height: PERSON_H * 3 }}>
                  <div style={{ transform: "scale(3)", transformOrigin: "0 0", width: PERSON_W, height: PERSON_H, position: "relative" }}>
                    <Person row={person.row} dir={dir} pose={pose} x={PERSON_W / 2} y={PERSON_H} title={`${person.id} walk-${dir}`} />
                  </div>
                </div>
                <figcaption>걷기 {dir}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}

      <section className="sprite-lab-preset">
        <h2>시트 원본 <small>칸 눈금 겹침 · 3배</small></h2>
        <div
          className="sprite-lab-sheet"
          style={{
            width: cols * PERSON_W * 3,
            height: PEOPLE.length * PERSON_H * 3,
            backgroundImage: `linear-gradient(to right, rgba(255,80,80,.7) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,80,80,.7) 1px, transparent 1px), url(${PEOPLE_SRC})`,
            backgroundSize: `${PERSON_W * 3}px ${PERSON_H * 3}px, ${PERSON_W * 3}px ${PERSON_H * 3}px, ${cols * PERSON_W * 3}px ${PEOPLE.length * PERSON_H * 3}px`,
          }}
        />
      </section>
    </main>
  );
}
