#!/usr/bin/env node
/**
 * RS Context CLI
 *
 * Commands
 * --------
 * show                              Print current context
 *
 * set  [flags]                      Full morning setup (all in one command)
 *   --greater-market bull|bear|neutral
 *   --dd-ratio    N                 DD Ratio (0-1, >0.5 = bullish)
 *   --mhp-res     N                 MHP resilience (orange) — actual RS value e.g. -40.0
 *   --hp-res      N                 HP resilience (blue)    — actual RS value e.g. +55.7
 *   --res         N                 Redistribution resilience (white/HG) — actual RS value e.g. -11.3
 *   --vx          N                 /VX futures price
 *   --bbb         N                 BBB contango/backwardation midpoint
 *   --vvix        N                 VVIX value
 *
 * bbb  <value>                      9 AM update — refresh BBB only
 *   pnpm context:set bbb 20.5
 *
 * res  <field>  <value>             Intraday — update a single resilience
 *   field: mhp | hp | resilience
 *   value: actual RS platform float e.g. -40.0, +55.7, 0
 *   pnpm context:res mhp -40.0
 *   pnpm context:res hp   55.7
 *   pnpm context:res resilience -11.3
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_PATH = path.resolve(__dirname, '../../../data/rs-context.json');

// ---------- types ----------

type GreaterMarket = 'bull' | 'bear' | 'neutral';
type Resilience = number; // actual float from RS platform e.g. -11.3, +55.7
type ResField = 'mhp' | 'hp' | 'resilience';

interface RSContext {
  greaterMarket: GreaterMarket;
  ddRatio: number;
  mhpResilience: number;
  hpResilience: number;
  redistResilience: number;
  resilience: number;               // backward-compat, mirrors redistResilience
  vx: number;
  bbb: number;
  vvix: number;
  vxAboveBBB: boolean;
  vvixElevated: boolean;
  vvixGolden: boolean;
  isRational: boolean;
  setAt: string;
  tradingDay: string;
}

// ---------- helpers ----------

function load(): RSContext {
  if (!fs.existsSync(CONTEXT_PATH)) {
    die(`No context file at ${CONTEXT_PATH}. Run 'context:set set' first.`);
  }
  return JSON.parse(fs.readFileSync(CONTEXT_PATH, 'utf-8')) as RSContext;
}

function save(ctx: RSContext) {
  fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(ctx, null, 2) + '\n');
}

function derive(ctx: Omit<RSContext, 'vxAboveBBB' | 'vvixElevated' | 'vvixGolden' | 'isRational'>): RSContext {
  const vxAboveBBB  = ctx.vx > ctx.bbb;
  const vvixElevated = ctx.vvix > 100;
  const vvixGolden  = ctx.vvix < 90;
  const isRational  = !vxAboveBBB && !vvixElevated;
  return { ...ctx, vxAboveBBB, vvixElevated, vvixGolden, isRational };
}

function todayNY(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseNum(s: string, label: string): number {
  const n = parseFloat(s);
  if (Number.isNaN(n)) die(`${label} must be a number, got: ${s}`);
  return n;
}

function parseRes(s: string): Resilience {
  const n = parseFloat(s);
  if (Number.isNaN(n)) die(`Resilience value must be a number (e.g. -11.3, +55.7, 0) — got: ${s}`);
  return n;
}

function die(msg: string): never {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function resLabel(v: number): string {
  const sign = v > 0 ? '+' : '';
  const dir  = v > 0 ? 'bullish' : v < 0 ? 'bearish' : 'neutral';
  return `${dir} (${sign}${v})`;
}

function printContext(ctx: RSContext) {
  console.log(`
RS Context — ${ctx.tradingDay}  (set ${ctx.setAt})
─────────────────────────────────────────────────
Greater Market : ${ctx.greaterMarket.toUpperCase()}
DD Ratio       : ${ctx.ddRatio}  ${ctx.ddRatio > 0.5 ? '↑ bullish' : ctx.ddRatio < 0.5 ? '↓ bearish' : '→ neutral'}

Resilience
  MHP  (orange) : ${resLabel(ctx.mhpResilience)}
  HP   (blue)   : ${resLabel(ctx.hpResilience)}
  Resilience (white): ${resLabel(ctx.redistResilience)}

Volatility
  /VX            : ${ctx.vx}
  BBB            : ${ctx.bbb}  ${ctx.vxAboveBBB ? '⚠  VX ABOVE BBB — spread entries' : '✓ VX below BBB'}
  VVIX           : ${ctx.vvix}  ${ctx.vvixElevated ? '⚠  ELEVATED (>100)' : ctx.vvixGolden ? '✓ GOLDEN (<90)' : ''}

Rational       : ${ctx.isRational ? '✓ YES' : '✗ NO — irrational rules apply'}
─────────────────────────────────────────────────`);
}

// ---------- commands ----------

function cmdShow() {
  printContext(load());
}

function cmdSet(argv: string[]) {
  const flags = parseFlags(argv);

  // Try to load existing context so we can patch individual fields
  let existing: Partial<RSContext> = {};
  if (fs.existsSync(CONTEXT_PATH)) {
    existing = JSON.parse(fs.readFileSync(CONTEXT_PATH, 'utf-8'));
  }

  const ddRatio       = flags['dd-ratio']       !== undefined ? parseNum(flags['dd-ratio'], '--dd-ratio')   : (existing.ddRatio ?? 0.5);
  const vx            = flags['vx']             !== undefined ? parseNum(flags['vx'], '--vx')               : (existing.vx ?? 20);
  const bbb           = flags['bbb']            !== undefined ? parseNum(flags['bbb'], '--bbb')             : (existing.bbb ?? 20);
  const vvix          = flags['vvix']           !== undefined ? parseNum(flags['vvix'], '--vvix')           : (existing.vvix ?? 95);
  const greaterMarket = (flags['greater-market'] as GreaterMarket | undefined) ?? (existing.greaterMarket ?? 'neutral');
  const mhpRes        = flags['mhp-res']   !== undefined ? parseRes(flags['mhp-res'])   : (existing.mhpResilience   ?? 0);
  const hpRes         = flags['hp-res']    !== undefined ? parseRes(flags['hp-res'])    : (existing.hpResilience    ?? 0);
  const redistRes     = flags['res']       !== undefined ? parseRes(flags['res'])       : (existing.redistResilience ?? 0);

  if (!['bull', 'bear', 'neutral'].includes(greaterMarket)) {
    die(`--greater-market must be bull | bear | neutral`);
  }

  const ctx = derive({
    greaterMarket,
    ddRatio,
    mhpResilience: mhpRes,
    hpResilience: hpRes,
    redistResilience: redistRes,
    resilience: redistRes,
    vx,
    bbb,
    vvix,
    setAt: new Date().toISOString(),
    tradingDay: todayNY(),
  });

  save(ctx);
  console.log('\n✓ Context saved.');
  printContext(ctx);
}

function cmdBBB(argv: string[]) {
  if (argv.length === 0) die('Usage: context:set bbb <value>\n  Example: pnpm context:set bbb 20.5');
  const value = parseNum(argv[0], 'bbb value');
  const ctx = load();
  const updated = derive({ ...ctx, bbb: value, setAt: new Date().toISOString() });
  save(updated);
  console.log(`\n✓ BBB updated: ${ctx.bbb} → ${value}`);
  console.log(`  VX ${updated.vx} ${updated.vxAboveBBB ? '> BBB ⚠  ABOVE — spread entries' : '< BBB ✓'}`);
}

function cmdRes(argv: string[]) {
  if (argv.length < 2) {
    die(
      'Usage: context:res <field> <value>\n' +
      '  field : mhp | hp | resilience\n' +
      '  value : 1 (bullish) | 0 (neutral) | -1 (bearish)\n\n' +
      '  Examples:\n' +
      '    pnpm context:res mhp        -1   MHP resilience        → bearish\n' +
      '    pnpm context:res hp          1   HP resilience         → bullish\n' +
      '    pnpm context:res resilience  0   Resilience (HG/white) → neutral'
    );
  }

  const field = argv[0] as ResField;
  if (!['mhp', 'hp', 'resilience'].includes(field)) {
    die(`field must be mhp | hp | resilience — got: ${field}`);
  }
  const value = parseRes(argv[1]);
  const ctx = load();

  const key = field === 'mhp' ? 'mhpResilience'
            : field === 'hp'  ? 'hpResilience'
            :                   'redistResilience';

  const prev: Resilience = (ctx as Record<string, Resilience>)[key] ?? 0;
  const updated = { ...ctx, [key]: value, setAt: new Date().toISOString() } as RSContext;
  // mirror to backward-compat field
  if (field === 'resilience') { updated.resilience = value; }

  save(updated);

  const fieldName = field === 'mhp' ? 'MHP   (orange)' : field === 'hp' ? 'HP    (blue)  ' : 'Res   (white) ';
  console.log(`\n✓ ${fieldName}: ${resLabel(prev)} → ${resLabel(value)}`);
}

// ---------- flag parser ----------

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else { flags[key] = 'true'; }
    }
  }
  return flags;
}

// ---------- main ----------

function printHelp() {
  console.log(`
RS Context CLI

  show                              Print current context

  set [flags]                       Full morning setup (all in one command)
    --greater-market bull|bear|neutral
    --dd-ratio N                    DD Ratio (0-1, >0.5 = bullish)
    --mhp-res  N                    MHP resilience (orange) e.g. -40.0
    --hp-res   N                    HP resilience (blue)    e.g. +55.7
    --res      N                    Redistribution resilience (white/HG) e.g. -11.3
    --vx N                          /VX price
    --bbb N                         BBB midpoint
    --vvix N                        VVIX value

  bbb <value>                       9 AM — update BBB only
  res <field> <value>               Intraday — flip a single resilience
    field: mhp | hp | resilience
    value: 1 | 0 | -1
`);
}

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'show':       cmdShow();      break;
  case 'set':        cmdSet(rest);   break;
  case 'bbb':        cmdBBB(rest);   break;
  case 'res':
  case 'resilience': cmdRes(rest);   break;
  case 'help':
  case '--help':
  case '-h':         printHelp();    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
