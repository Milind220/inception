/**
 * Example inception workflow as a Flue agent handler.
 *
 * Setup:  a .flue/ project with @flue/sdk + inception-workflows installed,
 *         this file at .flue/agents/bug-hunt.ts, providers in .flue/app.ts.
 * Run:    flue run bug-hunt --target node --id run-1 --payload '{
 *           "dir": "/abs/path/to/repo", "runDir": "/tmp/bug-hunt-1", "budgetUsd": 3
 *         }'
 * Watch:  inception-watch /tmp/bug-hunt-1
 *
 * Shape: fan out finders per lane (cheap model) → adversarial verify panel
 * (strong model, nested workflow) → return only majority-surviving findings.
 */
import type { FlueContext } from '@flue/sdk/client';
import { runWorkflow } from 'inception-workflows';
import * as v from 'valibot';

export const triggers = { webhook: true };

const Findings = v.object({
  findings: v.array(v.object({
    title: v.string(),
    file: v.string(),
    why: v.string(),
  })),
});
const Verdict = v.object({ refuted: v.boolean(), why: v.string() });

const LANES = ['error handling', 'concurrency and races', 'input validation'];

export default async function ({ init, payload, id }: FlueContext) {
  const flueAgent = await init({
    model: 'anthropic/claude-fable-5',
    sandbox: 'local', // subagents need to read the repo
    cwd: payload.dir,
  });

  return runWorkflow(
    flueAgent,
    { runId: id, runDir: payload.runDir, budgetUsd: payload.budgetUsd ?? 3 },
    async ({ agent, parallel, phase, log, workflow }) => {
      phase('Find');
      const found = (await parallel(LANES.map(lane => () =>
        agent(
          `Review the repository at ${payload.dir} for bugs in the lane: ${lane}. ` +
          `Read code with shell tools; report only concrete, evidence-backed findings.`,
          { schema: Findings, model: 'openai/gpt-5.4-mini', label: `finder:${lane}` },
        ),
      ))).filter(Boolean).flatMap(r => r!.findings);
      log(`${found.length} candidates found`);

      phase('Verify');
      const confirmed = await workflow('verify-panel', wf =>
        wf.pipeline(found, async (f: v.InferOutput<typeof Findings>['findings'][number]) => {
          const votes = await wf.parallel([1, 2, 3].map(() => () =>
            wf.agent(
              `Adversarially try to REFUTE this bug report; verify the evidence in the code yourself. ` +
              `Default to refuted=true when uncertain.\n${JSON.stringify(f)}`,
              { schema: Verdict, model: 'anthropic/claude-fable-5', label: `verify:${f.title.slice(0, 40)}` },
            ),
          ));
          const survives = votes.filter(Boolean).filter(x => !x!.refuted).length >= 2;
          return survives ? f : null;
        }),
      );

      return { confirmed: confirmed.filter(Boolean), candidates: found.length };
    },
  );
}
