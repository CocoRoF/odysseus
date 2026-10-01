/** 템플릿(코드에 있는 기본 장면)과 관리자가 고친 모양.
 *
 *  템플릿의 처음 모양은 scenes.ts 의 SCENES 에 있고, 관리자가 고친 모양은 DB(office_builtin_overrides)에 산다.
 *  배포는 코드를 새로 깔 뿐 DB 는 두므로 고친 모양이 유지된다. 여기서는 서버가 준 고친 모양을 **검증해서** 받아 두고,
 *  템플릿이 필요한 곳(자동으로 고른 방·템플릿을 가리키는 시험)에 끼운다. 잘못된 것은 버리고 코드의 기본값을 쓴다 —
 *  사무실이 멈추는 것보다 처음 모양이 서는 편이 낫다.
 */
import { SCENES, isBuiltinScene, type BuiltinSceneId, type SceneSpec } from "./scenes.ts";
import { safeScene } from "./scene-check.ts";

export type BuiltinOverrides = Partial<Record<BuiltinSceneId, SceneSpec>>;

/** 서버의 { 템플릿 id: 장면 JSON } → 쓸 수 있는 것만. id 는 템플릿 id 로, 이름이 비면 처음 이름으로. */
export function readBuiltinOverrides(raw: unknown): BuiltinOverrides {
  const out: BuiltinOverrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBuiltinScene(id)) continue;
    const ok = safeScene(spec);
    if (!ok) continue;
    out[id] = { ...ok, id, label: typeof ok.label === "string" && ok.label.trim() ? ok.label : SCENES[id].label };
  }
  return out;
}

/** 템플릿의 지금 모양 — 고쳤으면 고친 것, 아니면 코드의 기본값 */
export function builtinScene(id: BuiltinSceneId, overrides?: BuiltinOverrides): SceneSpec {
  return overrides?.[id] ?? SCENES[id];
}
