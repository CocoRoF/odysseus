"use client";

import { AgentChat } from "../AgentChat";

/** 데스크톱 'AI 에이전트' 창 — IDE 사이드바 패널과 **같은 대화**를 보여준다
 *  (상태는 AgentSessionProvider 하나가 소유). */
export function AgentApp() {
  return <AgentChat theme="light" />;
}
