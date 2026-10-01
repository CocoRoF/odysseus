"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MyAssignment, OfficeColleague } from "@/lib/types";
import { categoryAccent } from "@/lib/categories";

import { type SpriteName } from "./atlas";
import { OfficeCanvas } from "./OfficeCanvas";
import { rowFor } from "@/lib/avatars";
import { PERSON_H } from "@/lib/people";
import { useCrew, type CrewMember, type CrewSeed } from "./useCrew";
import { TalkBox } from "./TalkBox";
import { SpeechBubble } from "./SpeechBubble";
import { useOfficeLife } from "./useOfficeLife";
import { observedRoom, type WorldBounds } from "./life";
import { Desk, deskAction } from "./Desk";
import { Sector } from "./Sector";
import { useWalk } from "./useWalk";
import { OFFICE_ASSET_VARS, S } from "./atlas";
import {
  MIN_SPATIAL_FIT,
  TILE,
  WALL,
  buildFloor,
  canStand,
  innerOrigin,
  layoutRoom,
  standingSpotOf,
  findPath,
  roomAt,
  walkableRects,
  type Floor,
  type Room,
  type RoomLayout,
  FACE,
  doorGapOf,
} from "./floorplan";
import { SCENES, isBuiltinScene, type SceneSpec } from "./scenes";
import type { BuiltinOverrides } from "./builtin-scenes";
import { safeScene } from "./scene-check";
import { IconRecenter, IconZoomIn, IconZoomOut } from "@/components/icons";
import { rememberLite, softwareRenderer, startLite } from "@/lib/render-power";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampAxis,
  clampFocus,
  coastFocus,
  rubberFocus,
  focusKeeping,
  snapScale,
  tweenAt,
  worldAt,
  type Cam,
  type Tween,
  type TweenKind,
  type View,
} from "./camera";

/** 방 안까지 들어갔을 때의 배율. 이 이상 당기면 옆 방이 화면에서 사라져 길을 잃는다. */
const ZOOM_IN = 1.5;

/** 카메라 옮기기의 길이(ms) — 방 드나들기는 넉넉히, 휠 한 칸은 짧게(손을 따라오게), 되돌아가기는 그 사이 */
const CAM_ENTER_MS = 620;
const CAM_ZOOM_MS = 180;
const CAM_RECENTER_MS = 420;
const CAM_COAST_MS = 420;
/** 범위 밖(고무줄로 끈 자리·가장자리에서 붙잡은 확대)에서 범위로 돌아가는 길이 */
const CAM_SETTLE_MS = 300;
/** 이만큼(CSS px) 움직여야 끌기다 — 더 짧으면 누름(방 들어가기·자리 누르기)으로 둔다 */
const DRAG_SLOP = 5;

/** 하단 바 높이 — 배율을 잡을 때 이만큼은 층이 아니라 바의 몫이다. */
const BAR_H = 72;

/** 출근 연출(ms). 문에서 걸어 나오고, 불이 번지고, 카메라가 층으로 물러난다 */
const ENTRANCE_MS = 2800;
/** 빛이 다 걷힌 뒤에 걷기 시작한다 */
const ENTRANCE_STEP_MS = 800;
/** 들어오는 몇 걸음은 평소(420)보다 느리다 */
const ENTRANCE_WALK_SPEED = 150;
const ENTRANCE_PULL_MS = 1100;
const ENTRANCE_CAM_MS = 1400;
/** 문 앞을 볼 때의 배율(월드 px 하나가 CSS px 몇 개인가) */
const ENTRANCE_SCALE = 1.15;
const ENTRANCE_LIGHT_BASE_MS = 300;
const ENTRANCE_LIGHT_SPREAD_MS = 1400;
/** 복도 왼쪽 끝(벽 안쪽)에서 출발해 출근 자리까지 몇 걸음 걸어 들어온다 */
const ENTRANCE_FROM_LEFT = 36;

/** 출근 연출. go 가 켜지면 문에서 걸어 나오고 방마다 불이 켜진다 */
export interface EntranceCtl {
  go: boolean;
  onDone: () => void;
}

