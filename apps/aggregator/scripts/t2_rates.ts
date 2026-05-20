import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');
const db = new Database(DB_PATH, { readonly: true });

const rows = db.prepare(`
  SELECT strategy_version, direction, pattern,
    hit20, hit40, hit60,
    dd_at_20, dd_at_40, dd_at_60,
    max_gain, max_dd,
    time_to_hit20, time_to_hit40
  FROM h_expl_outcomes
  WHERE strategy_version IN ('H','EXPL')
`).all() as any[];

const groups: Record<string, any[]> = {};
for (const r of rows) {
  const key = r.strategy_version === 'EXPL' ? 'EXPL long' :
    `H ${r.pattern} ${r.direction}`;
  if (!groups[key]) groups[key] = [];
  groups[key].push(r);
}

for (const [grp, sigs] of Object.entries(groups)) {
  const pass = sigs.filter((s: any) => s.hit20 === 1 && s.dd_at_20 !== null && s.dd_at_20 < 42);
  const extTo40 = pass.filter((s: any) => s.hit40 === 1);
  const extTo60 = pass.filter((s: any) => s.hit60 === 1);
  
  const dd40s = extTo40.map((s: any) => s.dd_at_40).filter((d: any) => d !== null) as number[];
  const avgDd40 = dd40s.length ? (dd40s.reduce((a,b) => a+b, 0) / dd40s.length).toFixed(1) : '-';
  const maxDd40 = dd40s.length ? Math.max(...dd40s).toFixed(1) : '-';
  
  const t40s = extTo40.map((s: any) => s.time_to_hit40).filter((t: any) => t !== null) as number[];
  const avgT40 = t40s.length ? (t40s.reduce((a,b) => a+b, 0) / t40s.length).toFixed(0) : '-';
  
  console.log(`\n${grp}: n=${sigs.length}, pass=${pass.length} (${(pass.length/sigs.length*100).toFixed(0)}%)`);
  console.log(`  Pass→T2: ${extTo40.length}/${pass.length} = ${pass.length ? (extTo40.length/pass.length*100).toFixed(0) : '-'}% extend to 40pts`);
  console.log(`  Pass→T3: ${extTo60.length}/${pass.length} = ${pass.length ? (extTo60.length/pass.length*100).toFixed(0) : '-'}% extend to 60pts`);
  console.log(`  dd@T2 (among extenders): avg=${avgDd40}  max=${maxDd40}  avg_time=${avgT40}min`);
}

db.close();
