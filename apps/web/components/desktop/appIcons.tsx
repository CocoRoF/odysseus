"use client";

import type { ReactNode } from "react";
import {
  IconAgent,
  IconCalendar,
  IconDocs,
  IconFile,
  IconFolder,
  IconGithub,
  IconIde,
  IconMail,
  IconMessenger,
  IconSheet,
  IconTerminal,
} from "@/components/icons";
import type { AppId } from "./wm";

/** 앱 아이콘 한 벌 — 작업 표시줄·앱 전환기가 같은 그림을 쓴다. (바탕화면 아이콘은
 *  타일 색을 함께 가지므로 시험 화면이 따로 든다.) */
export function appIcon(id: AppId, size: number): ReactNode {
  switch (id) {
    case "terminal":
      return <IconTerminal size={size} />;
    case "files":
      return <IconFolder size={size} />;
    case "messenger":
      return <IconMessenger size={size} />;
    case "mail":
      return <IconMail size={size} />;
    case "docs":
      return <IconDocs size={size} />;
    case "sheet":
      return <IconSheet size={size} />;
    case "ide":
      return <IconIde size={size} />;
    case "agent":
      return <IconAgent size={size} />;
    case "github":
      return <IconGithub size={size} />;
    case "viewer":
      return <IconFile size={size} />;
  }
}

/** 작업 표시줄의 앱 순서 — 바탕화면과 같은 순서라 여러 개를 띄워도 찾는 위치가 어긋나지 않는다. */
export const TASKBAR_ORDER: AppId[] = [
  "terminal",
  "files",
  "messenger",
  "mail",
  "docs",
  "sheet",
  "ide",
  "agent",
  "github",
  "viewer",
];
