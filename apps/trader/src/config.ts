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
};

// SL/TP per rule+direction (points)
export const SIGNAL_PARAMS: Record<string, { sl: number; tp: number }> = {
  'clean-impulse:long':  { sl: 55,  tp: 80 },
  'clean-impulse:short': { sl: 105, tp: 80 },
  'expl:long':           { sl: 70,  tp: 80 },
  'absorption:long':     { sl: 100, tp: 80 },
};

export function signalParams(ruleId: string, direction: string) {
  return SIGNAL_PARAMS[`${ruleId}:${direction}`] ?? null;
}
