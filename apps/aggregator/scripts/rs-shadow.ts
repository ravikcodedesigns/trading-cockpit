// rs-shadow — the EST shadow harness (Phase 6, early). Each RTH tick: refresh
// rs-context, read today's levels + the live futures price, build the MarketState,
// run the EST engine, and log any NEW setups to data/rs-shadow.db. Shadow only —
// NO orders. Outcome resolution is a separate post-close step (rs-shadow-resolve).
//
//   pnpm exec tsx scripts/rs-shadow.ts          # live loop, every INTERVAL s during RTH
//   ONCE=1 pnpm exec tsx scripts/rs-shadow.ts   # single iteration (ignores RTH gate) — for testing
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, getContext } from '../src/rs-context.js';
import { deriveMarketState } from '../src/rules-v2/derive-market-state.js';
import { evaluateEst } from '../src/rules-v2/est-engine.js';
import type { DailyLevels } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const SHADOW_DB = path.join(ROOT, 'data/rs-shadow.db');
const TICKS_DB = path.join(ROOT, 'data/ticks.db');
const LEVELS_FILE: Record<'NQ' | 'ES', string> = {
  NQ: path.join(ROOT, 'daily_levels.json'),
  ES: path.join(ROOT, 'daily_levels_es.json'),
};
const INTERVAL = (parseInt(process.env.INTERVAL || '15', 10)) * 1000;
const ONCE = process.env.ONCE === '1';

const etDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const etTime = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
const log = (...a: unknown[]) => console.error(etTime() + ' ET', ...a);

function inRTH(): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '';
  const min = parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(g('weekday')) && min >= 570 && min < 960;
}

// --- DB ---
const db = new Database(SHADOW_DB);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS shadow_setups (
  id INTEGER PRIMARY KEY,
  trading_day TEXT, ts_ms INTEGER, ts_et TEXT,
  symbol TEXT, family TEXT, pivot TEXT, direction TEXT, size_tier TEXT,
  level REAL, entry REAL, stop REAL, targets TEXT, bounce_vs_break TEXT, base_prob REAL,
  gate_mode TEXT, gate_reasons TEXT, lm_code TEXT,
  dd_ratio REAL, res_white REAL, res_blue REAL, res_orange REAL, gm TEXT,
  vx REAL, bbb REAL, vvix REAL, price REAL, state_json TEXT,
  outcome TEXT, exit_price REAL, exit_ts_ms INTEGER, pnl_pts REAL, resolved_at INTEGER,
  UNIQUE(trading_day, symbol, pivot, direction, level)
)`);
const insert = db.prepare(`INSERT OR IGNORE INTO shadow_setups
  (trading_day,ts_ms,ts_et,symbol,family,pivot,direction,size_tier,level,entry,stop,targets,bounce_vs_break,base_prob,
   gate_mode,gate_reasons,lm_code,dd_ratio,res_white,res_blue,res_orange,gm,vx,bbb,vvix,price,state_json)
  VALUES (@trading_day,@ts_ms,@ts_et,@symbol,@family,@pivot,@direction,@size_tier,@level,@entry,@stop,@targets,@bounce_vs_break,@base_prob,
   @gate_mode,@gate_reasons,@lm_code,@dd_ratio,@res_white,@res_blue,@res_orange,@gm,@vx,@bbb,@vvix,@price,@state_json)`);

const ticks = new Database(TICKS_DB, { readonly: true, fileMustExist: true });
const lastPriceQ = ticks.prepare('SELECT price FROM trades WHERE symbol=? ORDER BY ts DESC LIMIT 1');

function readLevels(symbol: 'NQ' | 'ES'): DailyLevels | undefined {
  const file = LEVELS_FILE[symbol];
  if (!fs.existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lv = doc.days?.[etDate()]?.levels?.find((x: { symbol: string }) => x.symbol === symbol);
    if (!lv) return undefined;
    return { ts: 0, source: 'levels', type: 'daily', tradingDay: etDate(), ...lv } as DailyLevels;
  } catch { return undefined; }
}

function tick(): void {
  loadContext(); // refresh from rs-context.json (rs-feed updates every 5s)
  const day = etDate();
  const summary: string[] = [];
  for (const sym of ['NQ', 'ES'] as const) {
    const rs = getContext(sym);
    const levels = readLevels(sym);
    const price = (lastPriceQ.get(sym) as { price: number } | undefined)?.price;
    if (price == null) { summary.push(`${sym}:noPrice`); continue; }
    const ms = deriveMarketState({ symbol: sym, rs, levels, price, open: levels?.openPrice });
    const setups = evaluateEst(ms);
    let fresh = 0;
    for (const s of setups) {
      const info = insert.run({
        trading_day: day, ts_ms: Date.now(), ts_et: etTime(),
        symbol: sym, family: s.family, pivot: s.pivot, direction: s.direction, size_tier: s.sizeTier,
        level: s.level, entry: s.entry, stop: s.stop, targets: JSON.stringify(s.targets),
        bounce_vs_break: s.bounceVsBreak, base_prob: s.baseProb,
        gate_mode: ms.gate.mode, gate_reasons: JSON.stringify(ms.gate.reasons), lm_code: ms.lmCode ?? null,
        dd_ratio: ms.confluence.ddRatio, res_white: ms.confluence.resWhite, res_blue: ms.confluence.resBlue,
        res_orange: ms.confluence.resOrange, gm: ms.confluence.gm,
        vx: ms.confluence.vx, bbb: ms.confluence.bbb, vvix: ms.confluence.vvix,
        price, state_json: JSON.stringify(ms),
      });
      if (info.changes) { fresh++; log(`NEW ${sym} ${s.pivot} ${s.direction} ${s.sizeTier} @${s.entry} stop ${s.stop} (gate ${ms.gate.mode}) · ${s.confluenceNote}`); }
    }
    summary.push(`${sym}@${price} gate=${ms.gate.mode} setups=${setups.length}(+${fresh})`);
  }
  log(summary.join('  |  '));
}

if (ONCE) {
  tick();
  db.close(); ticks.close();
  process.exit(0);
}

log(`rs-shadow live — every ${INTERVAL / 1000}s during RTH (09:30–16:00 ET, Mon–Fri) → ${SHADOW_DB}`);
let wasRTH: boolean | null = null;
const run = () => {
  const rth = inRTH();
  if (rth !== wasRTH) { log(rth ? 'RTH open — shadowing' : 'outside RTH — idle'); wasRTH = rth; }
  if (!rth) return;
  try { tick(); } catch (e) { log('ERROR', (e as Error).message); }
};
run();
setInterval(run, INTERVAL);
