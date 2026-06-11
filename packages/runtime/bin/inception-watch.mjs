#!/usr/bin/env node
/**
 * inception watch — tail a run's events.ndjson and render live progress.
 *
 *   inception-watch <runDir>            live tail (follows the file)
 *   inception-watch <runDir> --replay   print a finished run start to end
 *
 * Zero dependencies. Renders one line per event plus a running cost/agent
 * summary; phases group agents; nested workflows indent by depth.
 */
import { existsSync, readFileSync, watch } from 'node:fs';

const DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m';
const GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', YELLOW = '\x1b[33m', MAGENTA = '\x1b[35m';

const args = process.argv.slice(2);
const runDir = args.find(a => !a.startsWith('--'));
const replay = args.includes('--replay');
if (!runDir) {
  console.error('usage: inception-watch <runDir> [--replay]');
  process.exit(1);
}
const file = `${runDir}/events.ndjson`;

let agents = 0, ok = 0, errors = 0, cachedN = 0, spent = 0;

function pad(depth) {
  return '  '.repeat(depth ?? 0);
}

function render(evt) {
  const d = evt.depth ?? 0;
  switch (evt.type) {
    case 'run_start':
      console.log(`${BOLD}▶ run ${evt.runId}${RESET} ${DIM}budget=$${evt.budgetUsd ?? '∞'} maxAgents=${evt.maxAgents}${RESET}`);
      break;
    case 'phase':
      console.log(`${pad(d)}${BOLD}${MAGENTA}── ${evt.title} ──${RESET}`);
      break;
    case 'log':
      console.log(`${pad(d)}${DIM}· ${evt.message}${RESET}`);
      break;
    case 'workflow_start':
      console.log(`${pad(d)}${CYAN}▸ workflow ${evt.name}${RESET}`);
      break;
    case 'workflow_end':
      console.log(`${pad(d)}${evt.status === 'ok' ? GREEN : RED}◂ workflow ${evt.name} ${evt.status}${RESET}`);
      break;
    case 'agent_start':
      console.log(`${pad(d)}${CYAN}↳${RESET} ${evt.label} ${DIM}${evt.model ?? ''}${RESET}`);
      break;
    case 'agent_end': {
      agents++;
      const dur = evt.duration_ms != null ? `${(evt.duration_ms / 1000).toFixed(1)}s` : '';
      if (evt.status === 'ok') {
        ok++; spent += evt.costUsd ?? 0;
        const u = evt.usage ?? {};
        console.log(`${pad(d)}${GREEN}✓${RESET} ${evt.label} ${DIM}$${(evt.costUsd ?? 0).toFixed(4)} ${u.input ?? 0}→${u.output ?? 0}tok ${dur}${RESET}`);
      } else if (evt.status === 'cached') {
        cachedN++;
        console.log(`${pad(d)}${YELLOW}≡${RESET} ${evt.label} ${DIM}(cached)${RESET}`);
      } else if (evt.status === 'skipped') {
        console.log(`${pad(d)}${YELLOW}⊘${RESET} ${evt.label} ${DIM}${evt.error ?? 'skipped'}${RESET}`);
      } else {
        errors++;
        console.log(`${pad(d)}${RED}✗${RESET} ${evt.label} ${DIM}${evt.error ?? ''}${RESET}`);
      }
      break;
    }
    case 'run_end': {
      const t = evt.totals ?? {};
      const color = evt.status === 'ok' ? GREEN : RED;
      console.log(`${color}${BOLD}■ run ${evt.status}${RESET} ${DIM}agents=${t.agents} spent=$${t.spentUsd} ${((t.elapsed_ms ?? 0) / 1000).toFixed(1)}s${RESET}`);
      if (evt.error) console.log(`${RED}  ${evt.error}${RESET}`);
      console.log(`${DIM}  ok=${ok} cached=${cachedN} errors=${errors}${RESET}`);
      break;
    }
    default:
      console.log(`${pad(d)}${DIM}[${evt.type}]${RESET}`);
  }
}

let offset = 0;
function drain() {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (text.length <= offset) return false;
  const chunk = text.slice(offset);
  const end = chunk.lastIndexOf('\n');
  if (end < 0) return false; // wait for a complete line
  offset += end + 1;
  let sawEnd = false;
  for (const line of chunk.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      render(evt);
      if (evt.type === 'run_end') sawEnd = true;
    } catch { /* torn line */ }
  }
  return sawEnd;
}

if (replay) {
  if (!existsSync(file)) {
    console.error(`no events at ${file}`);
    process.exit(1);
  }
  drain();
} else {
  console.log(`${DIM}watching ${file}${RESET}`);
  if (drain()) process.exit(0);
  const poll = setInterval(() => {
    if (drain()) {
      clearInterval(poll);
      watcher?.close();
      process.exit(0);
    }
  }, 500);
  let watcher;
  try {
    watcher = watch(runDir, () => {}); // nudge fs cache on some platforms; polling does the real work
  } catch { /* directory may not exist yet */ }
}
