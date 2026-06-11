import { resolve } from 'node:path';
import { detectProviders, realProbes, type DetectedProvider } from './detect.js';
import { scaffold } from './scaffold.js';

/** Flue's floor (docs/design.md): scaffolding for an older Node would only defer the failure. */
export const MIN_NODE = '22.18.0';

export function nodeSatisfies(version: string, min: string = MIN_NODE): boolean {
  const parse = (s: string) => s.split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export interface InitOptions {
  dir?: string;
  force?: boolean;
}

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m';

function providerTable(providers: DetectedProvider[]): string[] {
  const width = Math.max(...providers.map(p => p.name.length));
  return providers.map(p => {
    const mark = p.detected ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    return `  ${mark} ${p.name.padEnd(width)}  ${DIM}${p.detail}${RESET}`;
  });
}

export function runInit(opts: InitOptions = {}): number {
  if (!nodeSatisfies(process.versions.node)) {
    console.error(`inception init requires Node >= ${MIN_NODE} (flue's floor); found ${process.versions.node}`);
    return 1;
  }

  const dir = resolve(opts.dir ?? '.');
  const providers = detectProviders(realProbes());
  const { written, skipped } = scaffold(dir, providers, opts.force ?? false);

  console.log(`${BOLD}▶ inception init${RESET} ${DIM}${dir}${RESET}`);
  console.log('');
  console.log(`${BOLD}providers${RESET}`);
  for (const line of providerTable(providers)) console.log(line);
  if (!providers.some(p => p.detected)) {
    console.log(`  ${DIM}none detected — .flue/app.ts has commented examples to wire one by hand${RESET}`);
  }
  console.log('');
  console.log(`${BOLD}files${RESET}`);
  for (const rel of written) console.log(`  ${GREEN}+${RESET} ${rel}`);
  for (const rel of skipped) console.log(`  ${DIM}= ${rel} (exists, skipped — rerun with --force to overwrite)${RESET}`);
  console.log('');
  console.log(`${BOLD}next steps${RESET}`);
  console.log(`  1. cd ${dir}`);
  console.log('  2. npm install @flue/sdk valibot inception-workflows');
  console.log(`  3. npx flue dev ${DIM}— or run once:${RESET}`);
  console.log(`     npx flue run example --target node --id run-1 --payload '{"runDir":"/tmp/example-1","budgetUsd":1}'`);
  console.log('  4. inception watch /tmp/example-1');
  return 0;
}
