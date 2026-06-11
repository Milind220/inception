---
name: inception
description: Write and run a dynamic workflow — a JavaScript script that orchestrates many subagents in parallel across any model provider, with budgets, structured output, and a live TUI. Use for tasks too large for one context window - codebase-wide audits, large migrations, multi-source research, or any job that benefits from fanning out dozens of subagents and cross-checking their results.
---

# inception: dynamic workflows

> **Status: draft.** The runtime (`inception-workflows`) is not yet published; this skill documents the intended agent-facing surface. See docs/design.md in the repo.

You are about to orchestrate many subagents from a script instead of working turn by turn. The script holds the loop and the intermediate results; your context holds only the final answer.

## When to reach for this

- The task needs more subagents than you can coordinate conversationally (dozens to hundreds)
- You want the orchestration codified: readable, re-runnable, resumable
- Results need cross-checking (adversarial verification, judge panels) before you trust them

For one or two delegated lookups, just do them directly. A workflow has real cost.

## Setup (once per machine)

```bash
npx inception-workflows init   # probes API keys + Codex OAuth, scaffolds .flue/, checks Node >= 22.18
```

## Write the workflow

Create `.flue/agents/<name>.ts`. The runtime gives you:

| Primitive | What it does |
| :-- | :-- |
| `agent(prompt, opts)` | Spawn a subagent. `opts`: `schema` (valibot — returns parsed object), `model` (`'provider/modelId'`), `role` (loads `.flue/roles/<role>.md`), `label`, `phase`. Returns `null` on failure — filter, don't crash. |
| `parallel(thunks)` | Run thunks concurrently (capped, queued). Barrier: waits for all. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently — no barrier. Default for multi-stage work. |
| `phase(title)` / `log(msg)` | Progress grouping + narrator lines in the TUI. |
| `budget` | `budget.remaining()` in USD. Hard stop: `agent()` throws once exhausted. Required at launch. |
| `workflow(name, args)` | Run a nested workflow (fresh context, depth-capped at 5). Use to recurse over work too big for one level. |

## Quality patterns (use them — fan-out without verification is noise)

- **Adversarial verify**: for each finding, spawn 3 skeptics prompted to *refute* it; keep only majority-survivors.
- **Loop-until-dry**: for unknown-size discovery, keep spawning finders until 2 consecutive rounds find nothing new. Dedup against everything *seen*, not everything *confirmed*.
- **Judge panel**: generate N attempts from different angles, score with independent judges, synthesize from the winner.
- **Model routing**: cheap/fast models for finders, strong models for verification and synthesis.
- **No silent caps**: if you bound coverage (top-N, sampling), `log()` what was dropped.

## Run it

```bash
flue run <name> --target node --id run-$(date +%s) --payload '{"budgetUsd": 5, ...}' &
inception watch <runDir>        # live agent tree, per-agent cost, ledger; --replay for finished runs
```

Run it in the background; read the structured result when it finishes. Report the *outcome* to the user, not the transcript.

## Safety defaults (non-negotiable)

- Sandbox: most restrictive that works — `'empty'` unless subagents need files, `'local'` only when they do.
- Always set `budgetUsd`. Start with a small slice (one directory, one narrow question) to gauge spend before the full run.
- Subagent failures return `null`; design every stage to `.filter(Boolean)`.
