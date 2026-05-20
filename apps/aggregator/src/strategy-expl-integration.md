# Strategy EXPL — Integration Checklist

## 1. Copy strategy file
cp strategy-expl.ts ~/trading-cockpit/apps/aggregator/src/strategy-expl.ts

## 2. quality.ts — add EXPL case
# Find the switch/if block that handles rule IDs and add:

case 'expl':
  // EXPL is always GOLD if score threshold was met (gate is inside strategy-expl.ts)
  return true;

## 3. server.ts (or wherever your 1-min bar loop runs) — add:

import { evaluateEXPL, formatEXPLDiscord } from './strategy-expl';

// Inside your bar-close handler:
const explSignal = evaluateEXPL(Date.now());
if (explSignal) {
  const payload = formatEXPLDiscord(explSignal);
  await sendDiscordWebhook(payload);
  // Store in DB with ruleId = 'expl' for backtrace
  db.prepare(`
    INSERT INTO signals (timestamp, rule_id, direction, score, meta)
    VALUES (?, 'expl', ?, ?, ?)
  `).run(
    explSignal.timestamp,
    explSignal.direction,
    explSignal.score,
    JSON.stringify(explSignal)
  );
}

## 4. Verify DB schema has 'meta' column on signals table
# If not: ALTER TABLE signals ADD COLUMN meta TEXT;

## 5. Test run (alert-only, no live trading)
pnpm --filter aggregator dev

## 6. After 20+ signals — tune MIN_SCORE_TO_FIRE in strategy-expl.ts
# Start at 3, raise to 4 if false positive rate is too high
