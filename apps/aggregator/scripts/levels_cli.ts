#!/usr/bin/env node
/**
 * levels:add CLI
 *
 * Add or update entries in daily_levels.json without hand-editing JSON.
 *
 * Usage modes:
 *
 * 1) Add a new full day (new trading-day entry):
 *    pnpm --filter aggregator levels:add new \
 *      --date 2026-05-07 \
 *      --bull-low 27235 --bull-high 28928 \
 *      --bear-low 27185.40 --bear-high 27193.70 \
 *      --dd-upper 27849 --dd-lower 27347 \
 *      --hp 27069.70 \
 *      --mhp 26945.70 \
 *      --qqq-open 27491.25 --qqq-close 27577 \
 *      --hg 27413.88 \
 *      --on-mhp 27444.97 --on-hp 27404.86
 *
 *    After RTH open, add --open-price to trigger auto LM code computation:
 *    pnpm --filter aggregator levels:add update \
 *      --date 2026-05-07 \
 *      --open-price 27310.50
 *
 *    Or override LM code manually (for LP/IP edge cases):
 *    pnpm --filter aggregator levels:add update \
 *      --date 2026-05-07 \
 *      --lm-code BLD
 *
 * 2) Mid-day update of an existing day's overnight values:
 *    pnpm --filter aggregator levels:add update \
 *      --date 2026-05-07 \
 *      --on-mhp 27450 --on-hp 27410 \
 *      --dd-upper 27860 --dd-lower 27350 \
 *      --qqq-close 27580
 *
 * 3) Show current contents:
 *    pnpm --filter aggregator levels:add show
 *
 * 4) Validate the file:
 *    pnpm --filter aggregator levels:add validate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.resolve(__dirname, '../../../daily_levels.json');

// --- arg parsing ---

interface Args {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exit(1);
  }
  const command = argv[0];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return { command, flags };
}

function printHelp() {
  console.log(`
Usage:
  levels:add new --date YYYY-MM-DD --bull-low N --bull-high N \\
                 --bear-low N --bear-high N --dd-upper N --dd-lower N \\
                 --hp N --mhp N \\
                 [--qqq-open N --qqq-close N --hg N --on-mhp N --on-hp N] \\
                 [--open-price N] [--lm-code BLD] [--symbol NQ]

  levels:add update --date YYYY-MM-DD
                 [--dd-upper N --dd-lower N]
                 [--mhp N]           -- update Monthly Hedge Pressure
                 [--open-price N]    -- set RTH open; triggers LM code auto-compute
                 [--lm-code CODE]    -- manual LM code override (LP/IP edge cases)
                                        valid: BLD BLU BSD BSU BrLD BrLU BrSD BrSU
                 [--qqq-close N --on-mhp N --on-hp N [--hg N]]
                   (HG auto-computed as midpoint of QQQ Open + QQQ Close; --hg overrides)

  levels:add show
  levels:add validate

  All numbers are floating-point.  --symbol defaults to NQ.
  --mhp is Monthly Hedge Pressure (first-class field, NOT in additionalLevels).
  --open-price + --mhp together enable LM code auto-computation in the aggregator.
`);
}

// --- file I/O ---

interface RawLevel {
  symbol: string;
  bullZone: { low: number; high: number };
  bearZone: { low: number; high: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  mhp?: number;        // Monthly Hedge Pressure — dedicated first-class field
  openPrice?: number;  // RTH 09:30 open — triggers LM code auto-computation
  lmCode?: string;     // manual override for LP/IP edge cases
  additionalLevels?: AdditionalLevel[];
  notes?: string;
}

interface AdditionalLevel {
  price: number;
  label: string;
  color?: string;
  style?: string;
  width?: number;
}

interface FileShape {
  days: Record<string, { levels: RawLevel[] }>;
}

function loadFile(): FileShape {
  if (!fs.existsSync(FILE_PATH)) {
    return { days: {} };
  }
  const raw = fs.readFileSync(FILE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { days?: Record<string, { levels: RawLevel[] }>; levels?: RawLevel[] };

  // Migrate legacy single-levels shape into a "today" entry.
  if (parsed.days) {
    return { days: parsed.days };
  }
  if (Array.isArray(parsed.levels)) {
    const today = todayInNY();
    return { days: { [today]: { levels: parsed.levels } } };
  }
  return { days: {} };
}

function saveFile(data: FileShape) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${FILE_PATH}`);
}

function todayInNY(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// --- helpers ---

function num(flags: Record<string, string>, key: string, required = false): number | undefined {
  const v = flags[key];
  if (v === undefined) {
    if (required) {
      console.error(`Missing required flag: --${key}`);
      process.exit(1);
    }
    return undefined;
  }
  const n = parseFloat(v);
  if (Number.isNaN(n)) {
    console.error(`--${key} must be a number, got: ${v}`);
    process.exit(1);
  }
  return n;
}

function buildAdditionalLevels(flags: Record<string, string>): AdditionalLevel[] {
  const out: AdditionalLevel[] = [];
  const qqqOpen  = num(flags, 'qqq-open');
  const qqqClose = num(flags, 'qqq-close');
  const hg       = num(flags, 'hg');
  const onMhp    = num(flags, 'on-mhp');
  const onHp     = num(flags, 'on-hp');

  // MHP is a first-class RawLevel field — do NOT add it to additionalLevels
  if (qqqOpen  !== undefined) out.push({ price: qqqOpen,  label: 'QQQ Open',  color: '#ffffff', style: 'solid',        width: 2 });
  if (qqqClose !== undefined) out.push({ price: qqqClose, label: 'QQQ Close', color: '#ffffff', style: 'solid',        width: 2 });
  if (onMhp    !== undefined) out.push({ price: onMhp,    label: 'ON MHP',    color: '#f2a633', style: 'solid',        width: 2 });
  if (hg       !== undefined) out.push({ price: hg,       label: 'HG',        color: '#ffffff', style: 'large-dashed', width: 2 });
  if (onHp     !== undefined) out.push({ price: onHp,     label: 'ON HP',     color: '#f2a633', style: 'solid',        width: 2 });

  return out.sort((a, b) => b.price - a.price);
}

// --- commands ---

function cmdNew(flags: Record<string, string>) {
  const date = flags.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('--date must be YYYY-MM-DD');
    process.exit(1);
  }
  const symbol = flags.symbol ?? 'NQ';

  const mhp        = num(flags, 'mhp');
  const openPrice  = num(flags, 'open-price');
  const lmCode     = flags['lm-code'];

  const level: RawLevel = {
    symbol,
    bullZone: {
      low: num(flags, 'bull-low', true)!,
      high: num(flags, 'bull-high', true)!,
    },
    bearZone: {
      low: num(flags, 'bear-low', true)!,
      high: num(flags, 'bear-high', true)!,
    },
    ddBands: {
      upper: num(flags, 'dd-upper', true)!,
      lower: num(flags, 'dd-lower', true)!,
    },
    hedgePressure: num(flags, 'hp', true)!,
    ...(mhp       !== undefined && { mhp }),
    ...(openPrice !== undefined && { openPrice }),
    ...(lmCode    !== undefined && { lmCode }),
    additionalLevels: buildAdditionalLevels(flags),
    notes: flags.notes ?? `${date} levels`,
  };

  const file = loadFile();
  if (file.days[date]) {
    console.log(`Replacing existing entry for ${date}`);
  }
  file.days[date] = { levels: [level] };
  saveFile(file);
  console.log(`Added levels for ${date}, symbol ${symbol}`);
}

function cmdUpdate(flags: Record<string, string>) {
  const date = flags.date;
  if (!date) {
    console.error('--date YYYY-MM-DD required');
    process.exit(1);
  }
  const file = loadFile();
  const dayEntry = file.days[date];
  if (!dayEntry) {
    console.error(`No entry for ${date}. Use 'new' first.`);
    process.exit(1);
  }

  const symbol = flags.symbol ?? 'NQ';
  const level = dayEntry.levels.find(l => l.symbol === symbol);
  if (!level) {
    console.error(`No ${symbol} entry for ${date}`);
    process.exit(1);
  }

  let modified = 0;

  // Top-level fields
  const ddU       = num(flags, 'dd-upper');
  const ddL       = num(flags, 'dd-lower');
  const mhp       = num(flags, 'mhp');
  const openPrice = num(flags, 'open-price');
  const lmCode    = flags['lm-code'];

  if (ddU       !== undefined) { level.ddBands.upper = ddU;   modified++; }
  if (ddL       !== undefined) { level.ddBands.lower = ddL;   modified++; }
  if (mhp       !== undefined) { level.mhp       = mhp;       modified++; }
  if (openPrice !== undefined) { level.openPrice = openPrice; modified++; }
  if (lmCode    !== undefined) { level.lmCode    = lmCode;    modified++; }

  // Evening/morning updatable fields in additionalLevels
  const onMhp    = num(flags, 'on-mhp');
  const onHp     = num(flags, 'on-hp');
  const qqqClose = num(flags, 'qqq-close');
  const hg       = num(flags, 'hg');

  level.additionalLevels = level.additionalLevels ?? [];

  // Ensure MHP is not in additionalLevels — it's a top-level field now
  level.additionalLevels = level.additionalLevels.filter(a => a.label.toLowerCase().trim() !== 'mhp');

  const upsert = (label: string, price: number | undefined, color: string, style: string, width: number) => {
    if (price === undefined) return;
    const existing = level.additionalLevels!.find(a => a.label === label);
    if (existing) {
      existing.price = price;
    } else {
      level.additionalLevels!.push({ price, label, color, style, width });
    }
    modified++;
  };
  upsert('ON MHP',    onMhp,    '#f2a633', 'solid',        2);
  upsert('ON HP',     onHp,     '#f2a633', 'solid',        2);
  upsert('QQQ Close', qqqClose, '#ffffff', 'solid',        2);

  // Auto-compute HG = midpoint(QQQ Open, QQQ Close) when qqq-close is provided.
  // An explicit --hg flag overrides this.
  const autoHg = (() => {
    if (hg !== undefined) return hg;
    if (qqqClose === undefined) return undefined;
    const qqqOpenEntry = level.additionalLevels!.find(a => a.label === 'QQQ Open');
    if (!qqqOpenEntry) return undefined;
    return Math.round(((qqqOpenEntry.price + qqqClose) / 2) * 100) / 100;
  })();
  upsert('HG', autoHg, '#ffffff', 'large-dashed', 2);

  // Re-sort additional levels by price
  level.additionalLevels.sort((a, b) => b.price - a.price);

  if (modified === 0) {
    console.error('No fields specified to update. Pass at least one of: --dd-upper, --dd-lower, --mhp, --open-price, --lm-code, --on-mhp, --on-hp, --qqq-close, --hg');
    process.exit(1);
  }

  saveFile(file);
  console.log(`Updated ${modified} field(s) for ${date}, symbol ${symbol}`);
}

function cmdShow() {
  const file = loadFile();
  const dates = Object.keys(file.days).sort();
  if (dates.length === 0) {
    console.log('(no level entries)');
    return;
  }
  for (const date of dates) {
    console.log(`\n=== ${date} ===`);
    for (const lv of file.days[date].levels) {
      console.log(`  ${lv.symbol}:`);
      console.log(`    bullZone: ${lv.bullZone.low} - ${lv.bullZone.high}`);
      console.log(`    bearZone: ${lv.bearZone.low} - ${lv.bearZone.high}`);
      console.log(`    ddBands:  ${lv.ddBands.lower} - ${lv.ddBands.upper}`);
      console.log(`    HP: ${lv.hedgePressure}`);
      if (lv.mhp       !== undefined) console.log(`    MHP: ${lv.mhp}`);
      if (lv.openPrice !== undefined) console.log(`    openPrice: ${lv.openPrice}`);
      if (lv.lmCode    !== undefined) console.log(`    lmCode: ${lv.lmCode} (manual override)`);
      if (lv.additionalLevels) {
        for (const al of lv.additionalLevels) {
          console.log(`    ${al.label}: ${al.price}`);
        }
      }
    }
  }
}

function cmdValidate() {
  try {
    const file = loadFile();
    const dates = Object.keys(file.days);
    let totalLevels = 0;
    for (const date of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error(`Invalid date format: ${date}`);
        process.exit(1);
      }
      for (const lv of file.days[date].levels) {
        if (!lv.symbol || !lv.bullZone || !lv.bearZone || !lv.ddBands || lv.hedgePressure === undefined) {
          console.error(`Day ${date} has incomplete entry`);
          process.exit(1);
        }
        totalLevels++;
      }
    }
    console.log(`OK. ${dates.length} day(s), ${totalLevels} total level entr(ies).`);
  } catch (err) {
    console.error('Validation failed:', err);
    process.exit(1);
  }
}

// --- main ---

const { command, flags } = parseArgs();
switch (command) {
  case 'new': cmdNew(flags); break;
  case 'update': cmdUpdate(flags); break;
  case 'show': cmdShow(); break;
  case 'validate': cmdValidate(); break;
  case 'help':
  case '--help':
  case '-h': printHelp(); break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
