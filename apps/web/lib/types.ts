// ── 공통 ─────────────────────────────────────────────────────

/** demo_admin = 관리 화면을 읽기만 하는 둘러보기 계정 (서버 demo.py). 배정·응시가 없다. */
export type Role = "admin" | "evaluator" | "candidate" | "guest" | "demo_admin";

/** 관리자가 직접 부여할 수 있는 역할 — guest 는 게스트 로그인만이 만든다 */
export type AssignableRole = Exclude<Role, "guest" | "demo_admin">;

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  /** 게스트 계정이 만들어진 주소 (일반 계정은 null) */
  created_ip?: string | null;
  /** 사무실의 내 아바타 프리셋 id. 비어 있으면 계정 id 에서 정한다. */
  avatar_preset?: string;
  created_at: string;
}

/** GET /auth/guest — 게스트 버튼을 띄울지, 고를 수 있는 분야가 무엇인지 */
export interface GuestExam {
  assessment_id: string;
  /** 분야 안에서 이 시험을 가르는 꼬리표 */
  label: string;
  title: string;
  /** 상황을 말하는 한 줄 — 숨은 요구는 담지 않는다 */
  pitch: string;
  difficulty: string;
  duration_min: number;
}

export interface GuestAvailability {
  enabled: boolean;
  categories: { key: string; label: string; count: number; exams: GuestExam[] }[];
  /** 관리 화면 둘러보기(읽기 전용) 버튼을 띄울지 */
  admin_demo: boolean;
}

/** 이 브라우저가 이어 할 것 — 로그인 화면이 [이어하기] 를 먼저 내놓을지 정한다 (api: /auth/resume) */
export interface Resume {
  name: string;
  role: Role | "";
  home: string;
  attempt_id: string | null;
  assessment_title: string;
  deadline_at: string | null;
}

// ── 게스트 접속 ──────────────────────────────────────────────

export interface GuestPolicy {
  enabled: boolean;
  /** 로그인 화면의 [관리자 기능 살펴보기] — 게스트 응시와 별개 스위치 */
  admin_demo_enabled: boolean;
  max_new_per_hour_per_ip: number;
  chat_per_min: number;
  chat_total_per_attempt: number;
  /** 게스트가 제출하면 자동 채점을 걸어 결과를 보여 줄지 */
}

export interface GuestStats {
  total: number;
  active: number;
  last_24h: number;
  blocked_entries: number;
}

export interface BlockedIp {
  id: string;
  cidr: string;
  reason: string;
  created_at: string;
}

// ── 시나리오 ─────────────────────────────────────────────────

export interface Character {
  npc_id?: string | null;
  office_voice?: string;
  office_max_conversations?: number;
  key: string;
  name: string;
  role: string;
  color: string;
  persona: string;
  knowledge: string;
  /** 고른 도트·초상 프리셋 id. 비우면 인물 키에서 자동으로 정해진다. */
  avatar_preset?: string;
  /** "" | "female" | "male" — 자동 배정 시 맞는 성별에서만 고른다. */
  gender?: string;
  /** 사무실에서 말을 걸었을 때의 한마디. */
  encounter?: string;
}

export interface OpeningMessage {
  character_key: string;
  content: string;
}

export interface InitialFile {
  path: string;
  content: string;
}

export type CheckType =
  | "file_exists"
  | "file_contains"
  | "file_not_contains"
  | "file_min_words"
  | "file_max_words"
  | "csv_cell"
  | "csv_row_count"
  | "csv_column_sum"
  | "csv_column_unique"
  | "command";

export interface Check {
  label: string;
  type: CheckType;
  path?: string | null;
  pattern?: string | null;
  command?: string | null;
  expected_stdout?: string | null;
  /** csv_cell / csv_column_sum / csv_column_unique — 값을 읽을 열 이름 */
  column?: string | null;
  /** csv_* — 행 조건 "열이름=값" (csv_cell 은 첫 일치 행, 나머지는 일치 행 전체) */
  row_match?: string | null;
  /** csv_cell(칸 값) / csv_row_count(행 수) / csv_column_sum(합계) 의 기대값 */
  expected?: string | null;
  /** csv_cell / csv_column_sum — 숫자 비교 허용 오차 */
  tolerance?: number | null;
  /** file_min_words — 최소 단어 수 */
  min_count?: number | null;
  /** file_max_words — 최대 단어 수 */
  max_count?: number | null;
  points: number;
}