export function OfficeStage({
  assignments,
  seed,
  avatarPreset = "",
  myName = "",
  busyId,
  onStart,
  onAnnounce,
  builtins,
  entrance = null,
}: {
  assignments: MyAssignment[];
  /** 출근 연출. 있으면 문 앞의 어둠에서 시작해 go 를 기다린다 */
  entrance?: EntranceCtl | null;
  /** 관리자가 고친 템플릿 — 템플릿을 쓰는 방(자동 포함)이 고친 모양으로 선다. 없으면 코드의 기본값. */
  builtins?: BuiltinOverrides;
  seed: string;
  /** 계정이 고른 내 아바타 프리셋. 비어 있으면 seed 에서 정한다. */
  avatarPreset?: string;
  /** 내 아바타 머리 위에 띄울 이름. 비어 있으면 표식을 띄우지 않는다. */
  myName?: string;
  busyId: string | null;
  onStart: (assignment: MyAssignment) => void;
  onAnnounce: (message: string) => void;
}) {
  const [entered, setEntered] = useState<string | null>(null);
  const [peeked, setPeeked] = useState<MyAssignment | null>(null);
  /** 출근 연출의 단계. wait = 문 앞에서 어둡게, run = 걸어 나오며 불이 켜진다, done = 평소 */
  const [entrancePhase, setEntrancePhase] = useState<"wait" | "run" | "done">(entrance ? "wait" : "done");
  const entrancePhaseRef = useRef(entrancePhase);
  const [entranceCam, setEntranceCam] = useState(Boolean(entrance));
  const [lit, setLit] = useState(!entrance);
  const [veil, setVeil] = useState(Boolean(entrance));
  const entranceLock = entrancePhase !== "done";
  const lockRef = useRef(entranceLock);
  lockRef.current = entranceLock;
  const entranceDoneRef = useRef(entrance?.onDone);
  entranceDoneRef.current = entrance?.onDone;
  const [fit, setFit] = useState(1);
  /** 사용자가 휠·버튼·키로 고른 확대 배율 — 기본 배율(층 맞춤 × 방 당김)에 곱한다 */
  const [userZoom, setUserZoom] = useState(1);
  const userZoomRef = useRef(1);
  userZoomRef.current = userZoom;
  /** 사용자가 옮겨 놓은 시점(화면 가운데의 월드 점). null 이면 따라가기 — 방이면 방, 층이나 방이 화면보다 크면 아바타. */
  const [free, setFree] = useState<{ fx: number; fy: number } | null>(null);
  const freeRef = useRef(free);
  freeRef.current = free;
  /** 끌어서 시점을 옮기는 중 */
  const [panning, setPanning] = useState(false);
  /** 보이는 카메라와 진행 중인 옮기기(렌더마다 갱신) */
  const shownRef = useRef<Cam | null>(null);
  const tweenRef = useRef<Tween | null>(null);
  /** 카메라 옮기기 요청 — 다음 렌더에서 **지금 보이는 카메라**에서 새 목표까지 옮긴다 */
  const camKick = useRef<{ kind: TweenKind; dur: number; anchor?: Tween["anchor"] } | null>(null);
  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }, []);
  /** 가벼운 모드 — 그리기 여력이 없는 브라우저(GPU 가속 꺼짐). 처음부터 알 수 있으면(소프트웨어 렌더러) 바로, 아니면 캔버스가
   *  프레임을 재다가 알린다. 켜지면 캔버스는 CSS 픽셀 해상도·25Hz 로, 장식 애니메이션은 CSS 가 끈다([data-lite]). 기능은 같다. */
  const [lite, setLite] = useState(false);
  /** 소프트웨어 렌더러라고 **확실히** 알았을 때만 캔버스 해상도까지 낮춘다. 재서 알아낸 느림은 흐려지는 쪽으로 가지 않는다 */
  const [softRaster, setSoftRaster] = useState(false);
  useEffect(() => {
    if (softwareRenderer()) setSoftRaster(true);
    if (startLite()) setLite(true);
  }, []);
  const goLite = useCallback(() => {
    rememberLite();
    setLite(true);
  }, []);
  /** 처리기(한 번만 단다)가 부르는 확대·되돌리기 — 아래 카메라 셈 뒤에서 채운다 */
  const zoomRef = useRef<(factor: number, sx?: number, sy?: number) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const [viewSize, setViewSize] = useState({ w: 0, h: 0, fullH: 0 });
  /** 기기 픽셀 비율 — 카메라를 기기 픽셀에 맞춰 끊는 데 쓴다(서버에서는 1, 재면 실제 값. 브라우저 확대도 여기 잡힌다) */
  const [dpr, setDpr] = useState(1);
  /** 뷰포트 요소 자체가 페이지에서 소수 픽셀에 놓일 수 있다(글줄 높이 합). 그만큼을 카메라에서 빼야 타일 경계가 기기 픽셀에 앉는다. */
  const [originFrac, setOriginFrac] = useState({ x: 0, y: 0 });
  /** 방을 드나들면 카메라가 미끄러지듯 그 방으로 당겨지고(나오면 층으로 물러나고), 사용자가 옮겨 둔 시점·배율은 처음으로 돌아간다.
   *
   *  예전에는 곧장 옮겼다 — DOM 레이어 여러 장이 매 프레임 새 배율로 다시 래스터되며 화면이 출렁였기 때문이다(2026-09-13).
   *  지금은 층이 캔버스 한 장이고, 움직이는 동안은 구워 둔 비트맵을 늘여 그리다가 멈추면 정수 배율로 다시 굽는다(OfficeCanvas). */
  const setEnteredAnimated = useCallback((id: string | null) => {
    camKick.current = { kind: "glide", dur: CAM_ENTER_MS };
    setFree(null);
    setUserZoom(1);
    setEntered(id);
  }, []);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  /** 방 하나가 시험 하나다 — 층은 시험 목록에서 만들어지고, 방의 좌표를 적어 둔 곳은
   *  어디에도 없다. 그 방에 서는 사람은 **그 시험의 NPC** 이고, 방의 색은 시험의 분야다. */
  const roomSpecs = useMemo(
    () =>
      assignments.map((a) => ({
        slug: a.assessment_id,
        // 문패: 같은 분야의 방이 여럿이면 꼬리표가 먼저 읽혀야 한다 — "[초급] 주간 회의록 정리"
        label: a.label ? `[${a.label}] ${a.title}` : a.title,
        // 방의 색은 시험의 분야에서 온다 — 같은 분야는 같은 색, 문패와 문턱이 그 색이다.
        accent: categoryAccent(a.category),
        category: a.category ?? "",
        // 관리자가 이 시험(또는 분야)에 정한 장면. 잘못된 장면이 오면 기본으로 돌아간다 — 층이 죽지 않는다.
        scene: sceneOfAssignment(a, builtins),
      })),
    [assignments, builtins],
  );
  const floor: Floor = useMemo(() => buildFloor(roomSpecs, builtins), [roomSpecs, builtins]);
  const roomOf = useMemo(() => new Map(floor.rooms.map((r) => [r.id, r])), [floor]);
  /** 방 id(=시험 id) → 이름. 빵부스러기·안내 문구가 쓴다. */
  const labelOf = useCallback((id: string) => roomOf.get(id)?.label ?? id, [roomOf]);

  /** 방 → 그 방의 시험. 방이 곧 시험이므로 언제나 한 건이다.
   *  (배열 모양은 그대로 둔다 — 자리 버튼·이름표가 이 모양을 이미 쓴다.) */
  const byRoom = useMemo(() => {
    const map = new Map<string, MyAssignment[]>();
    assignments.forEach((a) => map.set(a.assessment_id, [a]));
    return { map };
  }, [assignments]);

  /** 방 배치는 한 번만 계산한다. 자리도 소품도 여기서 나온다 — 화면 어디에도
   *  좌표를 손으로 적어 둔 곳이 없다. */
  const layouts = useMemo(() => {
    const out = new Map<string, RoomLayout>();
    floor.rooms.forEach((r) => {
      const crew = byRoom.map.get(r.id)?.[0]?.colleagues?.length ?? 0;
      out.set(r.id, layoutRoom(r, crew));
    });
    return out;
  }, [byRoom, floor]);

  /** 동료를 어디에 세울지 — **장면이 낸 자리를 그대로** 넘긴다. 모두 서 있다.
   *  자리마다 보는 방향이 있어(화이트보드를 본다, 마주 본다) 방이 이야기하는 곳으로 읽힌다. */
  const crewSeeds = useMemo(() => {
    const out: CrewSeed[] = [];
    floor.rooms.forEach((r) => {
      const L = layouts.get(r.id);
      if (!L) return;
      const crew = byRoom.map.get(r.id)?.[0]?.colleagues ?? [];
      crew.forEach((c, i) => {
        const spot = L.standing[i];
        if (spot) out.push({ key: `${r.id}:${c.key}`, c, roomId: r.id, home: spot, face: spot.face, roam: L.standing });
      });
    });
    return out;
  }, [floor, layouts, byRoom]);

  /** 걸을 수 있는 자리는 배치가 정한다 — 통로로 판 칸과 가구가 없는 칸만이다.
   *  그래서 아바타가 책상 위로 지나가지 않고, 문에서 자리까지의 길이 보장된다. */
  const walkable = useMemo(() => walkableRects(floor, layouts), [floor, layouts]);
  /** 몸 상자의 반지름(월드 px) — 한 칸이 48px 이고 사람이 두 칸 키라 14 가 어깨너비쯤이다. 1칸 통로(48)에도 여유가 남는다. */
  const stand = useCallback((x: number, y: number) => canStand(x, y, walkable, 14, floor.blocked), [walkable, floor]);
  /** 두 점 사이의 길 — 걷는 칸을 따라 꺾어 간다. 직선으로 가면 책상·소파·도려낸 모서리를 뚫는다. */
  const route = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => findPath(walkable, from, to), [walkable]);
  const { pos, dir: myDir, pose: myPose, walking, walkTo, setDrive, teleport, stop } = useWalk(
    floor.spawn,
    floor.corridorY,
    stand,
    route,
  );

  /** 화면 폭에 맞춰 층 전체가 들어가도록 배율을 잡는다. */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 하단 바가 층을 가리지 않도록 그만큼 빼고 배율을 잡는다.
      const usableH = Math.max(160, rect.height - BAR_H);
      const next = Math.min(rect.width / floor.world.width, usableH / floor.world.height);
      setFit(next);
      setViewSize({ w: rect.width, h: usableH, fullH: rect.height });
      // 가벼운 모드는 기기 픽셀이 아니라 CSS 픽셀로 그린다 — 고해상도 화면에서 칠할 픽셀이 넷 중 하나로 준다
      const ratio = softRaster ? Math.min(window.devicePixelRatio || 1, 1) : window.devicePixelRatio || 1;
      setDpr(ratio);
      const frac = (v: number) => (((v * ratio) % 1) + 1) % 1 / ratio;
      setOriginFrac({ x: frac(rect.left), y: frac(rect.top) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [floor, softRaster]);

  // 시험 목록이 바뀌어 층이 다시 그려지면 아바타가 벽 안에 갇힐 수 있다. 문 앞으로 돌려놓는다.
  useEffect(() => {
    teleport(entrancePhaseRef.current === "wait" ? { x: floor.corridor.left + ENTRANCE_FROM_LEFT, y: floor.corridorY } : floor.spawn);
    setEnteredAnimated(null);
    setPeeked(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor]);

  // 출근 — 불을 켜고, 문에서 걸어 나오고, 카메라가 층으로 물러난다. 움직임을 줄인 사람은 곧장 평소 화면이다.
  useEffect(() => {
    if (!entrance?.go || entrancePhaseRef.current !== "wait") return;
    // 끝나면 어둠 층도 내린다. onDone 이 entrance 를 비우면 이 효과가 정리되므로 뒤에 타이머를 남기지 않는다
    const finish = () => {
      entrancePhaseRef.current = "done";
      setEntrancePhase("done");
      setVeil(false);
      entranceDoneRef.current?.();
    };
    if (reducedMotion.current) {
      teleport(floor.spawn);
      setLit(true);
      setEntranceCam(false);
      finish();
      return;
    }
    entrancePhaseRef.current = "run";
    setEntrancePhase("run");
    setLit(true);
    const ts = [
      setTimeout(() => walkTo(floor.spawn, ENTRANCE_WALK_SPEED), ENTRANCE_STEP_MS),
      setTimeout(() => {
        camKick.current = { kind: "glide", dur: ENTRANCE_CAM_MS };
        setEntranceCam(false);
      }, ENTRANCE_PULL_MS),
      setTimeout(finish, ENTRANCE_MS),
    ];
    return () => {
      ts.forEach(clearTimeout);
      if (entrancePhaseRef.current === "run") entrancePhaseRef.current = "wait";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrance?.go]);

  const enter = useCallback(
    (id: string) => {
      if (entered === id) return;
      setEnteredAnimated(id);
      const target = roomOf.get(id);
      if (!target) return;
      walkTo(standingSpotOf(target));
      const count = byRoom.map.get(id)?.length ?? 0;
      onAnnounce(
        count === 0
          ? `${labelOf(id)}에 들어왔습니다. 배정된 시험이 없습니다.`
          : `${labelOf(id)}에 들어왔습니다. 시험 ${count}개가 있습니다.`,
      );
    },
    [entered, walkTo, byRoom, onAnnounce, roomOf, labelOf],
  );

  /** 사용자가 나가기를 골랐다 — 아바타가 문을 지나 나가는 동안 "아직 방 안"이라며 다시 들어가지 않게.
   *  (그러면 카메라가 아바타가 복도에 닿을 때까지 1.8초 동안 방에 머물러, 나가기가 먹지 않은 것처럼 보였다.) */
  const leavingRef = useRef(false);
  const leave = useCallback(() => {
    leavingRef.current = true;
    setEnteredAnimated(null);
    setPeeked(null);
    walkTo(floor.spawn);
    onAnnounce("복도로 나왔습니다.");
  }, [walkTo, onAnnounce, floor]);

  /** 방향키(또는 WASD)로 층을 돌아다닌다.
   *
   *  Tab 으로 자리에 바로 닿는 길은 그대로 둔다 — 이건 그 위에 얹는 다른 길이지
   *  대체가 아니다. 글자를 입력하는 중에는 가로채지 않고, 자리 버튼에 포커스가 가 있을
   *  때 Enter 는 그 버튼의 몫이므로 여기서 다시 처리하지 않는다. */
  const keys = useRef<Set<string>>(new Set());
  const nearRef = useRef<MyAssignment | null>(null);
  /** 지금 말을 걸 수 있는 동료 (다가가 있는 사람) */
  const [nearPerson, setNearPerson] = useState<{ c: OfficeColleague; x: number; y: number; roomId: string } | null>(null);
  const nearPersonRef = useRef<typeof nearPerson>(null);
  nearPersonRef.current = nearPerson;
  /** 대화 중인 상대. 열려 있으면 걷지 않는다. */
  const [talking, setTalking] = useState<(OfficeColleague & { roomId: string }) | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  const talkingRef = useRef<OfficeColleague | null>(null);
  talkingRef.current = talking;

  /** 살아 있는 동료들. 모두 서 있고, 몇 초에 한 번 옆자리로 옮긴다. 누가 다가오면
   *  고개를 돌린다 — 여덟 장을 다 쓰는 것이 이 루프다. */
  /** 캔버스가 매 프레임 읽는 동료들 — React 상태(crew)는 말 걸기·근접 판정용으로 90ms 마다 묶여 나온다 */
  const liveCrew = useRef<readonly CrewMember[]>([]);
  const visibleBounds = useRef<WorldBounds | null>(null);
  const [observed, setObserved] = useState<string | null>(null);

  const dialogueRoom = entranceLock ? null : talking?.roomId ?? entered ?? observed;
  const life = useOfficeLife(dialogueRoom, liveCrew, talking?.npc_id || talking?.key || null, visibleBounds);
  const social = useMemo(() => {
    const held = new Set<string>(), partners = new Map<string, string>();
    if (talking) held.add(`${talking.roomId}:${talking.key}`);
    if (life.ambient && dialogueRoom) {
      const pair = life.ambient.participants.map(id => `${dialogueRoom}:${id}`);
      pair.forEach((key, index) => { held.add(key); if (!talking && pair[1-index]) partners.set(key, pair[1-index]); });
    }
    return { held, partners };
  }, [talking, life.ambient, dialogueRoom]);
  const crew = useCrew(crewSeeds, pos, false, route, liveCrew, social);
  /** 방별로 묶어 둔다 — 렌더와 근접 판정이 **같은 배열**을 본다. */
  const crewByRoom = useMemo(() => {
    const out = new Map<string, CrewMember[]>();
    crew.forEach((m) => {
      const list = out.get(m.roomId);
      if (list) list.push(m);
      else out.set(m.roomId, [m]);
    });
    return out;
  }, [crew]);

  useEffect(() => {
    const DIR: Record<string, [number, number]> = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
      W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
    };
    const typing = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node || !node.tagName) return false;
      const tag = node.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable;
    };
    const apply = () => {
      let x = 0;
      let y = 0;
      keys.current.forEach((k) => {
        const d = DIR[k];
        if (d) {
          x += d[0];
          y += d[1];
        }
      });
      setDrive(Math.sign(x), Math.sign(y));
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (lockRef.current) return; // 출근 연출 중에는 조작이 없다
      if (talkingRef.current) return; // 대화 중에는 상자가 키를 가져간다
      if (DIR[e.key]) {
        e.preventDefault(); // 방향키로 화면이 같이 스크롤되면 층이 흔들린다
        // 걷기 시작하면 자리 버튼에서 포커스를 놓는다.
        //
        // 방에 들어올 때 누른 버튼에 포커스가 남아 있으면, 걸어가서 누른 스페이스를
        // 브라우저가 **그 버튼의 클릭**으로 처리한다 — 동료에게 말을 걸려다 응시가
        // 시작돼 버린다. 걷는 동안의 스페이스는 세계의 것이고, Tab 으로 버튼에 닿은
        // 사람에게는 그대로 버튼의 것이다.
        const active = document.activeElement as HTMLElement | null;
        if (active && active.closest(".office-viewport") && active.tagName === "BUTTON") {
          active.blur();
        }
        if (!keys.current.has(e.key)) {
          keys.current.add(e.key);
          leavingRef.current = false; // 손으로 몰기 시작하면 나가기 연출은 끝 — 다시 방에 들어가면 들어간 것이다
          apply();
          // 끌어 옮겨 둔 시점은 걷기 시작하면 아바타에게 미끄러져 돌아온다(배율은 그대로)
          if (freeRef.current) {
            camKick.current = { kind: "glide", dur: CAM_RECENTER_MS };
            setFree(null);
          }
        }
        return;
      }
      // 확대·축소·원래대로 — 마우스 없이도(휠·끌기와 같은 일)
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomRef.current(ZOOM_STEP); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomRef.current(1 / ZOOM_STEP); return; }
      if (e.key === "0") { e.preventDefault(); resetRef.current(); return; }
      if (e.key === "Enter" || e.key === " ") {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === "BUTTON" || active.tagName === "A")) return;
        // 자리가 먼저다(위 근접 판정이 이미 그렇게 계산한다 — 자리 사거리 안이면
        // nearPerson 이 비어 있다). 그래서 여기서는 순서만 지키면 된다.
        if (nearRef.current) {
          e.preventDefault();
          onStart(nearRef.current);
          return;
        }
        if (nearPersonRef.current) {
          e.preventDefault();
          keys.current.clear(); setDrive(0, 0); stop();
          setTalking({ ...nearPersonRef.current.c, roomId: nearPersonRef.current.roomId });
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!keys.current.has(e.key)) return;
      keys.current.delete(e.key);
      apply();
    };
    const clear = () => {
      keys.current.clear();
      setDrive(0, 0);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [setDrive, onStart]);

  /** 걷다 보면 방에 들어가고, 자리 앞에 서면 그 자리가 골라진다.
   *  누르지 않아도 되는 것이 이 조작의 요점이다. */
  useEffect(() => {
    const here = roomAt(pos.x, pos.y, floor);
    if (leavingRef.current) {
      // 걸어 나가는 중 — 방 안이어도 들어가지 않는다. 복도에 닿거나 멈추면 끝.
      if (!here || !walking) leavingRef.current = false;
      else {
        nearRef.current = null;
        setNearPerson(null);
        return;
      }
    }
    // 자리를 눌러 그 방으로 걸어가는 중에는 아직 복도에 있어도 방을 유지한다.
    // 위치만 보고 판정하면 걷는 내내 입장이 취소되어, 도착할 때까지 두 번째 누름이
    // 먹지 않는다.
    if (!here && walking) return;
    if ((here?.id ?? null) !== entered) {
      setEnteredAnimated(here?.id ?? null);
      if (here) {
        const count = byRoom.map.get(here.id)?.length ?? 0;
        onAnnounce(
          count === 0
            ? `${here.label}에 들어왔습니다. 배정된 시험이 없습니다.`
            : `${here.label}에 들어왔습니다. 시험 ${count}개가 있습니다.`,
        );
      } else {
        onAnnounce("복도로 나왔습니다.");
      }
    }
    if (!here) {
      nearRef.current = null;
      setNearPerson(null);
      setPeeked((prev) => (prev && !keys.current.size ? prev : null));
      return;
    }
    const layout = layouts.get(here.id);
    const list = byRoom.map.get(here.id) ?? [];
    let found: MyAssignment | null = null;
    if (layout && list[0]) {
      // 스탠딩 데스크 앞에 서면 시작할 수 있다 — 발끝이 책상 앞 칸 근처일 때
      const st = layout.start.stand;
      if (Math.hypot(pos.x - st.x, pos.y - st.y) < 52) found = list[0];
    }
    nearRef.current = found;
    setPeeked((prev) => (prev?.assessment_id === found?.assessment_id ? prev : found));

    // 말 걸 수 있는 사람.
    //
    // 사거리는 넉넉하게(96px) — 하이 테이블 건너편 사람에게도 말을 걸 수 있어야 한다.
    //
    // 대신 **시작 지점이 우선**이다. 스탠딩 데스크 앞에 서 있을 때는 옆 사람이 사거리
    // 안이어도 스페이스가 '업무 시작'이어야 한다 — 응시를 시작하려던 손이 헛돌면 안 된다.
    let close: { c: OfficeColleague; x: number; y: number; roomId: string } | null = null;
    if (!found) {
      let best = 96;
      (crewByRoom.get(here.id) ?? []).forEach((m) => {
        const d = Math.hypot(pos.x - m.x, pos.y - m.y);
        if (d < best) {
          best = d;
          close = { c: m.c, x: m.x, y: m.y, roomId: m.roomId };
        }
      });
    }
    setNearPerson((prev) => (prev?.c.key === (close as typeof close)?.c.key ? prev : close));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, walking, floor, layouts, byRoom, crewByRoom]);

  // Esc 는 두 단계다. 먼저 이름표를 접고, 그 다음에 복도로 나간다 — 떠 있는 정보를
  // 포커스를 옮기지 않고 닫을 수 있어야 한다는 요구(WCAG 1.4.13)를 이렇게 만족시킨다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || lockRef.current) return;
      if (peeked) {
        setPeeked(null);
        return;
      }
      if (entered) leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entered, peeked, leave]);

  const room = entered ? roomOf.get(entered) ?? null : null;
  // 자리가 눌리지 않을 만큼(WCAG 24px) 작아지지는 않는다. 층이 화면보다 커지면 줄이는
  // 대신 **카메라가 아바타를 따라간다** — 좁은 화면에서도 목록으로 도망가지 않는다.
  // 쉬는 배율은 한 칸이 기기 픽셀 정수가 되게 끊는다 — 픽셀 아트를 소수 배율로 늘리면 칸 경계마다 실금이 생기고, 카메라가
  // 움직일 때마다 그 자리가 바뀌어 배경이 떨린다. 카메라 이동도 기기 픽셀 단위로 끊는다(아래 camX).
  const unit = TILE * dpr;
  /** 기본 배율 — 층이 화면에 들어오게(너무 작아지면 따라가기로), 방에 들어가면 당긴다. 사용자 확대는 여기에 곱한다. */
  const baseRaw = Math.max(fit, MIN_SPATIAL_FIT) * (room ? ZOOM_IN : 1);
  const entranceBoost = entranceCam ? Math.max(1, ENTRANCE_SCALE / baseRaw) : 1;
  const scaleT = snapScale(baseRaw * userZoom * entranceBoost, unit);
  const view: View = { w: viewSize.w || floor.world.width * scaleT, h: viewSize.h || floor.world.height * scaleT };
  // 따라가기 초점 — 방에 들어가 있으면 방(방이 화면보다 크면 방 안에서 아바타를), 복도면 층(층이 화면보다 크면 아바타)
  const halfWT = view.w / scaleT / 2, halfHT = view.h / scaleT / 2;
  const followX = room
    ? room.w * scaleT <= view.w + 1 ? room.x + room.w / 2 : room.x + clampAxis(pos.x - room.x, halfWT, room.w)
    : floor.world.width * scaleT <= view.w + 1 ? floor.world.width / 2 : pos.x;
  const followY = room
    ? room.h * scaleT <= view.h + 1 ? room.y + room.h / 2 : room.y + clampAxis(pos.y - room.y, halfHT, room.h)
    : floor.world.height * scaleT <= view.h + 1 ? floor.world.height / 2 : pos.y;
  // 카메라를 층 안에 가둔다. 가두지 않으면 가장자리 방에 들어갔을 때 화면 절반이
  // 건물 바깥의 빈 어둠이 된다 — 방에 들어간 게 아니라 떨어진 것처럼 보인다.
  // 다만 손이 쥐고 있는 동안은 예외다: 끄는 중에는 가장자리 너머로 고무줄처럼 버티며 따라오고, 커서를 붙잡은 확대가
  // 도는 동안은 붙잡은 점을 지킨다. 손을 놓거나 확대가 끝나면 아래 settle 이 범위로 되돌린다.
  const anchoring = camKick.current?.kind === "anchor" || tweenRef.current?.kind === "anchor";
  const targetFocus = entranceCam
    ? clampFocus(floor.gate.x, floor.corridorY, scaleT, view, floor.world)
    : free && panning
      ? rubberFocus(free.fx, free.fy, scaleT, view, floor.world)
      : free && anchoring
        ? free
        : clampFocus(free?.fx ?? followX, free?.fy ?? followY, scaleT, view, floor.world);
  const target: Cam = { s: scaleT, fx: targetFocus.fx, fy: targetFocus.fy };

  // ── 보이는 카메라 — 목표로 곧장 가거나(걷기·끌기), 옮기기 중이면 그 사이의 한 점 ──
  const [, setCamTick] = useState(0);
  const kick = camKick.current;
  if (kick) {
    camKick.current = null;
    const from = shownRef.current;
    tweenRef.current =
      from && !reducedMotion.current && kick.dur > 0
        ? { from, to: target, t0: performance.now(), dur: kick.dur, kind: kick.kind, anchor: kick.anchor }
        : null;
  }
  const tween = tweenRef.current;
  let shown: Cam = target;
  if (tween) {
    tween.to = target; // 옮기는 동안 아바타가 걸으면 목표가 따라온다(진행도는 그대로)
    const step = tweenAt(tween, performance.now(), view);
    shown = step.cam;
    if (step.done) tweenRef.current = null;
  }
  shownRef.current = shown;
  const moving = tweenRef.current !== null;
  // 옮기는 동안 매 프레임 다시 그린다 — 끝나면 멈춘다
  const camLoop = useRef(0);
  useEffect(() => {
    if (!tweenRef.current || camLoop.current) return;
    const loop = () => {
      camLoop.current = 0;
      setCamTick((t) => t + 1);
      if (tweenRef.current) camLoop.current = requestAnimationFrame(loop);
    };
    camLoop.current = requestAnimationFrame(loop);
  });
  useEffect(() => () => cancelAnimationFrame(camLoop.current), []);
  // settle — 손을 놓았고 옮기기도 끝났는데 자유 시점이 범위 밖이면(가장자리에서 붙잡은 확대가 끝난 자리) 범위로 미끄러뜨린다
  useEffect(() => {
    if (!free || panning || tweenRef.current || camKick.current) return;
    const c = clampFocus(free.fx, free.fy, scaleT, view, floor.world);
    if (Math.abs(c.fx - free.fx) * scaleT < 0.5 && Math.abs(c.fy - free.fy) * scaleT < 0.5) return;
    camKick.current = { kind: "glide", dur: CAM_SETTLE_MS };
    setFree(c);
  });

  const scale = shown.s;
  // 월드와 이름표 레이어가 **같은 문자열**을 쓴다. 투영을 두 번 구현하면 반드시 어긋난다.
  // 원점(0,0)을 기준으로 배율을 걸고, 화면 가운데(하단 바 제외)에 초점이 오도록 하는 이동을 **기기 픽셀**로 끊어 적는다 —
  // 뷰포트 요소의 소수 픽셀 위치까지 빼서 월드 원점이 기기 픽셀에 앉게 한다. 쉬는 배율에서는 칸(48px)이 기기 픽셀 정수이므로
  // 모든 타일 경계가 정수에 떨어지고, 이동해도 그 사실이 변하지 않는다(실금·떨림 없음).
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const camX = snap(view.w / 2 - scale * shown.fx) - originFrac.x;
  const camY = snap(view.h / 2 - scale * shown.fy) - originFrac.y;
  visibleBounds.current = { left: -camX/scale, right: (view.w-camX)/scale,
    top: -camY/scale, bottom: (view.h-camY)/scale };
  useEffect(() => {
    if (entranceLock) { setObserved(null); return; }
    const observe = () => setObserved(previous => observedRoom(liveCrew.current.map(a => ({
      id: a.c.npc_id || a.c.key, roomId: a.roomId, x: a.x, y: a.y,
    })), visibleBounds.current, previous));
    observe();
    const timer = setInterval(observe, 1500);
    return () => clearInterval(timer);
  }, [entranceLock, floor]);
  const camera = `translate(${camX}px, ${camY}px) scale(${scale})`;
  // will-change: transform 은 쓰지 않는다 — 층 레이어가 통째로 합성 레이어가 되어(월드 3000×1200 × 기기 배율)
  // GPU 가 없는 환경에서는 래스터만으로 화면이 멈춘다(2026-09-13 실측: 사무실 화면이 아예 그려지지 않았다).
  const camStyle: React.CSSProperties = { width: floor.world.width, height: floor.world.height, left: 0, top: 0, transformOrigin: "0 0", transform: camera, transition: "none" };
  /** 캔버스 카메라 — 같은 투영을 **기기 픽셀 정수**로. 월드 x 는 캔버스에서 round(x·k) + camOX 에 놓인다(OfficeCanvas 머리말). */
  const camK = scale * dpr;
  const camOX = Math.round((camX + originFrac.x) * dpr);
  const camOY = Math.round((camY + originFrac.y) * dpr);
  /** 옮기는 중이면 캔버스가 구워 둘 배율 — 출발·목표 중 작은 쪽. 보이는 넓이가 화면만 하므로 굽는 양이 한정된다. */
  const camBakeK = moving && tween ? Math.min(snapScale(tween.from.s, unit), scaleT) * dpr : undefined;

  // ── 시점 조작 ──
  // 처리기는 한 번만 달고, 지금의 카메라 셈 재료는 여기서 읽는다
  const camCtx = useRef({ view, world: floor.world, baseRaw, unit, scaleT });
  camCtx.current = { view, world: floor.world, baseRaw, unit, scaleT };

  /** 확대·축소 — 화면 점 (sx, sy) 밑의 월드 점을 붙잡은 채로. 점이 없으면 화면 가운데. 확대한 뒤로는 시점이 자유다(걸으면 돌아온다). */
  const zoomBy = useCallback((factor: number, sx?: number, sy?: number) => {
    const cam = shownRef.current;
    if (!cam) return;
    const { view: v, world, baseRaw: base, unit: u } = camCtx.current;
    const z0 = userZoomRef.current;
    const z1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z0 * factor));
    if (Math.abs(z1 - z0) < 1e-6) return;
    const s1 = snapScale(base * z1, u);
    const ax = sx ?? v.w / 2, ay = sy ?? v.h / 2;
    const w = worldAt(cam, v, ax, ay);
    const keep = focusKeeping(w.x, w.y, ax, ay, s1, v);
    camKick.current = { kind: "anchor", dur: CAM_ZOOM_MS, anchor: { sx: ax, sy: ay, wx: w.x, wy: w.y } };
    userZoomRef.current = z1;
    setUserZoom(z1);
    // 가두지 않는다 — 확대가 도는 동안 커서 밑을 지키고, 끝난 뒤 범위 밖이면 settle 이 되돌린다
    void world;
    setFree(keep);
  }, []);
  /** 원래대로 — 기본 배율, 따라가기(키 0) */
  const resetView = useCallback(() => {
    camKick.current = { kind: "glide", dur: CAM_RECENTER_MS };
    userZoomRef.current = 1;
    setUserZoom(1);
    setFree(null);
  }, []);
  /** 배율만 원래대로 — 화면 가운데를 붙잡고(보던 곳을 잃지 않게) */
  const resetZoom = useCallback(() => zoomBy(1 / userZoomRef.current), [zoomBy]);
  /** 시점만 원래대로 — 방이면 방, 아니면 아바타를 다시 따라간다(배율은 그대로) */
  const recenter = useCallback(() => {
    camKick.current = { kind: "glide", dur: CAM_RECENTER_MS };
    setFree(null);
  }, []);
  zoomRef.current = zoomBy;
  resetRef.current = resetView;

  // 휠 — 커서 밑을 붙잡고 확대·축소. 트랙패드 핀치는 ctrlKey 가 붙은 작은 휠로 온다(더 민감하게). 페이지는 같이 스크롤되지 않는다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (lockRef.current) return;
      if ((e.target as HTMLElement | null)?.closest?.("[data-office-ui], .talk-wrap")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const perUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const factor = Math.exp(-e.deltaY * perUnit * (e.ctrlKey ? 0.012 : 0.0016));
      zoomRef.current(factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 끌기 — 누른 채 움직이면 시점이 손을 따라온다(층 밖으로는 못 간다). 짧게 누르면 예전처럼 누름이다.
  const drag = useRef<{ id: number; x: number; y: number; fx: number; fy: number; s: number; moved: boolean; trail: { t: number; fx: number; fy: number }[] } | null>(null);
  const swallowClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary || lockRef.current) return;
    if ((e.target as HTMLElement).closest("[data-office-ui], .talk-wrap")) return;
    const cam = shownRef.current;
    if (!cam) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, fx: cam.fx, fy: cam.fy, s: camCtx.current.scaleT, moved: false, trail: [] };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
      d.moved = true;
      // 옮기던 카메라(확대·관성)는 손이 잡는 순간 멈춘다. 누른 자리부터 움직인 만큼 곧바로 따라온다 — 문턱(5px)도 이동에 넣는다.
      if (tweenRef.current) {
        const cam = shownRef.current;
        tweenRef.current = null;
        if (cam) Object.assign(d, { fx: cam.fx + (e.clientX - d.x) / d.s, fy: cam.fy + (e.clientY - d.y) / d.s });
      }
      setPanning(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 이미 놓았다 */ }
    }
    // 손이 간 만큼 그대로 적어 둔다 — 가장자리 너머는 target 이 고무줄로 누그러뜨리고, 놓으면 settle 이 되돌린다
    const raw = { fx: d.fx - (e.clientX - d.x) / d.s, fy: d.fy - (e.clientY - d.y) / d.s };
    // 관성에 쓸 최근 궤적(100ms)
    const now = performance.now();
    d.trail.push({ t: now, fx: raw.fx, fy: raw.fy });
    while (d.trail.length > 2 && now - d.trail[0].t > 100) d.trail.shift();
    setFree(raw);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    // 끌기가 끝난 자리의 클릭(방 들어가기·자리 누르기)은 삼킨다
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 이미 놓았다 */ }
    // 관성 — 빠르게 밀고 놓으면 그 방향으로 조금 더 미끄러진다(멈췄다 놓으면 그대로)
    const a = d.trail[0], b = d.trail[d.trail.length - 1];
    const dt = b && a ? b.t - a.t : 0;
    const { view: v, world } = camCtx.current;
    const go = !reducedMotion.current && dt > 16 && performance.now() - b.t < 80
      ? coastFocus(b.fx, b.fy, (b.fx - a.fx) / dt, (b.fy - a.fy) / dt, d.s)
      : null;
    // 놓은 자리가 가장자리 너머면(고무줄로 끈 자리) 범위로, 빠르게 밀었으면 그 방향으로 조금 더 — 어느 쪽이든 범위 안에서 멈춘다
    const end = go ?? freeRef.current;
    if (end) {
      const c = clampFocus(end.fx, end.fy, d.s, v, world);
      camKick.current = { kind: go ? "coast" : "glide", dur: go ? CAM_COAST_MS : CAM_SETTLE_MS };
      setFree(c);
    }
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const zoomPct = Math.round(userZoom * 100);
  const rowOfCrew = useCallback((m: CrewMember) => rowFor(m.c), []);
  const myRow = useMemo(() => rowFor({ key: seed, avatar_preset: avatarPreset }), [seed, avatarPreset]);

  /** 방의 불이 켜지는 순서. 문에서 가까운 방부터 번진다 */
  const lightDelay = (r: Room) =>
    Math.round(
      ENTRANCE_LIGHT_BASE_MS +
        (Math.hypot(r.x + r.w / 2 - floor.gate.x, r.y + r.h / 2 - floor.gate.y) / Math.max(1, floor.world.width)) * ENTRANCE_LIGHT_SPREAD_MS,
    );

  const sectors = floor.rooms.map((r) => (
    <Sector
      key={r.id}
      layout={layouts.get(r.id) as RoomLayout}
      label={r.label}
      assignments={byRoom.map.get(r.id) ?? []}
      entered={entered === r.id}
      busyId={busyId}
      onEnter={() => enter(r.id)}
      onStart={onStart}
      onPeek={setPeeked}
    />
  ));

  const peekedArmed = Boolean(
    peeked && entered && (byRoom.map.get(entered) ?? []).some((a) => a.assessment_id === peeked.assessment_id),
  );

  return (
    <div
      className="office-viewport"
      ref={viewportRef}
      style={OFFICE_ASSET_VARS as React.CSSProperties}
      data-panning={panning ? "true" : undefined}
      data-talking={talking ? "true" : undefined}
      data-camera={moving ? "moving" : "still"}
      data-entrance={entranceLock ? "true" : undefined}
      data-lite={lite ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
    >
      {/* 0~3. 층 그림 — 복도·방 바닥·조명·벽·벽걸이·소품·시작 책상·동료·나를 캔버스 한 장에 기기 픽셀 정수로 그린다.
             DOM 으로 두면 브라우저가 레이어마다 소수 픽셀을 다르게 반올림해 사람이 움직일 때 벽·소품이 1px 씩 튄다. */}
      <OfficeCanvas
        floor={floor}
        layouts={layouts}
        byRoom={byRoom}
        entered={entered}
        peekedId={peeked?.assessment_id ?? null}
        live={liveCrew}
        rowOf={rowOfCrew}
        player={{ x: pos.x, y: pos.y + TILE / 2, dir: myDir, pose: walking ? myPose : "idle", row: myRow }}
        viewW={viewSize.w}
        viewH={viewSize.fullH}
        dpr={dpr}
        originFrac={originFrac}
        k={camK}
        ox={camOX}
        oy={camOY}
        bakeK={camBakeK}
        lite={lite}
        onSlow={goLite}
      />

      {/* 4. 상호작용 — 방 영역과 자리 버튼(투명). 그림은 캔버스가 그린다. */}
      <div className="office-world office-layer-zones" style={camStyle}>
        {sectors}
      </div>

      {/* 5. 출근의 어둠 — 방마다 한 장씩 덮어 두었다가 문에서 가까운 순서로 걷는다. 끝나면 내린다. */}
      {veil && (
        <div className="office-world office-veil" style={camStyle} data-lit={lit ? "true" : undefined} aria-hidden="true">
          <div className="office-veil-void" style={{ left: 0, top: 0, width: floor.world.width, height: floor.world.height }} />
          <div
            className="office-veil-room"
            data-corridor="true"
            style={{ left: floor.corridor.left, top: floor.corridor.top, width: floor.corridor.right - floor.corridor.left, height: floor.corridor.bottom - floor.corridor.top }}
          />
          {floor.rooms.map((r) => (
            <div key={r.id} className="office-veil-room" style={{ left: r.x, top: r.y, width: r.w, height: r.h, animationDelay: `${lightDelay(r)}ms` }} />
          ))}
        </div>
      )}
      {entranceLock && <div className="office-entrance-shield" data-office-ui aria-hidden="true" />}

      {/* 7. 글자 레이어 — 카메라를 같이 타되 배율은 되돌린다.
             월드 안에 글자를 두면 층 배율만큼 작아져 읽을 수 없다. */}
      <div
        className="office-labels"
        style={{ ...camStyle, ["--cam-scale" as string]: String(scale) }}
        aria-hidden="true"
      >
        {peeked && (
          <Nameplate assignment={peeked} layouts={layouts} byRoom={byRoom} actor={pos} />
        )}
        {/* 내 아바타 표식 — 사무실에는 같은 그림의 동료가 스무 명 넘게 서 있어서, 표시가
            없으면 방향키를 눌러 보기 전에는 어느 쪽이 나인지 알 수 없다. */}
        {myName && !entranceLock && (
          <span className="office-me" style={{ left: pos.x, top: pos.y + TILE / 2 - PERSON_H - 4 }}>
            <span className="office-me-pill">{myName}</span>
          </span>
        )}
      </div>

      {!entranceLock && <SpeechBubble events={!talking && life.world?.assessment_id === dialogueRoom ? life.events : []} crew={crew} roomId={dialogueRoom}
        pendingSpeakerId={talking ? (replyPending ? talking.npc_id || talking.key : null) :
          life.ambient && ["queued", "generating"].includes(life.ambient.status) ? life.ambient.participants[0] : null}
        camera={{ x: camX, y: camY, scale, width: view.w, height: view.h }} />}
      {nearPerson && !talking && <button type="button" className="office-talk-action" data-office-ui
        style={{ left: Math.max(80, Math.min(view.w-80, nearPerson.x*scale+camX)), top: Math.max(48, (nearPerson.y+12)*scale+camY) }}
        onClick={() => { keys.current.clear(); setDrive(0, 0); stop(); setTalking({ ...nearPerson.c, roomId: nearPerson.roomId }); }}>
        {nearPerson.c.name}에게 말걸기 <kbd>Enter</kbd>
      </button>}

      {/* 8. 화면에 붙는 것들 — 배율을 타지 않는다 */}
      <div className="office-breadcrumb" data-office-ui>
        <span>사무실</span>
        {entered && (
          <>
            <span className="office-breadcrumb-sep">›</span>
            <span className="office-breadcrumb-here">{labelOf(entered)}</span>
            <button type="button" className="office-breadcrumb-out" onClick={leave}>
              복도로 나가기 <kbd>Esc</kbd>
            </button>
          </>
        )}
      </div>

      {talking && <TalkBox key={`${talking.roomId}:${talking.key}`} colleague={talking}
        worldId={life.world?.assessment_id === talking.roomId ? life.world.id : null} tabId={life.tabId}
        events={life.events} connectionError={life.error} onEvents={life.receive} onClose={() => setTalking(null)} onBusyChange={setReplyPending} />}

      {/* 9. 시점 — 휠·끌기와 같은 일을 버튼으로도(마우스가 없거나 휠이 낯선 사람). 키보드: + − 0 */}
      {!talking && <div className="office-zoom" data-office-ui role="group" aria-label="시점 조작">
        <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={userZoom <= ZOOM_MIN + 1e-6} title="축소 (−)" aria-label="축소">
          <IconZoomOut size={15} />
        </button>
        <button type="button" className="office-zoom-level" onClick={resetZoom} disabled={Math.abs(userZoom - 1) < 1e-6} title="원래 배율로" aria-label={`지금 배율 ${zoomPct}% — 원래 배율로`}>
          {zoomPct}%
        </button>
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={userZoom >= ZOOM_MAX - 1e-6} title="확대 (+)" aria-label="확대">
          <IconZoomIn size={15} />
        </button>
        <span className="office-zoom-sep" aria-hidden="true" />
        <button type="button" onClick={recenter} disabled={!free} title="내 위치로 (0 = 배율까지 원래대로)" aria-label="시점을 내 위치로">
          <IconRecenter size={15} />
        </button>
      </div>}

      <div className="office-bar" data-office-ui>
        <div className="office-legend" aria-hidden="true">
          <span className="office-legend-keys">
            <kbd>←</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <kbd>→</kbd>
            이동
          </span>
          <span className="office-legend-hint">끌기 · 휠로 둘러보기</span>
          <span>
            <i className="office-legend-dot" data-state="open" /> 시작 전
          </span>
          <span>
            <i className="office-legend-dot" data-state="resume" /> 응시 중
          </span>
          <span>
            <i className="office-legend-dot" data-state="done" /> 완료
          </span>
        </div>

        <div className="office-bar-detail">
          {peeked ? (
            <>
              <b>{peeked.title}</b>
              <span>
                시나리오 {peeked.scenario_count}개 · {peeked.duration_min}분
              </span>
            </>
          ) : entered ? (
            // 방에 들어서면 **누가 있는지** 알려 준다. 이 사람들이 곧 메신저에서
            // 말을 걸 상대다 — 이름을 미리 보는 것이 이 화면의 쓸모다.
            (() => {
              const crew = byRoom.map.get(entered)?.[0]?.colleagues ?? [];
              if (!crew.length) return <span>{roomOf.get(entered)?.label ?? ""}</span>;
              return (
                <>
                  <b>{roomOf.get(entered)?.label ?? ""}</b>
                  <span>
                    {crew.length}명이 일하고 있습니다 —{" "}
                    {crew.map((c) => (c.role ? `${c.name}(${c.role})` : c.name)).join(", ")}
                  </span>
                </>
              );
            })()
          ) : (
            <span>맡을 업무를 고르세요. 방향키로 움직이고, 노트북이 놓인 스탠딩 데스크 앞에 서면 시작됩니다.</span>
          )}
        </div>

        {peeked && (
          <button
            type="button"
            className="office-bar-action"
            disabled={busyId === peeked.assessment_id}
            onClick={() => {
              const home = peeked.assessment_id;
              if (peekedArmed) onStart(peeked);
              else if (roomOf.has(home)) enter(home);
            }}
          >
            {busyId === peeked.assessment_id ? "준비 중..." : deskAction(peeked, peekedArmed)}
            <kbd>Enter</kbd>
          </button>
        )}
      </div>

    </div>
  );
}



