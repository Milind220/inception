# inception — instructions for coding agents

You are a coding agent and you have been pointed at this file to run a **dynamic workflow**: a TypeScript script that fans out many LLM subagents in parallel (with budgets, structured output, resume, and a live observer) instead of working turn by turn. Follow these steps in order.

## 1. Check the environment

```bash
node --version    # must be >= 22.18 — stop and tell the user if it isn't
```

## 2. Install the runtime (once per machine)

```bash
git clone https://github.com/Milind220/inception ~/inception
cd ~/inception/packages/runtime && npm install && npm run build
```

This provides the `inception-workflows` package and the `inception` / `inception-watch` CLIs. (Not yet on npm; install from this checkout via a `file:` dependency.)

## 3. Set up a Flue project (once per project)

In the directory where the workflow should run:

```bash
node ~/inception/packages/runtime/bin/inception.mjs init .
npm install @flue/runtime@^0.11 valibot file:~/inception/packages/runtime
npm install -D @flue/cli@^0.11
```

`inception init` probes the machine for provider credentials (Anthropic/OpenAI/DeepSeek/Fireworks/OpenRouter/Groq env keys, plus Codex ChatGPT-plan OAuth via codex-bridge) and scaffolds `src/app.ts` (provider wiring) and `src/workflows/example.ts` (a working example). It is idempotent and never overwrites existing files. Read its report: if no provider was detected, ask the user which credentials to use before going further.

## 4. Write the workflow

Read [skill/SKILL.md](skill/SKILL.md) in this repo — it is the complete reference: the `agent()/parallel()/pipeline()/phase()/budget/workflow()` API and its exact semantics, the hard rules the runtime enforces (null-on-failure, budget aborts, resume keying), a full template to adapt, and the quality patterns (adversarial verification, loop-until-dry, judge panels, model routing) that separate a useful fan-out from noise.

Raw URL, if you are fetching rather than reading from disk:

```
https://raw.githubusercontent.com/Milind220/inception/main/skill/SKILL.md
```

Create your workflow as `src/workflows/<name>.ts`. Adapt the template; don't write from scratch.

## 5. Run it and read the result

```bash
npx flue run <name> --target node --payload '{"runDir":"/tmp/<name>-1","budgetUsd":3}' &
node ~/inception/packages/runtime/bin/inception.mjs watch /tmp/<name>-1   # live progress; --replay after it finishes
```

Always set `budgetUsd`. Start on a small slice of the task to gauge per-agent cost before the full run. When the run finishes, read the returned JSON result — not the transcript — and report the outcome to the user. If the run died on budget, re-run with a higher `budgetUsd` and the **same** `runDir`: completed calls replay free from the journal.

## 6. Optional: install the skill permanently

So future sessions know all of this without being pointed here:

```bash
cp -r ~/inception/skill ~/.claude/skills/inception    # Claude Code
cp -r ~/inception/skill ~/.codex/skills/inception     # Codex CLI
cp -r ~/inception/skill .agents/skills/inception      # project-local (OpenCode, Gemini CLI, others)
```
