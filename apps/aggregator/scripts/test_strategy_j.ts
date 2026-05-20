// Smoke test: run one Strategy J poll for NQ and print what it sees
import { runStrategyJ } from '../src/rules-v2/strategy-j.js';

const nowMs = Date.now();
process.stdout.write(`Running Strategy J at ${new Date(nowMs).toISOString()}\n`);

const result = await runStrategyJ('NQ', nowMs);
if (result) {
  process.stdout.write(`\nSIGNAL FIRED!\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(`No signal (expected outside RTH or no absorption pattern active)\n`);
}

// Also test ES
const resultES = await runStrategyJ('ES', nowMs);
if (resultES) {
  process.stdout.write(`\nES SIGNAL!\n${JSON.stringify(resultES, null, 2)}\n`);
} else {
  process.stdout.write(`ES: no signal\n`);
}