function rect(r: { x: number; y: number; w: number; h: number }) {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

/** 시험에 정해진 장면 — 관리자 프리셋(JSON)이면 검증해서, 기본 장면 참조면 코드에서, 없으면 null(분야에서 고른다). */
function sceneOfAssignment(a: MyAssignment, builtins?: BuiltinOverrides): SceneSpec | null {
  if (a.office_scene) {
    const ok = safeScene(a.office_scene);
    if (ok) return ok;
  }
  const ref = a.office_preset ?? "";
  if (ref.startsWith("builtin:")) {
    const id = ref.slice("builtin:".length);
    if (isBuiltinScene(id)) return builtins?.[id] ?? SCENES[id];
  }
  return null;
}

/** 지금 보고 있는 자리 하나에만 뜨는 이름표.
 *  자리마다 붙이면 그건 다시 카드 격자다. 한 번에 하나가 규칙이다. */
function Nameplate({
  assignment,
  layouts,
  byRoom,
  actor,
}: {
  assignment: MyAssignment;
  layouts: Map<string, RoomLayout>;
  byRoom: { map: Map<string, MyAssignment[]> };
  /** 아바타 위치. 이름표가 사람을 가리지 않도록 위아래를 뒤집는 데 쓴다. */
  actor: { x: number; y: number };
}) {
  const home = assignment.assessment_id;
  const layout = layouts.get(home);
  if (!layout) return null;
  const list = byRoom.map.get(home) ?? [];
  const slot = layout.start;
  if (!slot) return null;
  // 자리 위쪽에 서 있으면 이름표를 아래로 뒤집는다. 자리에 섰는데 자기 모습이
  // 이름표에 가려지면, 어디에 서 있는지 알 수 없다.
  const below = actor.y < slot.y + TILE / 2;
  return (
    <span
      className="office-plate"
      data-below={below ? "true" : undefined}
      // 위에 띄울 때는 책상 **그림** 위로 — 발자국 줄 위에 띄우면 솟은 모니터를 덮는다
      style={{ left: slot.x + TILE, top: below ? slot.y + TILE + 26 : slot.y + TILE - S.standDesk.h - 6 }}
    >
      <b className="office-plate-title">{assignment.title}</b>
      <span className="office-plate-meta">
        시나리오 {assignment.scenario_count}개 · {assignment.duration_min}분
      </span>
    </span>
  );
}
