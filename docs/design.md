# inception — design & research notes

*June 2026. Findings from the initial research pass that shaped the architecture.*

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

## Prior art in this repo's lineage

The runtime is an extraction, not an invention. `a production harness.ts` (a private project, 456 lines) is a production hand-written dynamic workflow with: a per-role model routing table, `Promise.all` finder waves, dedup-before-validation, adversarial validators, an append-only ledger, USD budget enforcement, and NDJSON event emission consumed by a zero-dependency TUI (`its observer`). Roughly 60% of that file is harness, identical across any workflow — that 60% becomes `packages/runtime`. The TUI becomes `inception watch`.

### Event schema (carried over)

```
run_start      { runId, models, budgetUsd, ... }
phase          { title }
agent_start    { sid, role, model, label, prompt_head, prompt_file }
agent_end      { sid, status: ok|error|skipped, usage, costUsd, duration_ms }
ledger_append  { ... app-defined ... }
run_end        { totals }
```

Written to `<runDir>/events.ndjson`; prompts mirrored to `<runDir>/prompts/<sid>.txt`. The TUI tails live or replays (`--replay --speed N`).

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

1. **Extract the harness** from a production harness into `packages/runtime`. Validate by rewriting a production harness on top of it (target: ~150 lines of pure orchestration logic remain).
2. **Journal + resume** — the only net-new engineering.
3. **SKILL.md + templates**; dogfood in Claude Code, then Codex (`codex exec`), then OpenCode.
4. **`inception watch`** (lift the observer) and **`inception init`** provider codegen.
5. **Recursive `workflow()`** with depth caps; optional `flue dev` server mode so flue-tui-style clients can attach over SSE.

## Risks

- Codex backend-api endpoint fragility → ship the `codex exec` fallback from day one.
- Flue requires Node ≥ 22.18 → `inception init` checks before scaffolding.
- No cross-agent tool-permission enforcement → sandbox-first defaults, non-optional budget + agent caps in the runtime (not opt-in from the generated script).
- Cost runaway is the failure mode users will hit first → budget is a required parameter of every run.
