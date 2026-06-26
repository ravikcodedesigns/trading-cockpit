import 'dotenv/config';
import { existsSync } from 'node:fs';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export type TraderMode = 'demo' | 'live';

export const config = {
  tradovate: {
    username:   required('TRADOVATE_USERNAME'),
    password:   required('TRADOVATE_PASSWORD'),
    appId:      process.env.TRADOVATE_APP_ID      ?? 'Sample App',
    appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0',
    cid:        parseInt(required('TRADOVATE_CID'), 10),
    secret:     required('TRADOVATE_SECRET'),
    deviceId:   required('TRADOVATE_DEVICE_ID'),
  },

  mode: (process.env.TRADER_MODE ?? 'demo') as TraderMode,

  risk: {
    maxDailyLoss:  parseFloat(process.env.TRADER_MAX_DAILY_LOSS ?? '-500'),
    maxPositions:  parseInt(process.env.TRADER_MAX_POSITIONS    ?? '1', 10),
  },

  contracts: {
    NQ: process.env.TRADER_CONTRACT_NQ ?? 'MNQ',
    ES: process.env.TRADER_CONTRACT_ES ?? 'MES',
  },

  qty: parseInt(process.env.TRADER_QTY ?? '1', 10),

  aggregatorWs: process.env.AGGREGATOR_WS ?? 'ws://127.0.0.1:8787/ws/cockpit',

  enabledRules: (process.env.TRADER_ENABLED_RULES ?? 'clean-impulse')
    .split(',').map(r => r.trim()).filter(Boolean),

  // Pull FLIP-long (clean-impulse long) from LIVE trading — shadow only (aggregator
  // still logs/broadcasts it; the trader just won't place the order). Decided
  // 2026-06-26: the per-type regime split showed FLIP-long broken in EVERY regime
  // cell (gm=bull −$9 EV, rational −$6, irrational −$2). Reversible: set =false to
  // re-arm. FLIP-short / CONT-long / CONT-short are unaffected.
  dropFlipLongs: (process.env.TRADER_DROP_FLIP_LONGS ?? 'false') === 'true',

  // Discord webhook for trade notifications. Empty string = disabled.
  discordWebhook: process.env.DISCORD_WEBHOOK ?? '',

  // Pushover credentials for fast (<1s) iOS / macOS push. Both must be set;
  // empty = disabled. User key: top of https://pushover.net (your account).
  // App token: create one at https://pushover.net/apps/build.
  pushoverUser:  process.env.PUSHOVER_USER  ?? '',
  pushoverToken: process.env.PUSHOVER_TOKEN ?? '',
};

// SL/TP per rule+direction (points)
export const SIGNAL_PARAMS: Record<string, { sl: number; tp: number }> = {
  'clean-impulse:long':  { sl: 55,  tp: 80 },
  'clean-impulse:short': { sl: 105, tp: 80 },
  'expl:long':           { sl: 70,  tp: 80 },
  'absorption:long':     { sl: 100, tp: 80 },
  // CONT-reentry promoted 2026-06-09 per backtest analysis:
  //   23-day window: +$1,154 / WR 60→62% / ~$50/day average lift.
  //   Symmetric TP=80/SL=70 mirrors aggregator's v3.perRule['cont-reentry'].
  'cont-reentry:long':   { sl: 70,  tp: 80 },
  'cont-reentry:short':  { sl: 70,  tp: 80 },
};

export function signalParams(ruleId: string, direction: string) {
  return SIGNAL_PARAMS[`${ruleId}:${direction}`] ?? null;
}

// Per-signal position SIZING (multiplier × base config.qty). 2026-06-25 live analysis (145 OPEN NQ
// trades, +2,641 pts, max DD 304pt): size up ONLY the two strongest cohorts — FLIP-short (75% WR) and
// CONT-long (77% WR). FLIP-long (55%) and CONT-short (60%) stay at base. NQ(→MNQ) ONLY; ES untouched.
// Kill-switch: TRADER_SIZEUP=off reverts every signal to the flat base qty.
export const SIGNAL_QTY_MULT: Record<string, number> = {
  'clean-impulse:short': 2,   // FLIP short
  'cont-reentry:long':   2,   // CONT long
};

// LIVE size-down lever (mirrors the /tmp/trader.halt kill switch): `touch /tmp/trader.sizedown`
// drops every signal back to base 1× instantly — checked per signal, NO restart. `rm` it to restore 2×.
export const SIZEDOWN_FILE = '/tmp/trader.sizedown';

export function signalQty(ruleId: string, direction: string, symbol: string): number {
  if (process.env.TRADER_SIZEUP === 'off' || existsSync(SIZEDOWN_FILE) || symbol !== 'NQ') return config.qty;
  return config.qty * (SIGNAL_QTY_MULT[`${ruleId}:${direction}`] ?? 1);
}
