# inception — design & research notes

*June 2026. Findings from the initial research pass that shaped the architecture.*

## Flue 0.11 migration note

The research below was done against Flue **0.4.1** and is preserved as-is; treat 0.4-era API details (package names, file layout, sandbox strings, roles, `--id`) as historical. The shipped code targets Flue **>= 0.11**. The deltas:

- **Package split**: `@flue/runtime` is the authoring package. `@flue/sdk` is now a different thing — Flue's remote client SDK (`createFlueClient`) for consuming deployed agents/workflows over HTTP.
- **Layout**: workflows live in `src/workflows/<name>.ts` (filename = workflow name) and export a named `run(ctx: FlueContext)` — no default export, no `export const triggers`. Optional `export const route: WorkflowRouteHandler` exposes it at `POST /workflows/<name>`. Provider config lives in `src/app.ts` (`export default flue()`); `.flue/` remains supported as a legacy source dir.
- **Agents**: defined via `createAgent(() => ({ model, instructions?, cwd?, sandbox?, tools?, skills?, subagents? }))`, initialized with `const harness = await init(agentDef)`.
- **Roles removed**: no `.flue/roles/*.md` and no per-call `role` option; personas go in prompt text or `createAgent`'s `instructions`. Resume keys no longer include a role.
- **Structured output**: `session.prompt`'s option is `result:` (inception's public `agent()` option stays `schema` and maps to it internally).
- **Sandboxes**: the `'empty'`/`'local'` strings are gone. Omit `sandbox` for the default lightweight in-memory virtual sandbox, or pass `local()` from `@flue/runtime/node` for host filesystem/shell. The virtual sandbox is not a network isolation boundary.
- **CLI**: `flue run <name> --target node --payload '...'` — no `--id` flag; Flue generates the runId and surfaces it as `ctx.id`. Dev server: `flue dev`. Deps: `@flue/runtime@^0.11` + dev `@flue/cli@^0.11`.

## The thesis

Claude Code's dynamic workflows prove that agent-authored orchestration scripts beat turn-by-turn delegation for large tasks: the script holds the loop and the intermediate state, so the orchestrating agent's context holds only the answer. No open implementation exists. The pieces do:

| Piece | Where it exists today |
| :-- | :-- |
| Agent writes orchestration code | Cloudflare Code Mode, smolagents `CodeAgent` |
| Recursive context-isolated subagents | Claude Code nested subagents (depth 5, June 2026), RLM paper (arXiv 2512.24601) |
| Portable skill format | Agent Skills / SKILL.md standard, ~32 adopters incl. Codex, Gemini CLI, Cursor, OpenCode |
| Multi-provider harness | Flue (`@flue/sdk`) |

inception combines them.

## Why Flue as the substrate

`@flue/sdk` (v0.4.1 at time of writing) already provides:

- **Agents/sessions**: `init({ model, sandbox, cwd })` → `agent.session(id, { role })` → `session.prompt(text, { schema, model, thinkingLevel, tools })`
- **Structured output**: valibot schemas, parsed + typed results, retry-on-mismatch at the harness layer
- **Model routing**: per-call `'provider/modelId'` strings; `registerProvider()` for any OpenAI-compatible endpoint; `configureProvider()` for gateways/headers
- **Cost accounting**: every prompt returns `usage` incl. cache read/write and a computed `cost`
- **Sandboxes**: `'local'`, `'empty'` (in-memory), or a `SandboxFactory` (Daytona/E2B/containers)
- **Dev server**: `flue dev` on :3583, `POST /agents/<name>/<runId>` with SSE event streaming
- **Headless**: `flue run <agent> --target node --id <run> --payload '...'`

What Flue does *not* provide — and what the inception runtime adds:

