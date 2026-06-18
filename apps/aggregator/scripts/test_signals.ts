/**
 * Test Signal Broadcaster
 * Fires one test signal of each gold tier type to verify
 * Discord pings and chart plotting are working correctly.
 *
 * Usage: pnpm --filter aggregator test:signals
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const db = new Database(TRADING_DB);

const WEBHOOK = process.env.DISCORD_WEBHOOK ?? '';
const nowMs = Date.now();

// Test signals — one per gold tier strategy
const testSignals = [
  {
    label: 'Strategy A — RTH Divergence SHORT (score 92)',
    ts: nowMs - 5000,
    ruleId: 'delta-divergence',
    score: 92,
    direction: 'short',
    strategyVersion: 'A',
    ruleVersion: 'divergence-v1',
    payload: {
      rationale: 'TEST SIGNAL — Strategy A: RTH delta-divergence short. Score 92. [IGNORE]',
      test: true,
    },
    discord: {
      title: '▼ NQ SHORT — delta-divergence (92) [TEST]',
      color: 0xd64545,
    },
  },
  {
    label: 'Strategy B — ON Absorption SHORT ++ (score 72)',
    ts: nowMs - 4000,
    ruleId: 'absorption',
    score: 72,
    direction: 'short',
    strategyVersion: 'B',
    ruleVersion: 'absorption-v1',
    payload: {
      rationale: 'TEST SIGNAL — Strategy B: ON absorption short. 85 contracts absorbed at 28640 over 200ms. [IGNORE]',
      conviction: '++',
      session: 'ON',
      test: true,
    },
    discord: {
      title: '▼ NQ SHORT — absorption (72) ++ [TEST]',
      color: 0xd64545,
    },
  },
  {
    label: 'Strategy B — RTH Absorption LONG (score 75)',
    ts: nowMs - 3000,
    ruleId: 'absorption',
    score: 75,
    direction: 'long',
    strategyVersion: 'B',
    ruleVersion: 'absorption-v1',
    payload: {
      rationale: 'TEST SIGNAL — Strategy B: RTH absorption long. 150 contracts absorbed at 28700 over 300ms. [IGNORE]',
      conviction: null,
      session: 'RTH',
      test: true,
    },
    discord: {
      title: '▲ NQ LONG — absorption (75) [TEST]',
      color: 0x2bb673,
    },
  },
  {
    label: 'Strategy D — Compression Breakout LONG (score 100)',
    ts: nowMs - 2000,
    ruleId: 'compression-breakout',
    score: 100,
    direction: 'long',
    strategyVersion: 'D',
    ruleVersion: 'compression-v2',
    payload: {
      rationale: 'TEST SIGNAL — Strategy D: COMPRESSION-BREAKOUT [15m→5m]: 75-min range 35.0pts (28650–28685). comp_pos=0.52. Macro move +42pts, dir_eff=0.45. Entry=28687, Stop=28650 (37pts). [TEST — IGNORE]',
      compPos: 0.52,
      dirEff: 0.45,
      macroMove: 42,
      stopLevel: 28650,
      entry: 28687,
      test: true,
    },
    discord: {
      title: '▲ NQ LONG — compression-breakout [TEST]',
      color: 0x2bb673,
    },
  },
  {
    label: 'Strategy E 5m — Absorption Scalp LONG (score 100)',
    ts: nowMs - 1000,
    ruleId: 'absorption-scalp',
    score: 100,
    direction: 'long',
    strategyVersion: 'E',
    ruleVersion: 'absorption-scalp-5m',
    payload: {
      rationale: 'TEST SIGNAL — Strategy E 5m: ABSORPTION-SCALP-5m: Bull bar absorbed selling. Body=8pts, delta=-250. comp_pos=0.52, macro=+45pts. Entry=28700 Stop=28690 Target=28720. [TEST — IGNORE]',
      entry: 28700,
      stopLevel: 28690,
      target: 28720,
      compPos: 0.52,
      observeOnly: true,
      test: true,
    },
    discord: {
      title: '▲ NQ LONG — absorption-scalp 5m [TEST] [OBSERVE ONLY]',
      color: 0x2bb673,
    },
  },
  {
    label: 'Strategy E 15m — Bear Absorption LONG (score 100)',
    ts: nowMs,
    ruleId: 'absorption-scalp-15m',
    score: 100,
    direction: 'long',
    strategyVersion: 'E',
    ruleVersion: 'absorption-scalp-15m',
    payload: {
      rationale: 'TEST SIGNAL — Strategy E 15m: ABSORPTION-SCALP-15m: Bear bar absorbed by buyers. Body=18pts, delta=+450. comp_pos=0.58, dir_eff=0.42, macro=+65pts. Entry=28680 Stop=28660 Target=28720. [TEST — IGNORE]',
      entry: 28680,
      stopLevel: 28660,
      target: 28720,
      compPos: 0.58,
      dirEff: 0.42,
      observeOnly: true,
      test: true,
    },
    discord: {
      title: '▲ NQ LONG — absorption-scalp 15m [TEST] [OBSERVE ONLY]',
      color: 0x2bb673,
    },
  },
];

const insertStmt = db.prepare(`
  INSERT INTO signals (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload)
  VALUES (?, 'NQ', ?, ?, ?, ?, ?, ?)
`);

async function sendDiscord(title: string, description: string, color: number) {
  if (!WEBHOOK) { console.log('  No webhook configured — skipping Discord'); return; }
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color,
          footer: { text: 'TEST SIGNAL — ignore for trading purposes' },
        }],
      }),
    });
    if (res.ok) console.log('  Discord: ✓ sent');
    else console.log(`  Discord: ✗ ${res.status} ${await res.text()}`);
  } catch (e) {
    console.log(`  Discord: ✗ error: ${e}`);
  }
}

console.log('\n=== TEST SIGNAL BROADCASTER ===\n');
console.log('Firing one signal of each gold tier type...\n');

for (const sig of testSignals) {
  console.log(`\n${sig.label}`);

  // Insert into DB
  try {
    insertStmt.run(
      sig.ts, sig.ruleId, sig.score, sig.direction,
      sig.strategyVersion, sig.ruleVersion,
      JSON.stringify(sig.payload)
    );
    console.log('  DB: ✓ inserted');
  } catch (e) {
    console.log(`  DB: ✗ ${e}`);
  }

  // Send Discord
  await sendDiscord(
    sig.discord.title,
    sig.payload.rationale,
    sig.discord.color
  );

  // Small delay between Discord messages to avoid rate limit
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n✓ Done. Hard refresh the cockpit (Cmd+Shift+R) to see signals on charts:');
console.log('  1m chart  → Strategy A (delta-divergence) + Strategy B (absorption)');
console.log('  5m chart  → Strategy E 5m (absorption-scalp)');
console.log('  15m chart → Strategy D (compression-breakout) + Strategy E 15m');

db.close();
