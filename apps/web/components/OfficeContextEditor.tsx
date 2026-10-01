"use client";
import type { OfficePublic } from "@/lib/types";

export const EMPTY_OFFICE_CONTEXT: OfficePublic = { published: false, setting: "", facts: [], topics: [] };
const input = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400";

export function OfficeContextEditor({ value, onChange }: { value: OfficePublic; onChange: (value: OfficePublic) => void }) {
  return <section className="rounded-2xl border border-sky-200 bg-sky-50/50 p-5 space-y-4">
    <div><h3 className="font-semibold text-slate-800">사무실에서 공개할 이야기</h3>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">NPC들이 시나리오 상황을 이어서 이야기하는 데 쓰입니다. 공개할 활동·분위기·갈등의 겉모습을 적어 주세요. 문제 조건·정답·평가 기준은 시험용 지식에만 작성합니다.</p></div>
    <label className="flex items-center gap-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={value.published}
      onChange={e => onChange({ ...value, published: e.target.checked })} />이 설정과 인물의 사무실 말투를 공개하기</label>
    <label className="block space-y-1"><span className="text-xs text-slate-600">공개 배경</span>
      <textarea className={input} rows={3} maxLength={1200} value={value.setting} placeholder="시나리오에서 지금 진행 중인 활동과 공개해도 되는 분위기"
        onChange={e => onChange({ ...value, setting: e.target.value })} /></label>
    <div className="space-y-2"><div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-600">공개 사실</span>
      <button type="button" className="text-xs text-sky-700" disabled={value.facts.length >= 24}
        onClick={() => onChange({ ...value, facts: [...value.facts, { id: `fact_${crypto.randomUUID().slice(0,8)}`, text: "" }] })}>+ 사실 추가</button></div>
      {value.facts.map((fact, index) => <div key={fact.id} className="flex gap-2"><input aria-label={`공개 사실 ${index+1}`} className={input} value={fact.text} maxLength={300}
        onChange={e => onChange({ ...value, facts: value.facts.map((f,i) => i === index ? { ...f, text: e.target.value } : f) })} />
        <button type="button" className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-600" aria-label={`공개 사실 ${index+1} 삭제`} onClick={() => onChange({ ...value,
          facts: value.facts.filter((_,i) => i !== index), topics: value.topics.map(t => ({ ...t, fact_ids: t.fact_ids.filter(id => id !== fact.id) })) })}>삭제</button></div>)}
    </div>
    <div className="space-y-2"><div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-600">NPC 간 대화 주제</span>
      <button type="button" className="text-xs text-sky-700" disabled={value.topics.length >= 12}
        onClick={() => onChange({ ...value, topics: [...value.topics, { id: `topic_${crypto.randomUUID().slice(0,8)}`, intent: "", fact_ids: [], kind: "scenario" }] })}>+ 주제 추가</button></div>
      {value.topics.map((topic,index) => <div key={topic.id} className="rounded-lg border border-sky-100 bg-white p-3 space-y-2">
        <div className="flex gap-2"><select aria-label={`대화 주제 ${index+1} 종류`} className="rounded-lg border border-slate-200 px-2 text-xs" value={topic.kind ?? "scenario"}
          onChange={e => onChange({ ...value, topics: value.topics.map((t,i) => i === index ? { ...t, kind: e.target.value as "scenario" | "daily" } : t) })}>
          <option value="scenario">시나리오</option><option value="daily">일상</option></select><input className={input} aria-label={`대화 주제 ${index+1}`} value={topic.intent} maxLength={200} placeholder="동료들이 어떤 이야기를 나눌까요?"
          onChange={e => onChange({ ...value, topics: value.topics.map((t,i) => i === index ? { ...t, intent: e.target.value } : t) })} />
          <button type="button" className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-600" onClick={() => onChange({ ...value, topics: value.topics.filter((_,i) => i !== index) })}>삭제</button></div>
        <div className="flex flex-wrap gap-2">{value.facts.map(fact => <label key={fact.id} className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={topic.fact_ids.includes(fact.id)} onChange={e => onChange({ ...value, topics: value.topics.map((t,i) => i !== index ? t :
            { ...t, fact_ids: e.target.checked ? [...t.fact_ids,fact.id] : t.fact_ids.filter(id => id !== fact.id) }) })} />{fact.text || "빈 사실"}
        </label>)}</div>
      </div>)}
    </div>
  </section>;
}
