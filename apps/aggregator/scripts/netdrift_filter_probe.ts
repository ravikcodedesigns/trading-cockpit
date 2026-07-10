// Probe: does the raw /v1 net-drift `filter` accept ABJ's 0DTE/OTM/exclude-complex
// keys, and do the numbers actually change vs unfiltered? Locks the request schema
// for the forward-capture job. Run:
//   pnpm --filter @trading/aggregator exec tsx scripts/netdrift_filter_probe.ts 2026-07-09 NDX
import 'dotenv/config';
import { qdPost } from '../src/sources/quantdata.js';

const PATH = '/options/tool/net-drift';
const day = process.argv[2] ?? '2026-07-09';
const ticker = process.argv[3] ?? 'NDX';

function summ(json: any) {
  const data = json?.data ?? json;
  const rows = Array.isArray(data) ? data : Object.entries(data ?? {}).map(([ts, r]: any) => ({ timestamp: ts, ...r }));
  let nc = 0, np = 0, n = 0;
  for (const r of rows) { nc += +(r.netCallPremium ?? 0); np += +(r.netPutPremium ?? 0); n++; }
  return { buckets: n, sumNetCall: Math.round(nc), sumNetPut: Math.round(np) };
}

async function tryBody(label: string, body: Record<string, unknown>) {
  try {
    const json = await qdPost(PATH, body);
    console.log(`OK   ${label.padEnd(38)} ${JSON.stringify(summ(json))}`);
  } catch (e: any) {
    console.log(`FAIL ${label.padEnd(38)} ${String(e.message).slice(0, 120)}`);
  }
}

async function main() {
  console.log(`probe net-drift ${ticker} ${day}\n`);
  await tryBody('unfiltered', { filter: { ticker }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('0DTE (expirationDate)', { filter: { ticker, expirationDate: day }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('0DTE (expirationDates[])', { filter: { ticker, expirationDates: [day] }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('OTM (moneyType)', { filter: { ticker, moneyType: 'OUT_OF_THE_MONEY' }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('OTM (moneyTypes[])', { filter: { ticker, moneyTypes: ['OUT_OF_THE_MONEY'] }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('exclude complex/tied/floor/cxl', { filter: { ticker, isComplex: false, isTied: false, isFloor: false, isCancelled: false }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  await tryBody('ABJ full (nested filter keys)', { filter: { ticker, expirationDate: day, moneyType: 'OUT_OF_THE_MONEY', isComplex: false, isTied: false, isFloor: false, isCancelled: false }, sessionDate: day, aggregationPeriod: 'ONE_MINUTE' });
  // filterExpression form (mirrors the MCP) in case nested filter keys are ignored
  await tryBody('ABJ via filterExpression', {
    filter: { ticker },
    filterExpression: { conjunction: 'AND', filters: [
      { field: 'MONEY_TYPE', operation: 'EQUALS', values: ['OUT_OF_THE_MONEY'] },
      { field: 'IS_COMPLEX', operation: 'EQUALS', values: ['false'] },
      { field: 'IS_TIED', operation: 'EQUALS', values: ['false'] },
      { field: 'IS_FLOOR', operation: 'EQUALS', values: ['false'] },
      { field: 'IS_CANCELLED', operation: 'EQUALS', values: ['false'] },
      { field: 'EXPIRATION_DATE', operation: 'EQUALS', values: [day] },
    ] },
    sessionDate: day, aggregationPeriod: 'ONE_MINUTE',
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
