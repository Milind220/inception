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
# in your project (a .flue/ project — run `inception init` to probe API keys and scaffold it):
npm i @flue/sdk valibot
npm i file:~/inception/packages/runtime    # installs inception-workflows + the inception-watch bin
```

## Write the workflow

Create `.flue/agents/<name>.ts`: a default-export Flue handler that calls `runWorkflow(flueAgent, runOptions, body)`. The `body` callback receives the workflow API — these are NOT bare module exports; destructure them from the callback argument.

| API (from the body callback) | Exact semantics |
| :-- | :-- |
| `agent(prompt, opts?)` | Spawn one subagent. With `opts.schema` (valibot) returns the parsed object, else text. **Returns `null` on any subagent failure** — `.filter(Boolean)` every fan-out. `opts`: `schema`, `model` (`'provider/modelId'`), `role` (`.flue/roles/<role>.md`), `thinkingLevel`, `label`, `phase`, `tools`, `images`. |
| `parallel(thunks)` | Run thunks concurrently; waits for all (barrier). A throwing thunk resolves to `null`. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently — no barrier between stages. A throwing stage drops that item to `null`; the run continues. Stage signature: `(prev, originalItem, index)`. |
| `phase(title)` | Group subsequent `agent()` calls in the event stream / watch CLI. |
| `log(message)` | Narrator line for the observer. |
| `budget` | `budget.total` (USD ceiling or `null`), `budget.spent()`, `budget.remaining()`. |
| `workflow(name, body)` | Nested workflow with fresh phase scope. **Shares** the parent's budget, concurrency, and agent caps. Depth-capped at 5 (`DepthExceededError`). |
| `depth` | Current nesting level (top = 0). |

`runWorkflow` options (second arg): `runId` (required), `runDir` (events.ndjson + results.ndjson + prompts/; omit to disable persistence), `budgetUsd`, `maxAgents` (default 1000), `concurrency` (default `min(16, cpus - 2)`), `maxDepth` (default 5), `pricing` (`{ 'provider/model': [$inPer1M, $outPer1M] }` fallback when the provider reports no cost; unknown models are charged at a pessimistic [5, 25]), `resume` (default true when `runDir` is set), `onEvent`.

Hard rules the runtime enforces — design around them:

- **`null` on failure.** A dead subagent never kills the run; it returns `null`. Filter every fan-out result with `.filter(Boolean)` before using it.
- **`BudgetExceededError` is a hard stop.** Once `spent >= budgetUsd`, every further direct `agent()` call throws — including calls already queued when the budget ran out (skipped, never billed). Inside `parallel()`/`pipeline()` the throw collapses to `null` for that item, so check `budget.remaining()` between phases to stop cleanly.
- **`AgentCapExceededError`** after `maxAgents` (default 1000) spawns — a runaway-loop backstop, not a knob to tune first.
- **Resume.** Re-run with the same `runDir` and every unchanged call returns its journaled result at zero cost; only edited calls re-run. Calls are keyed by a content hash of prompt + model + role + label (identical calls matched by occurrence order), so changing a prompt invalidates exactly that call.

### Template — adapt this, don't write from scratch

```ts
// .flue/agents/bug-hunt.ts — change the prompts, lanes, schemas, and models to your task.
import type { FlueContext } from '@flue/sdk/client';
import { runWorkflow } from 'inception-workflows';
import * as v from 'valibot';

export const triggers = { webhook: true };

const Findings = v.object({
  findings: v.array(v.object({ title: v.string(), file: v.string(), why: v.string() })),
});
const Verdict = v.object({ refuted: v.boolean(), why: v.string() });

const LANES = ['error handling', 'concurrency and races', 'input validation'];

export default async function ({ init, payload, id }: FlueContext) {
  const flueAgent = await init({
    model: 'anthropic/claude-fable-5',
    sandbox: 'local', // subagents must read the repo; use 'empty' when no files are needed
    cwd: payload.dir,
  });

  return runWorkflow(
    flueAgent,
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
flue run bug-hunt --target node --id run-$(date +%s) \
  --payload '{"dir":"/abs/path/to/repo","runDir":"/tmp/bug-hunt-1","budgetUsd":3}' &
inception-watch /tmp/bug-hunt-1            # live agent tree + per-agent cost; --replay for finished runs
```

Launch in the background. When it finishes, read the returned JSON result — not the transcript. Report the outcome to the user. If the run died on budget, raise `budgetUsd` and re-run with the same `runDir`: completed calls replay from the journal for free.

## Safety defaults (non-negotiable)

- Sandbox: most restrictive that works — `'empty'` unless subagents need files, then `'local'`.
- Always set `budgetUsd`. Omitting it means unlimited spend.
- Start on a small slice (one directory, one narrow question) to gauge per-agent cost before the full run.

## Installing this skill

From a checkout of the repo, copy the skill directory to wherever your agent loads skills:

```bash
cp -r ~/inception/skill ~/.claude/skills/inception    # Claude Code
cp -r ~/inception/skill ~/.codex/skills/inception     # Codex CLI
cp -r ~/inception/skill .agents/skills/inception      # project-local (OpenCode, Gemini CLI, others)
```
