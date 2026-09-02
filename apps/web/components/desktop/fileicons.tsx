"use client";

/** 파일 유형 판별 + 탐색기/IDE/뷰어가 공유하는 파일·폴더 글리프. */

export const TYPE_LABEL: Record<string, string> = {
  py: "Python 파일",
  js: "JavaScript 파일",
  ts: "TypeScript 파일",
  json: "JSON 파일",
  csv: "CSV 파일",
  md: "Markdown 문서",
  txt: "텍스트 문서",
  html: "HTML 문서",
  css: "CSS 파일",
  sql: "SQL 파일",
  sh: "셸 스크립트",
  yml: "YAML 파일",
  yaml: "YAML 파일",
  log: "로그 파일",
};

export function extOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

export function typeLabel(path: string): string {
  const ext = extOf(path);
  return TYPE_LABEL[ext] ?? (ext ? `${ext.toUpperCase()} 파일` : "파일");
}

export const EXT_COLOR: Record<string, string> = {
  py: "text-blue-500",
  js: "text-yellow-500",
  ts: "text-blue-600",
  json: "text-amber-600",
  csv: "text-emerald-600",
  md: "text-slate-500",
  txt: "text-slate-400",
  sh: "text-lime-600",
  html: "text-orange-500",
  css: "text-sky-500",
  log: "text-slate-400",
};

/** 다크 배경(IDE)용 확장자 색 */
export const EXT_COLOR_DARK: Record<string, string> = {
  py: "text-blue-400",
  js: "text-yellow-400",
  ts: "text-blue-400",
  json: "text-amber-400",
  csv: "text-emerald-400",
  md: "text-sky-300",
  txt: "text-slate-400",
  sh: "text-lime-400",
  html: "text-orange-400",
  css: "text-sky-400",
  log: "text-slate-400",
};

export function FileGlyph({
  path,
  size = 16,
  dark = false,
}: {
  path: string;
  size?: number;
  dark?: boolean;
}) {
  const ext = extOf(path);
  const color = (dark ? EXT_COLOR_DARK[ext] : EXT_COLOR[ext]) ?? (dark ? "text-slate-400" : "text-slate-400");
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center ${color}`}>
      <svg width={size} height={size * 1.18} viewBox="0 0 20 24" fill="none">
        <path
          d="M3 2.5A1.5 1.5 0 0 1 4.5 1H12l5 5v15.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 21.5v-19Z"
          fill="currentColor"
          fillOpacity="0.14"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path d="M12 1v5h5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
      {ext && size >= 24 && (
        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-black uppercase">
          {ext.slice(0, 4)}
        </span>
      )}
    </span>
  );
}

export function FolderGlyph({ size = 18, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg width={size} height={size * 0.82} viewBox="0 0 24 20" className="shrink-0">
      <path
        d="M1.5 4A2 2 0 0 1 3.5 2h5l2.2 2.5h9.8a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2V4Z"
        fill={open ? "#f59e0b" : "#fbbf24"}
      />
      <path d="M1.5 7h21v9a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2V7Z" fill={open ? "#fbbf24" : "#fcd34d"} />
    </svg>
  );
}
