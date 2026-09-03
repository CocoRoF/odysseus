// ── 공통 ─────────────────────────────────────────────────────

export type Role = "admin" | "evaluator" | "candidate";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

// ── 시나리오 ─────────────────────────────────────────────────

export interface Character {
  key: string;
  name: string;
  role: string;
  color: string;
  persona: string;
  knowledge: string;
}

export interface OpeningMessage {
  character_key: string;
  content: string;
}

export interface InitialFile {
  path: string;
  content: string;
}

export type CheckType = "file_exists" | "file_contains" | "command";

export interface Check {
  label: string;
  type: CheckType;
  path?: string | null;
  pattern?: string | null;
  command?: string | null;
  expected_stdout?: string | null;
  points: number;
}

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

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  difficulty: string;
  briefing_md: string;
  characters: Character[];
  opening_messages: OpeningMessage[];
  initial_files: InitialFile[];
  objectives_md: string;
  checks: Check[];
  rubric: Rubric;
  agent_enabled: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

// ── 시험 ─────────────────────────────────────────────────────

export interface AssessmentSummary {
  id: string;
  title: string;
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
  description: string;
  duration_min: number;
  agent_max_turns: number;
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
  duration_min: number;
  scenario_count: number;
  starts_at: string | null;
  ends_at: string | null;
  attempt_id: string | null;
  attempt_status: string | null;
  assigned: boolean;
}

export interface AttemptCharacter {
  key: string;
  name: string;
  role: string;
  color: string;
}

export interface AttemptScenario {
  scenario_id: string;
  title: string;
  briefing_md: string;
  ordinal: number;
  points: number;
  agent_enabled: boolean;
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
  /** 시네마틱 인트로(게이미피케이션) 사용 여부 */
  gamified_intro: boolean;
  scenarios: AttemptScenario[];
}

// ── 메신저 / 에이전트 ────────────────────────────────────────

export interface MessengerMessage {
  id: string;
  character_key: string;
  sender: "candidate" | "npc";
  content: string;
  created_at: string;
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
  meta: { steps?: AgentStep[]; error?: string };
  created_at: string;
}

export interface AgentUsage {
  enabled: boolean;
  used: number;
  max: number;
  remaining: number;
  configured: boolean;
  model?: string | null;
  tools_available: boolean;
  provider_name?: string | null;
}

// ── 워크스페이스 / 실행 ──────────────────────────────────────

export interface FileEntry {
  path: string;
  size: number;
  updated_at: string;
}

export interface FileContent {
  path: string;
  content: string;
  updated_at: string;
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
  evaluations: Evaluation[];
}

export interface ReviewEvent {
  id: number;
  scenario_id: string | null;
  type: string;
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

// ── 참고 자료 (GitHub · 인터넷) ───────────────────────────────

export interface ReferenceConfig {
  github_enabled: boolean;
  web_enabled: boolean;
  search_provider: string;
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

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: string;
  results: WebResult[];
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
}

export interface ReferenceSettings {
  github_enabled: boolean;
  web_enabled: boolean;
  search_provider: string;
  search_cx: string;
  has_github_token: boolean;
  github_token_hint: string | null;
  has_search_api_key: boolean;
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

/** 인터넷 앱 — 서버가 정제·재작성한 페이지 (샌드박스 iframe 에 그대로 넣는다) */
export interface WebRender {
  url: string;
  title: string;
  html: string;
  text: string;
  stylesheets: number;
  dropped: Record<string, number>;
}
