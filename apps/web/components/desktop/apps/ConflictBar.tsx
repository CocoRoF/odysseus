"use client";

/** 편집 중인 파일이 밖에서 바뀌었거나 사라졌다 — 문서·표 편집기 위에 세우는 선택 띠.
 *
 *  자동 저장은 이미 멈췄다(lib/autosave). 어느 쪽을 버릴지는 응시자가 정한다 — 조용히 덮으면
 *  에이전트·터미널이 한 일이 사라지고, 조용히 불러오면 응시자의 편집이 사라진다. */
export function ConflictBar({
  deleted,
  onKeepMine,
  onLoadServer,
}: {
  deleted: boolean;
  onKeepMine: () => void;
  onLoadServer: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
      <span className="min-w-0 flex-1">
        {deleted ? "이 파일이 다른 곳에서 삭제되었습니다." : "이 파일이 다른 곳(에이전트·터미널 등)에서 바뀌었습니다."} 내 편집은
        아직 저장되지 않았습니다.
      </span>
      <button
        onClick={onKeepMine}
        className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-500"
      >
        {deleted ? "내 편집으로 다시 만들기" : "내 편집으로 덮어쓰기"}
      </button>
      <button
        onClick={onLoadServer}
        className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
      >
        {deleted ? "내 편집 버리고 닫기" : "내 편집 버리고 바뀐 내용 불러오기"}
      </button>
    </div>
  );
}
