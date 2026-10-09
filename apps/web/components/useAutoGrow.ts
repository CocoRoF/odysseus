"use client";

import { useLayoutEffect, type RefObject } from "react";

/** 내용에 맞춰 늘어나는 입력칸. 값이 바뀔 때마다(입력, 보낸 뒤 비우기, 되살리기) 높이를 다시 잰다.
 *
 *  예전에는 onChange 안에서만 높이를 고쳤다. 보내고 나서 setInput("") 으로 비우면 onChange 가 불리지 않아,
 *  여러 줄을 보낸 뒤에도 칸이 큰 채로 남았다(다시 입력해야 줄어들었다). 높이를 값에 묶으면 비울 때도 함께 줄어든다. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [ref, value, maxPx]);
}
