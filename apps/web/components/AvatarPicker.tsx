"use client";

/** 참여자 아바타 고르기 — 시나리오 편집기의 [등장인물] 칸에 붙는다.
 *
 *  고르지 않아도 된다. 비워 두면 인물 키에서 하나가 정해지고, 그 배정은 **바뀌지
 *  않는다**(같은 인물은 언제나 같은 사람). 그래서 기본값이 '없음'이어도 화면은
 *  언제나 얼굴을 갖는다.
 *
 *  여기서는 프리셋 **전체**를 보여 준다 — 게스트 선택창(성별마다 여섯)과 달리 시나리오 인물은 모든 얼굴을 쓴다.
 *  프리셋이 많아(25) 성별로 묶고 목록만 스크롤한다.
 */
import { useState } from "react";
import { PEOPLE, personSpriteAt, type Dir, type Person } from "@/lib/people";
import { personFor } from "@/lib/avatars";

/** 도트 한 칸을 size 높이로 — background-size 로 바로 그린다(transform 으로 줄이면 작게 그린 걸 또 옮겨 뭉개진다) */
function Face({ row, dir = "down", size = 44 }: { row: number; dir?: Dir; size?: number }) {
  return <span aria-hidden="true" className="relative block" style={personSpriteAt(row, dir, "idle", size)} />;
}

const GENDER_LABEL: Record<string, string> = { female: "여성", male: "남성" };

/** 성별 묶음 — 여성·남성 다음에 그 밖의 값(성별 없음 포함) */
function groupsOf(people: readonly Person[]): { key: string; label: string; people: Person[] }[] {
  const keys = [...new Set(["female", "male", ...people.map((p) => p.gender)])];
  return keys
    .map((key) => ({ key, label: GENDER_LABEL[key] ?? (key || "성별 없음"), people: people.filter((p) => p.gender === key) }))
    .filter((g) => g.people.length > 0);
}

export function AvatarPicker({
  characterKey,
  value,
  onChange,
}: {
  characterKey: string;
  value: string;
  onChange: (presetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const auto = personFor({ key: characterKey, avatar_preset: "" });
  const current = value ? PEOPLE.find((p) => p.id === value) : null;
  const shown = current ?? auto;
  const groups = groupsOf(PEOPLE);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 hover:border-slate-300"
        title="아바타 고르기"
        aria-expanded={open}
      >
        <Face row={shown.row} size={34} />
        <span className="text-xs text-slate-500">
          {current ? current.name : "자동"}
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="닫기"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-[346px] rounded-xl border border-slate-200 bg-white p-3 shadow-xl" data-avatar-picker>
            <p className="mb-2 text-xs text-slate-500">
              고르지 않으면 <b>자동</b>으로 정해집니다 — 같은 인물은 언제나 같은 사람입니다.
            </p>
            <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => { onChange(""); setOpen(false); }}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-2 ${
                    value ? "border-slate-200 hover:border-slate-300" : "border-sky-400 bg-sky-50"
                  }`}
                >
                  <Face row={auto.row} size={40} />
                  <span className="text-[11px] text-slate-500">자동</span>
                </button>
              </div>
              {groups.map((g) => (
                <div key={g.key || "__none"} data-gender={g.key}>
                  <p className="mb-1 text-[11px] font-semibold text-slate-400">
                    {g.label} <span className="font-normal">{g.people.length}</span>
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {g.people.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { onChange(p.id); setOpen(false); }}
                        className={`flex flex-col items-center gap-1 rounded-lg border p-2 ${
                          value === p.id ? "border-sky-400 bg-sky-50" : "border-slate-200 hover:border-slate-300"
                        }`}
                        title={p.name}
                        data-preset={p.id}
                      >
                        <Face row={p.row} size={40} />
                        <span className="w-full truncate text-center text-[11px] text-slate-500">{p.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {shown.portrait && (
              <div className="mt-3 flex items-end gap-3 rounded-lg bg-slate-50 p-2">
                <img src={shown.portrait} alt="" className="h-24 w-auto" draggable={false} />
                <p className="pb-1 text-[11px] leading-relaxed text-slate-500">
                  대화를 걸면 이 모습이 메신저에 나타납니다.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
