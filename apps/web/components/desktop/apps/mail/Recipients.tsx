"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { personFor } from "@/lib/avatars";
import { IconClose } from "@/components/icons";
import type { AttemptCharacter } from "@/lib/types";

/** 받는 사람 고르기 — 사내 메일 클라이언트의 그 칸.
 *
 *  예전에는 그냥 글자 칸이었다. 그러면 응시자가 이름을 외워서 쳐야 하고, 오타가 나도 아무도 말해 주지
 *  않으며, "이 시험에 누가 있는지" 를 메신저로 가서 확인해야 한다. 실제 회사 메일은 몇 글자만 쳐도
 *  사람이 뜨고, 빈칸을 누르면 주소록이 열린다. 그 두 가지만 있어도 메일다워진다.
 *
 *  고른 사람은 **칩**으로 남는다. 글자가 아니라 사람으로 다루어야 지우기도 쉽고, 누구에게 보냈는지도
 *  또렷하다. 저장할 때는 이름을 쉼표로 이어 적는다 — 파일을 읽는 쪽(자동 채점·평가자)은 지금과 같은
 *  모양을 본다.
 */
export function Recipients({
  label,
  value,
  onChange,
  people,
  placeholder,
}: {
  label: string;
  /** 쉼표로 이어진 이름 — 파일 헤더에 그대로 들어간다 */
  value: string;
  onChange: (next: string) => void;
  people: AttemptCharacter[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chosen = useMemo(
    () => value.split(",").map((v) => v.trim()).filter(Boolean),
    [value],
  );

  /** 아직 고르지 않은 사람 중, 친 글자가 이름이나 역할에 들어가는 사람 */
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return people
      .filter((p) => !chosen.includes(p.name))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.role ?? "").toLowerCase().includes(q));
  }, [people, chosen, draft]);

  useEffect(() => {
    setCursor(0);
  }, [draft, open]);

  // 바깥을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const add = (name: string) => {
    if (!name || chosen.includes(name)) return;
    onChange([...chosen, name].join(", "));
    setDraft("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const remove = (name: string) => onChange(chosen.filter((c) => c !== name).join(", "));

  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 w-12 shrink-0 text-xs text-slate-500">{label}</span>
      <div ref={boxRef} className="relative min-w-0 flex-1">
        <div
          className="flex min-h-[34px] w-full flex-wrap items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 focus-within:border-rose-400"
          onClick={() => {
            inputRef.current?.focus();
            setOpen(true);
          }}
        >
          {chosen.map((name) => {
            const person = people.find((p) => p.name === name);
            return (
              <span
                key={name}
                className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-1.5 text-xs text-slate-700"
              >
                <Face person={person} size={18} />
                {name}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(name);
                  }}
                  className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                  aria-label={`${name} 빼기`}
                >
                  <IconClose size={10} />
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            className="min-w-[80px] flex-1 bg-transparent py-0.5 text-sm outline-none"
            value={draft}
            placeholder={chosen.length ? "" : (placeholder ?? "이름을 치거나 눌러서 고르세요")}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setCursor((c) => Math.min(matches.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (open && matches[cursor]) add(matches[cursor].name);
                else if (draft.trim()) add(draft.trim()); // 목록에 없는 사람도 손으로 적을 수 있다
              } else if (e.key === "Escape") {
                setOpen(false);
              } else if (e.key === "Backspace" && !draft && chosen.length) {
                remove(chosen[chosen.length - 1]);
              }
            }}
          />
        </div>

        {open && matches.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {matches.map((p, i) => (
              <li key={p.key}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => add(p.name)}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left ${
                    i === cursor ? "bg-slate-100" : "hover:bg-slate-50"
                  }`}
                >
                  <Face person={p} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-800">{p.name}</span>
                    <span className="block truncate text-[11px] text-slate-400">{p.role}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 인물의 얼굴 — 메신저와 같은 초상을 쓴다. 같은 사람이 앱마다 다르게 보이면 안 된다. */
function Face({ person, size }: { person?: AttemptCharacter; size: number }) {
  const art = person
    ? personFor({ key: person.key, avatar_preset: person.avatar_preset, gender: person.gender })
    : null;
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-[10px] font-semibold text-slate-500"
      style={{ width: size, height: size }}
    >
      {art?.bust ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={art.bust} alt="" draggable={false} className="h-full w-full object-cover object-top" />
      ) : (
        (person?.name ?? "?").slice(0, 1)
      )}
    </span>
  );
}
