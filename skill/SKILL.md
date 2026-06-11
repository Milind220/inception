---
name: inception
description: Write and run a dynamic workflow — a TypeScript script that orchestrates many subagents in parallel across any model provider, with hard budgets, structured output, resume, and a live watch CLI. Use for codebase-wide audits, large migrations, multi-source research, or any task where you want to fan out dozens of subagents and cross-check their results before trusting them.
---

# inception: dynamic workflows

Orchestrate many subagents from a script instead of turn by turn. The script holds the loop and the intermediate results; your context holds only the final answer.

> Not yet on npm. Install `inception-workflows` from the GitHub repo (git URL or `file:` dependency) until it is published — see Setup.

## When to reach for this

- The task needs more subagents than you can coordinate conversationally (dozens to hundreds).
- Results need cross-checking (adversarial verification, judge panels) before you trust them.
- You want the orchestration codified: readable, re-runnable, resumable.

Do NOT use this for one or two delegated lookups — just do them directly. A workflow has real setup and dollar cost.

## Setup check (once per machine)

```bash
node --version          # must be >= 22.18
git clone https://github.com/Milind220/inception ~/inception
(cd ~/inception/packages/runtime && npm install && npm run build)
# in your project (run `inception init` to probe API keys and scaffold src/app.ts + src/workflows/):
[ -f package.json ] || npm init -y   # required: without one, npm installs into the nearest ancestor with a package.json (often $HOME)
npm install @flue/runtime@^0.11 valibot && npm install -D @flue/cli@^0.11
npm install file:~/inception/packages/runtime    # installs inception-workflows + the inception-watch bin
```

Requires Flue >= 0.11 (`@flue/runtime`). `@flue/sdk` is a different package — Flue's remote client SDK for calling deployed workflows over HTTP — and is not used here.

## Write the workflow

Create `src/workflows/<name>.ts` — the filename is the workflow name. Export a NAMED `run(ctx: FlueContext)` function (no default export). Inside it, build a harness with `await init(agentDef)` where `agentDef` comes from `createAgent(() => ({ model, instructions?, cwd?, sandbox?, tools? }))`, then call `runWorkflow(harness, runOptions, body)`. The `body` callback receives the workflow API — these are NOT bare module exports; destructure them from the callback argument.

