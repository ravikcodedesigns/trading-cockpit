// Smoke test for V3 db helpers and table creation.
import { db, type V3OpenTrade, type V3Decision } from '../src/db.js';

// Tables should already be created by db.ts module load.
const t: V3OpenTrade = {
  symbol: 'NQ', signalId: 999999, ruleId: 'absorption', pattern: null,
  direction: 'long', entry: 30000, tpPts: 80, slPts: 140, openTs: Date.now(),
};
db.v3.upsertOpenTrade(t);
console.log('Upsert OK; current open trades:', db.v3.getAllOpenTrades());

const d: V3Decision = {
  ts: Date.now(), symbol: 'NQ', signalId: 999999, ruleId: 'absorption',
  pattern: null, direction: 'long', qualified: true,
  activeMode: 'shadow', action: 'OPEN', reason: 'smoke test',
  cvdSession: -500, entry: 30000,
};
const id = db.v3.logDecision(d);
console.log('Logged decision id:', id);

db.v3.deleteOpenTrade('NQ');
console.log('After delete, open trades:', db.v3.getAllOpenTrades());
console.log('SMOKE TEST PASSED');
