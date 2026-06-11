#!/usr/bin/env node
/**
 * inception-watch — tail a run's events.ndjson and render live progress.
 *
 *   inception-watch <runDir>            live tail (follows the file)
 *   inception-watch <runDir> --replay   print a finished run start to end
 *
 * Kept as a standalone bin for backwards compatibility; the implementation
 * lives in watch.mjs, shared with `inception watch`.
 */
import { watchCommand } from './watch.mjs';

watchCommand(process.argv.slice(2));
