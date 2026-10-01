"use client";

import { useEffect, useMemo, useState } from "react";

/** 화면 워터마크 — 응시자 식별 정보를 화면 전체에 옅게 깐다.
 *
 *  브라우저는 OS 의 화면 캡처를 막을 수 없다. 대신 캡처된 화면이 어디로 가든
 *  **누구의 화면이었는지**가 남게 한다: 이름·계정 앞부분·응시 번호·시각이 대각선으로
 *  반복된다. 외부 도구에 화면을 넘기는 순간 그 사실이 화면에 적혀 있다.
 *
 *  마우스 이벤트를 받지 않고(pointer-events: none) 창 위·작업 표시줄 아래에 놓인다.
 *  SVG 를 배경 타일로 쓰므로 DOM 노드는 하나뿐이다.
 */

const TILE_W = 380;
const TILE_H = 220;
const REFRESH_MS = 5 * 60 * 1000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stamp(now: Date): string {
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, "0");
  return `${h}:${m}`;
}

export function watermarkLabel(name: string, email: string, attemptId: string): string {
  const account = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const parts = [name.trim(), account.trim(), attemptId.slice(0, 8)].filter(Boolean);
  return parts.join(" · ");
}

export function Watermark({ name, email, attemptId }: { name: string; email: string; attemptId: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const background = useMemo(() => {
    const text = xmlEscape(`${watermarkLabel(name, email, attemptId)} · ${stamp(now)}`);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
      `<text x="20" y="${TILE_H / 2}" transform="rotate(-24 ${TILE_W / 2} ${TILE_H / 2})" ` +
      `font-family="ui-sans-serif, system-ui, 'Segoe UI', 'Noto Sans KR', sans-serif" font-size="13" ` +
      `fill="#64748b" fill-opacity="0.16">${text}</text></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }, [name, email, attemptId, now]);

  return (
    <div
      aria-hidden="true"
      data-watermark
      className="pointer-events-none absolute inset-0 z-[8900] select-none"
      style={{ backgroundImage: background, backgroundRepeat: "repeat", backgroundSize: `${TILE_W}px ${TILE_H}px` }}
    />
  );
}