| API (from the body callback) | Exact semantics |
| :-- | :-- |
| `agent(prompt, opts?)` | Spawn one subagent. With `opts.schema` (valibot) returns the parsed object, else text. **Returns `null` on any subagent failure** — `.filter(Boolean)` every fan-out. `opts`: `schema`, `model` (`'provider/modelId'`), `thinkingLevel`, `label`, `phase`, `tools`, `images`. Per-agent personas go in the prompt text (or `createAgent`'s `instructions`). |
| `parallel(thunks)` | Run thunks concurrently; waits for all (barrier). A throwing thunk resolves to `null`. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently — no barrier between stages. A throwing stage drops that item to `null`; the run continues. Stage signature: `(prev, originalItem, index)`. |
| `phase(title)` | Group subsequent `agent()` calls in the event stream / watch CLI. |
| `log(message)` | Narrator line for the observer. |
| `budget` | `budget.total` (USD ceiling or `null`), `budget.spent()`, `budget.remaining()`. |
| `workflow(name, body)` | Nested workflow with fresh phase scope. **Shares** the parent's budget, concurrency, and agent caps. Depth-capped at 5 (`DepthExceededError`). |
| `depth` | Current nesting level (top = 0). |

`runWorkflow` options (second arg): `runId` (required — pass `ctx.id`), `runDir` (events.ndjson + results.ndjson + prompts/; omit to disable persistence), `budgetUsd`, `maxAgents` (default 1000), `concurrency` (default `min(16, cpus - 2)`), `maxDepth` (default 5), `pricing` (`{ 'provider/model': [$inPer1M, $outPer1M] }` fallback when the provider reports no cost; unknown models are charged at a pessimistic [5, 25]), `resume` (default true when `runDir` is set), `onEvent`.

Hard rules the runtime enforces — design around them:

- **`null` on failure.** A dead subagent never kills the run; it returns `null`. Filter every fan-out result with `.filter(Boolean)` before using it.
- **`BudgetExceededError` aborts the run.** The stop is enforced before each call starts: once `spent >= budgetUsd`, every further `agent()` call throws, and the error propagates out of `parallel()`/`pipeline()` so a budget-dead run fails loudly instead of "succeeding" with all-null results. Calls already in flight when the ceiling is crossed still finish and bill, so the overshoot is bounded by `concurrency` × the largest single-call cost — size `budgetUsd` with that margin in mind. Recovery is cheap: re-run with a higher budget and the same `runDir`; completed calls replay free.
- **`AgentCapExceededError`** after `maxAgents` (default 1000) live spawns — cached replays don't count. A runaway-loop backstop, not a knob to tune first.
- **Resume.** Re-run with the same `runDir` and every unchanged call returns its journaled result at zero cost; only edited calls re-run. Calls are keyed by a content hash of the full call shape — prompt, model, label, thinkingLevel, schema/tools fingerprints (identical calls matched by occurrence order) — so changing any of those invalidates exactly that call.
- **`concurrency` bounds concurrent `agent()` LLM calls**, not arbitrary thunk bodies. `phase()` sets shared state — call it between fan-outs; inside `parallel()` thunks, tag calls with `opts.phase` instead.

### Template — adapt this, don't write from scratch

```ts
// src/workflows/bug-hunt.ts — change the prompts, lanes, schemas, and models to your task.
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { runWorkflow } from 'inception-workflows';
import * as v from 'valibot';

const Findings = v.object({
  findings: v.array(v.object({ title: v.string(), file: v.string(), why: v.string() })),
});
const Verdict = v.object({ refuted: v.boolean(), why: v.string() });

const LANES = ['error handling', 'concurrency and races', 'input validation'];

export async function run({ init, payload, id }: FlueContext) {
  // local() because finders read the repo on the host; omit `sandbox` entirely
  // for the default in-memory virtual sandbox when no host files are needed.
  const hunter = createAgent(() => ({
    model: 'anthropic/claude-fable-5',
    sandbox: local(),
    cwd: payload.dir,
  }));
  const harness = await init(hunter);

  return runWorkflow(
    harness,
    { runId: id, runDir: payload.runDir, budgetUsd: payload.budgetUsd ?? 3 },
    async ({ agent, parallel, phase, log, workflow, budget }) => {
      phase('Find');
      const found = (await parallel(LANES.map(lane => () =>
        agent(
          `Review the repository at ${payload.dir} for bugs in the lane: ${lane}. ` +
          `Read code with shell tools; report only concrete, evidence-backed findings.`,
          { schema: Findings, model: 'openai-codex/gpt-5.3-codex-spark', label: `finder:${lane}` },
        ),
      ))).filter(Boolean).flatMap(r => r!.findings);
      log(`${found.length} candidates; $${budget.remaining().toFixed(2)} remaining`);

      phase('Verify');
      const confirmed = await workflow('verify-panel', wf =>
        wf.pipeline(found, async (f) => {
          const votes = await wf.parallel([1, 2, 3].map(() => () =>
            wf.agent(
              `Adversarially try to REFUTE this bug report; verify the evidence in the code yourself. ` +
              `Default to refuted=true when uncertain.\n${JSON.stringify(f)}`,
              { schema: Verdict, model: 'anthropic/claude-fable-5', label: `verify:${f.title.slice(0, 40)}` },
            ),
          ));
          return votes.filter(Boolean).filter(x => !x!.refuted).length >= 2 ? f : null;
        }),
      );

      return { confirmed: confirmed.filter(Boolean), candidates: found.length };
    },
  );
}
```

## Quality patterns (fan-out without verification is noise)

- **Adversarial verify**: for each finding, spawn 3 skeptics prompted to *refute* it ("default to refuted when uncertain"); keep only majority survivors.
- **Loop-until-dry**: for unknown-size discovery, keep spawning finder rounds until 2 consecutive rounds surface nothing new. Dedup against everything *seen*, not everything *confirmed* — or you re-find refuted items forever.
- **Judge panel**: generate N attempts from different angles, score each with independent judges, synthesize from the winner.
- **Model routing**: cheap fast models for finders (`openai-codex/gpt-5.3-codex-spark`), strong models for verification and synthesis (`anthropic/claude-fable-5`). Route per call via `opts.model`.
- **No silent caps**: if you bound coverage (top-N, sampling), `log()` exactly what was dropped.

## Run and observe

```bash
flue run bug-hunt --target node \
  --payload '{"dir":"/abs/path/to/repo","runDir":"/tmp/bug-hunt-1","budgetUsd":3}' &
inception-watch /tmp/bug-hunt-1            # live agent tree + per-agent cost; --replay for finished runs
```

Flue generates the run id itself (it arrives as `ctx.id`); `runDir` in the payload is what the journal and watch CLI key on. Launch in the background. When it finishes, read the returned JSON result — not the transcript. Report the outcome to the user. If the run died on budget, raise `budgetUsd` and re-run with the same `runDir`: completed calls replay from the journal for free.

## Safety defaults (non-negotiable)

- Sandbox: most restrictive that works — omit `sandbox` (in-memory virtual sandbox, the default) unless subagents must read host files, then `local()` imported from `@flue/runtime/node`. The virtual sandbox is NOT a network isolation boundary.
- Always set `budgetUsd`. Omitting it means unlimited spend.
- Start on a small slice (one directory, one narrow question) to gauge per-agent cost before the full run.

## Installing this skill

From a checkout of the repo, copy the skill directory to wherever your agent loads skills:

```bash
cp -r ~/inception/skill ~/.claude/skills/inception    # Claude Code
cp -r ~/inception/skill ~/.codex/skills/inception     # Codex CLI
cp -r ~/inception/skill .agents/skills/inception      # project-local (OpenCode, Gemini CLI, others)
```
