"use client";

import { useEffect, useState } from "react";
import { isReadOnly, onReadOnlyChange } from "@/lib/api";

/** 지금 화면이 **읽기 전용**인가 — 관리자 둘러보기 계정(demo_admin, 서버 demo.py)으로 보는 중이다.
 *
 *  서버가 바꾸는 요청을 이미 거절한다. 그런데 화면이 그대로면 [삭제]·[저장] 이 되는 일처럼 보이고,
 *  눌러 본 사람만 "안 된다" 를 알게 된다. 눌리기 전에 보이는 것이 맞다.
 *
 *  **바꾸는 조작에만** 표시한다. 검색·필터·탭 넘기기 같은 읽는 조작은 그대로 둬야 둘러보는 일이
 *  성립한다 — 전부 잠그면 볼 수 있는 것이 없다.
 *
 *  상태의 출처는 lib/api.ts 한 곳이다(useUser 가 /auth/me 를 읽고 정한다). React 문맥으로 두면
 *  그 문맥 **안쪽** 에서만 읽히는데, 화면들은 Shell 바깥에서도 훅을 부른다. */
export const READ_ONLY_REASON = "둘러보기 모드에서는 바꿀 수 없습니다";

export function useReadOnly(): boolean {
  const [value, setValue] = useState(false);
  useEffect(() => {
    setValue(isReadOnly());
    return onReadOnlyChange(setValue);
  }, []);
  return value;
}

/** 공용 버튼을 쓰지 않는 조작(체크박스·직접 만든 button)에 붙이는 속성.
 *
 *      const readOnly = useReadOnly();
 *      <input type="checkbox" {...writeProps(readOnly)} ... />
 */
export function writeProps(readOnly: boolean, disabled?: boolean) {
  return {
    disabled: readOnly || Boolean(disabled),
    ...(readOnly ? { title: READ_ONLY_REASON, "aria-disabled": true as const } : {}),
  };
}