- A workflow vocabulary (`agent()/parallel()/pipeline()/phase()/log()`)
- Budget as a hard stop (Flue gives per-call cost; enforcement is the caller's job)
- Concurrency caps with queuing (`min(16, cores - 2)`)
- A per-run journal (NDJSON) → **resume**: completed `agent()` calls return cached results
- Agent-count cap (1,000/run) as a runaway-loop backstop
- Error isolation: a failed subagent resolves to `null` instead of rejecting the run
- `workflow()` for recursive nesting with a depth counter (default 5)

## Runtime patterns

The runtime distills patterns proven in production multi-agent review harnesses: per-role model routing tables, parallel finder waves, dedup-before-validation, adversarial validators, append-only ledgers, USD budget enforcement, and NDJSON event emission feeding a zero-dependency observer. Roughly 60% of any hand-written harness is this identical infrastructure — that share becomes `packages/runtime`, and the observer becomes `inception watch`.

### Event schema

```
run_start      { runId, models, budgetUsd, ... }
phase          { title }
agent_start    { sid, role, model, label, prompt_head, prompt_file }
agent_end      { sid, status: ok|error|skipped, usage, costUsd, duration_ms }
ledger_append  { ... app-defined ... }
run_end        { totals }
```

Written to `<runDir>/events.ndjson`; prompts mirrored to `<runDir>/prompts/<sid>.txt`. The observer tails live or replays (`--replay`).

## Provider auth

`inception init` probes and generates `.flue/app.ts`:

| Credential | Mechanism |
| :-- | :-- |
| `ANTHROPIC_API_KEY` etc. | env var → built-in provider |
| Any OpenAI-compatible | `registerProvider(name, { api: 'openai-completions', baseUrl, apiKey })` |
| Codex ChatGPT-plan OAuth | token from `~/.codex/auth.json` → `configureProvider('openai-codex', { apiKey })` → `chatgpt.com/backend-api/codex/responses` |

### Codex caveats (researched)

- `~/.codex/auth.json` holds `tokens.{access_token, refresh_token, ...}`; auto-refreshed by the CLI. Treat like a password.
- The backend-api endpoint is **undocumented** and validates a Codex-shaped request (incl. system prompt). It can break without notice. OpenAI has semi-officially blessed *personal* use of one's subscription anywhere; multi-account pooling/proxying is the prohibited zone.
- Sanctioned fallback: `codex exec --json --output-schema <schema.json>` — headless, JSONL events (`thread.started`, `turn.*`, `item.*`), schema-enforced final message, `codex exec resume <id>`. The runtime should support a `codexExec` agent backend so workflows degrade gracefully if the OAuth path breaks.

## Skill portability notes

- One SKILL.md works across Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`, also reads `.agents/skills/`), Gemini CLI, Cursor, OpenCode.
- **Only Claude Code enforces `allowed-tools`** — other agents ignore it. The real safety boundary is Flue's sandbox mode; the skill must default to the most restrictive sandbox that works (`'empty'` > `'local'` > remote).
- Codex/Gemini lack the Workflow-tool conventions in their priors, so the skill's templates and quality patterns (adversarial verify, loop-until-dry, judge panel, multi-modal sweep, completeness critic) carry more weight there. Templates over prose.

## Execution plan

1. **Implement the runtime core** in `packages/runtime`, validating the API against a production-scale review workflow (target: ~150 lines of pure orchestration logic remain in the workflow file).
2. **Journal + resume** — the only net-new engineering.
3. **SKILL.md + templates**; dogfood in Claude Code, then Codex (`codex exec`), then OpenCode.
4. **`inception watch`** and **`inception init`** provider codegen.
5. **Recursive `workflow()`** with depth caps; optional `flue dev` server mode so flue-tui-style clients can attach over SSE.

## Risks

- Codex backend-api endpoint fragility → ship the `codex exec` fallback from day one.
- Flue requires Node ≥ 22.18 → `inception init` checks before scaffolding.
- No cross-agent tool-permission enforcement → sandbox-first defaults, non-optional budget + agent caps in the runtime (not opt-in from the generated script).
- Cost runaway is the failure mode users will hit first → budget is a required parameter of every run.
