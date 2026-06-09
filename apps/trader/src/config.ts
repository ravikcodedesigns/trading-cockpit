import 'dotenv/config';

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
