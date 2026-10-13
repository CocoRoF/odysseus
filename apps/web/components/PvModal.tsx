"use client";

import { useEffect, useRef, useState } from "react";
import { IconClose, IconPlay } from "@/components/icons";

/** 소개 영상(PV): 첫 화면의 [PV] 버튼과, 누르면 뜨는 영상 창.
 *
 *  영상은 유튜브에 있다. 쿠키를 남기지 않는 주소(youtube-nocookie)로 넣고, 창을 열 때만 iframe 을
 *  만든다. 닫으면 iframe 이 사라져 재생도 멈춘다.
 *
 *  엣지가 문서 전체에 `Referrer-Policy: no-referrer` 를 건다(ODY-024). 유튜브 임베드는 리퍼러가 없으면
 *  "동영상 플레이어 구성 오류"(153)로 재생을 거부하므로, 이 iframe 에만 출처(origin)를 보내도록 정책을 연다.
 */
export const PV_YOUTUBE_ID = "w-6vP8ettgM";

export function PvButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3.5 py-1.5 text-xs font-bold tracking-wider text-sky-200 transition hover:border-sky-300 hover:bg-sky-400/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
      >
        <IconPlay aria-hidden className="h-3.5 w-3.5" />
        PV
      </button>
      {open && <PvModal onClose={() => setOpen(false)} />}
    </>
  );
}

function PvModal({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, [onClose]);

  const src =
    `https://www.youtube-nocookie.com/embed/${PV_YOUTUBE_ID}` +
    "?autoplay=1&rel=0&modestbranding=1&playsinline=1";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Odysseus 소개 영상"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="영상 닫기"
          className="absolute -top-11 right-0 rounded-full p-2 text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
        >
          <IconClose aria-hidden className="h-6 w-6" />
        </button>
        <div className="aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10">
          <iframe
            src={src}
            title="Odysseus 소개 영상"
            className="h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>
  );
}
