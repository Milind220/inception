/**
 * Structural types for the slice of @flue/sdk the runtime touches.
 * Kept structural (not imported) so the package has zero runtime deps and
 * tests can inject fakes; any real FlueAgent satisfies AgentLike.
 */

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; total?: number };
}

export interface PromptResponseLike {
  data?: unknown;
  text?: string;
  usage: UsageLike;
  model?: { id: string };
}

export interface SessionLike {
  prompt(text: string, options?: Record<string, unknown>): PromiseLike<PromptResponseLike>;
}

export interface AgentLike {
  session(id?: string, options?: { role?: string }): Promise<SessionLike>;
}

export type ThinkingLevel = 'minimal' | 'default' | 'extended' | 'off';

export interface AgentOpts {
  /** Valibot (or compatible) schema. When set, agent() returns the parsed object. */
  schema?: unknown;
  /** 'provider/modelId' override for this call. */
  model?: string;
  /** Role file name, resolved by Flue from .flue/roles/<role>.md. */
  role?: string;
  thinkingLevel?: ThinkingLevel;
  /** Display label for events/TUI. Defaults to a prompt head. */
  label?: string;
  /** Progress group. Defaults to the current phase(). */
  phase?: string;
  tools?: unknown[];
  images?: unknown[];
}

export interface BudgetView {
  /** USD ceiling, or null when unlimited. */
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowEvent {
  t: number;
  type: string;
  [key: string]: unknown;
}

export interface RunOptions {
  runId: string;
  /** Where events.ndjson, results.ndjson, and prompts/ are written. Omit to disable persistence. */
  runDir?: string;
  /** Hard USD ceiling. agent() throws BudgetExceededError once spent >= budgetUsd. */
  budgetUsd?: number;
  /** Runaway-loop backstop. Default 1000. */
  maxAgents?: number;
  /** Concurrent agent() calls. Default min(16, cpus - 2). */
  concurrency?: number;
  /** Nested workflow() depth cap. Default 5. */
  maxDepth?: number;
  /**
   * $/1M-token [input, output] fallback rates per model string, used only
   * when the provider does not report usage.cost.total (custom/proxied
   * endpoints). Unknown models fall back to [5, 25].
   */
  pricing?: Record<string, [number, number]>;
  /** Reuse journaled results from a previous run in runDir. Default true when runDir is set. */
  resume?: boolean;
  /** Mirror of every emitted event, in addition to events.ndjson. */
  onEvent?: (evt: WorkflowEvent) => void;
}

export type Thunk<T> = () => Promise<T> | T;
export type Stage = (prev: any, originalItem: any, index: number) => Promise<any> | any;

export interface WorkflowApi {
  /** Spawn a subagent. Returns parsed schema output (or text). Returns null when the call fails. */
  agent(prompt: string, opts?: AgentOpts): Promise<any>;
  /** Run thunks concurrently (barrier). A thunk that throws resolves to null. */
  parallel<T>(thunks: Thunk<T>[]): Promise<(T | null)[]>;
  /** Run each item through all stages independently — no barrier between stages. */
  pipeline(items: any[], ...stages: Stage[]): Promise<any[]>;
  /** Start a progress phase. Subsequent agent() calls group under it. */
  phase(title: string): void;
  /** Narrator line for the observer. */
  log(message: string): void;
  budget: BudgetView;
  /** Run a nested workflow body with fresh phase scope; shares budget/limits. Depth-capped. */
  workflow<T>(name: string, body: (wf: WorkflowApi) => Promise<T>): Promise<T>;
  /** Current nesting depth (top level = 0). */
  readonly depth: number;
}
