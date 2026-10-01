"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { homeFor, useLogout, useUser } from "@/components/useUser";
import { Button, Spinner } from "@/components/ui";
import { IconCheck, IconClock } from "@/components/icons";
import type { AttemptResult, AttemptResultScenario } from "@/lib/types";

/** 시험을 마친 사람이 받아 가는 화면.
 *
 *  게스트에게는 이 화면이 **마지막 화면**이다 — 나가면 그 계정으로 다시 들어올 수 없다. 지금까지는
 *  제출하면 "평가자에게 전달되었습니다" 한 줄이 전부였고, 180분을 쓴 사람이 점수도 총평도 못 본 채
 *  나갔다. 이제 제출과 동시에 자동 채점이 걸리고(api: guest_result), 그 결과가 여기 나온다.
 *
 *  여기 나오는 것은 **응시자가 한 일에 대한 평가**뿐이다. 무엇을 했어야 했는지 — 자동 체크의 항목
 *  이름, 총평, 아쉬운 점 — 는 나오지 않는다. 그건 정답지이고, 같은 시나리오가 실제 채용 시험으로
 *  쓰인다. 서버가 그렇게 깎아서 준다 (api: guest_result).
 */
export default function ResultPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = use(params);
  const { user } = useUser(["candidate", "admin", "evaluator", "guest"]);
  const router = useRouter();
  const leave = useLogout();
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setResult(await api.get<AttemptResult>(`/attempts/${attemptId}/result`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "결과를 불러오지 못했습니다");
    }
  }, [attemptId]);

  useEffect(() => {
    load();
  }, [load]);

  // 채점은 뒤에서 돈다. 끝날 때까지 조용히 다시 묻는다 — 새로고침을 시키지 않는다.
  useEffect(() => {
    if (!result || result.state === "ready") return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [result, load]);

  if (error) {
    return (
      <Shell>
        <p className="text-sm text-red-600">{error}</p>
        <Button className="mt-4" variant="secondary" onClick={() => router.replace(homeFor(user?.role ?? "candidate"))}>
          돌아가기
        </Button>
      </Shell>
    );
  }
  if (!result) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  const finished = result.status === "submitted";
  return (
    <Shell>
      <header className="text-center">
        {/* 이모지 대신 같은 아이콘 세트를 쓴다 — 글꼴에 따라 모양이 제각각인 그림문자는
            화면의 다른 요소와 어울리지 않는다. */}
        <span
          className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
            finished ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
          }`}
        >
          {finished ? <IconCheck size={24} /> : <IconClock size={24} />}
        </span>
        <h1 className="mt-4 text-xl font-bold text-slate-900">
          {finished ? "시험이 제출되었습니다" : "시험 시간이 만료되었습니다"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">{result.assessment_title}</p>
      </header>

      {result.state === "ready" ? (
        <>
          {typeof result.overall_score === "number" && (
            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
              <p className="text-xs font-medium text-slate-500">총점</p>
              <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">
                {Math.round(result.overall_score)}
                <span className="ml-1 text-lg font-medium text-slate-400">/ 100</span>
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                AI로 평가한 점수입니다. 실제 점수는 관리자 검토 후 달라질 수 있습니다.
              </p>
            </div>
          )}
          <div className="mt-6 space-y-5">
            {result.scenarios.map((s, i) => (
              <ScenarioCard key={i} scenario={s} />
            ))}
          </div>
        </>
      ) : (
        // 기다리는 화면은 낮게. 점선 상자 안에 빈 공간이 넓으면 "아직 아무것도 없다" 가 아니라
        // "무언가 빠졌다" 로 읽힌다. 도는 표시와 말을 한 줄에 붙여 둔다.
        <div className="mt-6 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-4">
          <Spinner />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-700">채점하고 있습니다</p>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              대화와 작업물을 모두 읽기 때문에 1~2분 걸릴 수 있습니다. 이 화면을 열어 두세요.
            </p>
          </div>
        </div>
      )}

      <div className="mt-8 border-t border-slate-100 pt-5">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => router.replace(homeFor(user?.role ?? "candidate"))}
          >
            {user?.role === "guest" ? "사무실로" : "대시보드로"}
          </Button>
          {/* 게스트에게는 이 화면이 마지막 화면이다. "로그아웃하면 다시 못 들어온다" 고 적어 두고 정작
              나가는 문을 두지 않으면, 사람은 탭을 닫아 버리고 계정은 10분 뒤 세션이 식을 때까지 남는다. */}
          {user?.role === "guest" && (
            <Button variant="secondary" className="flex-1" onClick={() => leave(user)}>
              로그아웃
            </Button>
          )}
        </div>
        {user?.role === "guest" && (
          <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-400">
            게스트 계정은 로그아웃하면 다시 들어올 수 없습니다. 이 결과를 남기고 싶다면 지금 갈무리해 두세요.
          </p>
        )}
      </div>
    </Shell>
  );
}

function ScenarioCard({ scenario }: { scenario: AttemptResultScenario }) {
  const pct = Math.round(scenario.score_pct ?? 0);
  return (
    <section className="rounded-xl border border-slate-200 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">{scenario.title}</h2>
        {/* 이 문제의 배점 중 얼마를 받았는가 — 시험 안에서 문제마다 배점이 다르다 */}
        <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">
          {Math.round(scenario.earned_points ?? 0)}
          <span className="font-medium text-slate-400"> / {Math.round(scenario.points ?? 0)}점</span>
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-slate-800" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {scenario.checks_total > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          자동 확인 {scenario.checks_passed}/{scenario.checks_total}개 통과
        </p>
      )}

      <Items title="과정" items={scenario.process} />
      <Items title="결과물" items={scenario.result} />

      {scenario.strengths.length > 0 && <Notes title="잘한 점" items={scenario.strengths} />}
    </section>
  );
}

function Items({ title, items }: { title: string; items: AttemptResultScenario["process"] }) {
  if (!items?.length) return null;
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-slate-500">{title}</p>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-slate-700">{it.name}</span>
              {typeof it.earned === "number" && (
                <span className="shrink-0 tabular-nums text-xs text-slate-500">
                  {it.earned}
                  {typeof it.points === "number" && ` / ${it.points}`}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notes({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-emerald-700">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((t, i) => (
          <li key={i} className="text-sm leading-relaxed text-slate-600">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="desktop-wallpaper flex min-h-screen justify-center p-4 py-10">
      <div className="h-fit w-full max-w-2xl rounded-2xl bg-white p-8 shadow-2xl">{children}</div>
    </div>
  );
}
