#!/usr/bin/env node
/**
 * inception — workflow CLI.
 *
 *   inception init [dir] [--force]        scaffold a Flue project (src/ layout) with detected providers
 *   inception watch <runDir> [--replay]   tail a run's events.ndjson
 */
const USAGE = `usage:
  inception init [dir] [--force]
  inception watch <runDir> [--replay]`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'init': {
    const force = rest.includes('--force');
    const flags = rest.filter(a => a.startsWith('--'));
    const positional = rest.filter(a => !a.startsWith('--'));
    const unknown = flags.filter(a => a !== '--force');
    if (unknown.length > 0 || positional.length > 1) {
      console.error(unknown.length > 0 ? `unknown option: ${unknown[0]}` : 'init takes at most one directory');
      console.error(USAGE);
      process.exit(1);
    }
    const { runInit } = await import('../dist/cli/init.js');
    process.exit(runInit({ dir: positional[0], force }));
    break;
  }
  case 'watch': {
    const { watchCommand } = await import('./watch.mjs');
    watchCommand(rest, 'inception watch');
    break;
  }
  default:
    console.error(USAGE);
    process.exit(1);
}