/** 시험 데스크톱에서 시나리오별로 켜고 끌 수 있는 앱 (빈 배열 = 전부 제공) */
export type DesktopAppId =
  | "terminal"
  | "files"
  | "mail"
  | "docs"
  | "sheet"
  | "ide"
  | "github";

export interface RubricItem {
  name: string;
  points: number;
  desc: string;
}

export interface Rubric {
  process_weight: number;
  result_weight: number;
  process: RubricItem[];
  result: RubricItem[];
}

export interface ScenarioSummary {
  id: string;
  title: string;
  summary: string;
  difficulty: string;
  character_count: number;
  check_count: number;
  agent_enabled: boolean;
  is_archived: boolean;
  updated_at: string;
}

export interface OfficePublic {
  published: boolean; setting: string;
  facts: { id: string; text: string }[];
  topics: { id: string; intent: string; fact_ids: string[]; kind?: "scenario" | "daily" }[];
}

export interface Scenario {
  office_public?: OfficePublic;
  id: string;
  title: string;
  summary: string;
  difficulty: string;
  briefing_md: string;
  characters: Character[];
  opening_messages: OpeningMessage[];
  initial_files: InitialFile[];
  objectives_md: string;
  /** 이 시나리오의 NPC 기본 규칙(영문). 비어 있으면 전역 기본 */
  npc_base_prompt?: string;
  checks: Check[];
  rubric: Rubric;
  agent_enabled: boolean;
  /** 이 시나리오에서 제공할 앱 (빈 배열 = 전부) */
  desktop_apps?: DesktopAppId[];
  /** 명령 하나의 제한 시간(초). 0 이면 전역 기본(30초) */
  run_timeout_s?: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

// ── 시험 ─────────────────────────────────────────────────────

export interface AssessmentSummary {
  id: string;
  title: string;
  /** 분야 키 (lib/categories). "" 는 미분류. */
  category: string;
  duration_min: number;
  scenario_count: number;
  assignee_count: number;
  attempt_count: number;
  created_at: string;
}

export interface AssessmentScenarioRef {
  scenario_id: string;
  title: string;
  difficulty: string;
  ordinal: number;
  points: number;
}

export interface AssignmentRef {
  user_id: string;
  name: string;
  email: string;
}

export interface Assessment {
  id: string;
  title: string;
  label: string;
  description: string;
  category: string;
  /** 사무실 장면 참조 — "" 자동 · "builtin:<id>" · 프리셋 uuid */
  office_preset?: string;
  duration_min: number;
  agent_max_turns: number;
  /** NPC 에게 보낼 수 있는 메시지 총량. 0 이면 전역 기본 */
  messenger_max_per_attempt?: number;
  npc_provider_id: string | null;
  agent_provider_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  scenarios: AssessmentScenarioRef[];
  assignments: AssignmentRef[];
}

// ── 응시 ─────────────────────────────────────────────────────

export interface MyAssignment {
  assessment_id: string;
  title: string;
  description: string;
  /** 분야 키 — 상단 버튼 필터가 이 값으로 묶는다. "" 는 미분류. */
  category: string;
  /** 분야 안에서 가르는 꼬리표 — 화면에 `분야 [꼬리표]` 로 붙는다 */
  label: string;
  difficulty: string;
  duration_min: number;
  scenario_count: number;
  starts_at: string | null;
  ends_at: string | null;
  attempt_id: string | null;
  attempt_status: string | null;
  assigned: boolean;
  /** 이 시험의 방에 있는 동료(NPC). 이름표에 해당하는 것만 온다 —
   *  persona·knowledge 는 서버가 싣지 않는다 (schemas.OfficeColleague). */
  colleagues?: OfficeColleague[];
  /** 사무실 장면 참조 — "" 자동(분야에서 고름) · "builtin:<id>" 기본 장면 · uuid 관리자 프리셋 */
  office_preset?: string;
  /** 관리자 프리셋이면 그 장면(JSON, components/office/scenes.ts 의 SceneSpec 모양) */
  office_scene?: Record<string, unknown> | null;
}

/** 관리자가 만든 사무실 장면(프리셋) — spec 은 SceneSpec 모양의 JSON */
export interface OfficePreset {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** 관리자가 고친 템플릿(코드의 기본 장면) — id 는 템플릿 id. 목록에 없는 템플릿은 코드의 기본값 그대로다. */
export interface OfficeBuiltin {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  updated_at: string;
}

/** 분야별 기본 장면 — 분야 키 → 장면 참조("builtin:<id>" | uuid). 없으면 자동. */
export interface OfficeSettings {
  defaults: Record<string, string>;
}

/** 사무실 화면에 세우는 동료. 답이 될 수 있는 것은 여기 없다. */
export interface OfficeColleague {
  npc_id?: string;
  key: string;
  name: string;
  role?: string;
  color?: string;
  avatar_preset?: string;
  gender?: string;
  /** 사무실에서 말을 걸었을 때의 한마디. 비어 있으면 일반 인사말. */
  encounter?: string;
}

export interface AttemptCharacter {
  key: string;
  name: string;
  role: string;
  color: string;
  /** 고른 아바타 프리셋 id. 비어 있으면 인물 키로 정해진다. */
  avatar_preset?: string;
  /** 자동 배정 시 이 성별의 프리셋 중에서만 고른다. */
  gender?: string;
}

export interface AttemptScenario {
  scenario_id: string;
  title: string;
  briefing_md: string;
  ordinal: number;
  points: number;
  agent_enabled: boolean;
  /** 이 문제에서 열 수 있는 앱 (빈 배열 = 전부) */
  desktop_apps?: DesktopAppId[];
  characters: AttemptCharacter[];
  /** 순차 진행 상태 */
  status: "completed" | "in_progress" | "locked";
  unread: number;
}

export interface Attempt {
  id: string;
  assessment_id: string;
  assessment_title: string;
  status: "in_progress" | "submitted" | "expired";
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  agent_max_turns: number;
  current_ordinal: number;
  /** 관리자가 얹어 준 보정 (질문 추가·시간 연장) */
  grants?: AttemptGrants | null;
  /** 시네마틱 인트로(게이미피케이션) 사용 여부 */
  gamified_intro: boolean;
  scenarios: AttemptScenario[];
}

// ── 메신저 / 에이전트 ────────────────────────────────────────

export interface MessengerMessage {
  social?: string;
  id: string;
  character_key: string;
  sender: "candidate" | "npc";
  content: string;
  /** 서버가 공개한 것만 (ODY-022). error 가 있으면 인물의 대사가 아니라 시스템 실패다. */
  meta?: AiErrorMeta;
  created_at: string;
}

export interface AiErrorMeta {
  error?: string;
  error_message?: string;
  correlation_id?: string;
  /** 서버가 기록할 때 이 질문을 돌려주었는가 — 화면은 이 값만 믿고 안내한다 */
  refunded?: boolean;
}

export interface AttemptGrants {
  agent_turns: number;
  messenger_turns: number;
  extra_minutes: number;
  /** 마지막 보정 시각 — 화면이 "새로 받은 보정인가" 를 이걸로 판단한다 */
  at: string;
}

/** 메신저 질문 잔여량 — 에이전트와 같은 모양 */
export interface MessengerUsage {
  used: number;
  max: number;
  remaining: number;
  refunded?: number;
  /** 이 수가 메신저와 에이전트를 합쳐 센 값인가 (게스트 총량) — 화면이 그렇게 적어야 한다 */
  shared?: boolean;
}

export interface AgentStep {
  tool: string;
  detail: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  meta: { steps?: AgentStep[] } & AiErrorMeta;
  created_at: string;
}

export interface AgentUsage {
  enabled: boolean;
  used: number;
  max: number;
  remaining: number;
  /** 공급자 장애로 되돌려 받은 질문 수 */
  refunded?: number;
  configured: boolean;
  model?: string | null;
  tools_available: boolean;
  provider_name?: string | null;
  /** 이 수가 메신저와 에이전트를 합쳐 센 값인가 (게스트 총량) */
  shared?: boolean;
}

/** 시험을 마친 사람이 보는 결과 (api: /attempts/{id}/result → guest_result.view).
 *
 *  자동 체크의 항목 이름은 여기 없다 — 정답지이기 때문에 서버가 통과 개수만 준다.
 */
export interface AttemptResultItem {
  name: string;
  points?: number | null;
  earned?: number | null;
}

export interface AttemptResultScenario {
  title: string;
  points: number;
  score_pct: number;
  earned_points: number;
  checks_passed: number;
  checks_total: number;
  process: AttemptResultItem[];
  result: AttemptResultItem[];
  /** 응시자가 실제로 한 일. 총평·아쉬운 점은 정답을 옆에 놓고 쓴 글이라 서버가 주지 않는다. */
  strengths: string[];
}

export interface AttemptResult {
  attempt_id: string;
  assessment_title: string;
  status: string;
  submitted_at: string | null;
  started_at: string;
  /** ready = 채점 끝, grading = 도는 중, pending = 아직 걸리지 않음 */
  state: "ready" | "grading" | "pending";
  overall_score?: number | null;
  graded_at?: string | null;
  scenarios: AttemptResultScenario[];
}

// ── 워크스페이스 / 실행 ──────────────────────────────────────

export interface FileEntry {
  path: string;
  size: number;
  updated_at: string;
  /** 내용의 버전 — 열린 편집기가 밖에서 바뀐 것을 알아본다 */
  sha256: string;
}

export interface FileContent {
  path: string;
  content: string;
  updated_at: string;
  sha256: string;
}

/** 시나리오가 처음 제공한 파일 — 되돌리기의 원본 */
export interface InitialFileEntry {
  path: string;
  size: number;
}

export interface FileResetResult {
  scope: "file" | "all";
  restored: number;
  removed: number;
  paths: string[];
  /** 파일 하나를 되돌렸을 때 그 내용 (전체 초기화는 null) */
  content: string | null;
}

export interface Execution {
  id: string;
  scenario_id: string;
  source: "ide" | "agent" | "check";
  command: string;
  status: "queued" | "running" | "done" | "error";
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  time_ms: number | null;
  changed_files: { path: string; action: string }[] | null;
  created_at: string;
  finished_at: string | null;
}

// ── 리뷰 / 평가 ──────────────────────────────────────────────

export interface ReviewAttemptRow {
  id: string;
  user: { id: string; name: string; email: string; role: Role };
  assessment_id: string;
  assessment_title: string;
  status: string;
  superseded: boolean;
  is_staff: boolean;
  started_at: string;
  submitted_at: string | null;
  has_auto_eval: boolean;
  has_human_eval: boolean;
  /** 사람이 준 점수가 있으면 그것, 없으면 자동평가 점수. 아직 평가 전이면 null */
  score: number | null;
}

/** 한 앱의 사용 내역. `used` 가 거짓이면 그 앱은 채점에서 자동으로 빠진다. */
export interface AppActivity {
  provided: boolean;
  used: boolean;
  count: number;
  what: string;
  /** 에이전트만 — 물어보기에 그치지 않고 실제로 고치거나 돌린 횟수 */
  acted?: number;
  /** terminal 행에만 — 응시자가 직접 돌린 명령 수 (채점기가 돌린 것은 뺀다) */
  runs?: number;
}

export interface ReviewScenario {
  scenario_id: string;
  title: string;
  difficulty: string;
  points: number;
  briefing_md: string;
  objectives_md: string;
  checks: Check[];
  rubric: Rubric;
  characters: Character[];
  initial_files: string[];
  /** 이 시나리오가 실제로 띄워 준 앱 (서버가 이미 전부로 풀어 준다) */
  desktop_apps: DesktopAppId[];
  agent_enabled: boolean;
  /** 앱별로 실제 무슨 일이 있었는가 — 채점 탭은 제공 목록이 아니라 이것을 따른다 (app_usage.py) */
  app_activity?: Record<string, AppActivity>;
}

export interface Evaluation {
  id: string;
  kind: "auto" | "human";
  evaluator: string | null;
  scores: Record<string, unknown>;
  summary: string;
  created_at: string;
}

export interface ReviewAttempt {
  id: string;
  status: string;
  superseded: boolean;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  user: { id: string; name: string; email: string; role: Role };
  assessment: { id: string; title: string; duration_min: number; agent_max_turns: number };
  scenarios: ReviewScenario[];
  /** 이 응시 중 AI 가 답을 만들지 못한 건수 — 기록이 온전한지 채점 전에 알아야 한다 */
  ai_incidents?: AiIncidents;
  /** 관리자가 얹어 준 보정 — 원래 조건과 구제를 구분해 채점한다 */
  grants?: AttemptGrantRecord[];
  /** 시험이 정한 한도에 보정을 더한 실제 한도 */
  agent_turn_limit?: number;
  messenger_turn_limit?: number;
  /** 이 응시가 실제로 쓴 것 */
  usage?: { agent_turns: number; messenger_turns: number; files: number; executions: number };
  evaluations: Evaluation[];
}

export interface AiIncidents {
  total: number;
  messenger: number;
  agent: number;
  refunded: number;
  by_code: Record<string, number>;
}

export interface ReviewEvent {
  id: number;
  scenario_id: string | null;
  type: string;
  /** server = 서버가 직접 관측, client_untrusted = 브라우저 보고 (ODY-017) */
  source?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EvalScenarioResult {
  scenario_id: string;
  title: string;
  points: number;
  score_pct: number;
  earned_points: number;
  checks: { label: string; type: string; passed: boolean; points: number; earned: number; detail: string }[];
  checks_earned: number;
  checks_total: number;
  process: { name: string; score: number; max: number; comment: string }[];
  result: { name: string; score: number; max: number; comment: string }[];
  requirement_discovery: string;
  summary: string;
  strengths: string[];
  concerns: string[];
  integrity_flags: string[];
}

// ── LLM 공급자 설정 ──────────────────────────────────────────

export interface AiProviderMeta {
  provider: string;
  label: string;
  kind: "cloud" | "local" | "cli";
  needs_key: boolean;
  needs_base_url: boolean;
  default_base_url: string | null;
  placeholder_model: string;
  supports_host_tools: boolean;
  supports_temperature: boolean;
  description: string;
}

export interface AiEffective {
  configured: boolean;
  provider: string;
  model: string;
  name: string;
  source: "db" | "env";
}

export interface AiSettingsMeta {
  catalog: AiProviderMeta[];
  effective_chat: AiEffective | null;
  effective_eval: AiEffective | null;
  env_fallback_available: boolean;
}

export interface AiProviderRow {
  id: string;
  name: string;
  provider: string;
  base_url: string | null;
  model: string;
  temperature: number;
  max_tokens: number;
  enabled: boolean;
  is_chat_default: boolean;
  is_eval_default: boolean;
  has_key: boolean;
  key_hint: string | null;
  supports_host_tools: boolean;
  created_at: string;
}

export interface UiSettings {
  gamified_intro: boolean;
}

export interface AiModelInfo {
  id: string;
  display_name: string | null;
}

export interface AiTestResult {
  ok: boolean;
  latency_ms?: number;
  provider?: string;
  model?: string;
  reply?: string;
  error?: string;
}

export interface EvalProviderRef {
  id: string;
  name: string;
  provider: string;
  model: string;
  is_eval_default: boolean;
}

// ── 참고 자료 (GitHub) ────────────────────────────────────────

export interface ReferenceConfig {
  github_enabled: boolean;
}

export interface GhRepo {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  watchers: number;
  topics: string[];
  updated_at: string | null;
  archived: boolean;
  default_branch: string;
  html_url: string;
  homepage: string | null;
  license: string | null;
  avatar: string | null;
}

export interface GhSearchResult {
  total: number;
  items: GhRepo[];
}

export interface GhEntry {
  name: string;
  path: string;
  type: "file" | "dir" | string;
  size: number;
}

export interface GhTree {
  path: string;
  entries: GhEntry[];
  file?: string;
}

export interface GhFile {
  path: string;
  size: number;
  content: string;
}

export interface GhRepoView {
  repo: GhRepo;
  readme: { path: string; content: string } | null;
}

export interface ReferenceSettings {
  github_enabled: boolean;
  has_github_token: boolean;
  github_token_hint: string | null;
}

export interface RuntimeEntry {
  name: string;
  version: string;
  command: string;
}

export interface SystemInfo {
  os: string;
  kernel: string;
  arch: string;
  cpu_count: number | null;
  memory_total_mb: number | null;
  languages: RuntimeEntry[];
  shells: RuntimeEntry[];
  tools: RuntimeEntry[];
  python_packages: { name: string; version: string }[];
  isolated: boolean;
  limits: {
    timeout_s: number;
    max_timeout_s: number;
    memory_mb: number;
    max_file_bytes: number;
    max_changed_files: number;
    network: boolean;
  };
}

export interface MyResources {
  online: boolean;
  running: number;
  cpu_percent: number;
  cpu_capacity_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number | null;
  /** 가장 최근에 끝난 실행 — 짧은 실행도 여기엔 남는다 */
  last_run: {
    command: string;
    duration_s: number;
    cpu_seconds: number;
    peak_cpu: number;
    peak_mem: number;
    source: string | null;
    ended_at: number;
  } | null;
  stats: { runs: number; cpu_seconds: number };
  commands: { command: string; elapsed_s: number; source: string | null }[];
}

export interface AdminResourceRow {
  execution_id: string;
  attempt_id: string;
  scenario_id: string | null;
  source: string | null;
  command: string;
  elapsed_s: number;
  cpu_percent: number;
  memory_bytes: number;
  processes: number;
}

export interface AdminSessionRow {
  attempt_id: string;
  user_name: string;
  user_email: string;
  assessment_title: string;
  started_at: string;
  deadline_at: string | null;
  last_seen_at: string | null;
  idle_seconds: number | null;
  expired: boolean;
  orphan: boolean;
  workspace_files: number;
  running: number;
  /** 이 응시 중 AI 가 답을 만들지 못한 건수 — 보정할지 판단하는 근거 */
  ai_failures?: number;
  /** 이미 얹어 준 보정 */
  granted?: { agent_turns?: number; messenger_turns?: number; extra_minutes?: number; at?: string } | null;
}

export interface AdminResources {
  online: boolean;
  updated_at: number | null;
  concurrency: number | null;
  queue_depth: number;
  container: {
    cpu_percent: number;
    memory_bytes: number;
    memory_limit_bytes: number | null;
    cpu_count: number | null;
  };
  active: AdminResourceRow[];
  sessions: AdminSessionRow[];
  stuck_executions: {
    execution_id: string;
    attempt_id: string;
    status: string;
    source: string | null;
    command: string;
    created_at: string;
    age_seconds: number;
  }[];
}

/** 시나리오 스튜디오 저장 형식 — AI 작성 결과도 이 모양으로 온다 */
export interface ScenarioDraft {
  office_public?: OfficePublic;
  title: string;
  summary: string;
  difficulty: string;
  briefing_md: string;
  characters: Character[];
  opening_messages: OpeningMessage[];
  initial_files: InitialFile[];
  objectives_md: string;
  checks: Check[];
  rubric: Rubric | null;
  agent_enabled: boolean;
  desktop_apps?: DesktopAppId[];
  /** 명령 하나의 제한 시간(초). 0 이면 전역 기본(30초) */
  run_timeout_s?: number;
}

export interface AuthorResult {
  scenario: ScenarioDraft;
  notes: string;
  warnings: string[];
  provider: string;
}

/** 대화형 설계 — 서버가 검증해 흘려보내는 편집 명령 */
export type AuthorOp =
  | {
      op: "set";
      field: "title" | "summary" | "difficulty" | "briefing_md" | "objectives_md" | "agent_enabled" | "desktop_apps";
      value: string | boolean | string[];
    }
  | { op: "upsert_character"; value: Character }
  | { op: "remove_character"; key: string }
  | { op: "set_opening"; value: OpeningMessage[] }
  | { op: "upsert_file"; value: InitialFile }
  | { op: "remove_file"; path: string }
  | { op: "set_checks"; value: Check[] }
  | { op: "set_rubric"; value: Rubric | null };

export interface AttemptGrantRecord {
  at: string;
  agent_turns: number;
  messenger_turns: number;
  extra_minutes: number;
  reason: string;
  by: string;
}
