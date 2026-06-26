#!/usr/bin/env python3
# Watch l3_signal_validations: announce each new FLIP/CONT validation, and walk it forward
# (FLIP long 80/55, short 80/105, CONT 80/70) against ticks.db until TP/SL hits → emit WIN/LOSS
# and whether the L3 VALID/INVALID tag matched. Writes outcome back to the table. OPEN (tradable)
# rows are flagged ***. Emits one line per NEW signal and one per RESOLVED — nothing else.
import sqlite3, time, datetime, sys

SH='data/l3-shadow.db'; TK='data/ticks.db'
def et(ms): return (datetime.datetime.utcfromtimestamp(ms/1000)-datetime.timedelta(hours=4)).strftime('%H:%M:%S')
def emit(s): print(s, flush=True)

def bracket(pattern, long):
    if pattern=='CONT': return 80,70
    return (80,55) if long else (80,105)

seen=set()
emit(f"[watch] signal-validation watcher started {et(int(time.time()*1000))} ET")
while True:
    try:
        sh=sqlite3.connect(SH); sh.row_factory=sqlite3.Row
        tk=sqlite3.connect(TK)
        rows=sh.execute("SELECT * FROM l3_signal_validations WHERE trading_day=date('now') OR ts_ms > ?",
                        (int(time.time()*1000)-12*3600*1000,)).fetchall()
        for r in rows:
            sid=r['signal_id']; tag=r['tag']
            kind = 'TRADABLE' if r['action']=='OPEN' else ('QUALIFIED' if r['qualified'] else 'SHADOW')
            flag = f'***{kind}*** ' if kind=='TRADABLE' else f'[{kind}] '
            if sid not in seen:
                seen.add(sid)
                emit(f"{et(r['ts_ms'])} NEW {flag}{r['symbol']} {tag} ({r['action']}/q{r['qualified']}) entry={r['entry']} | L3 score {r['score_dir']} vs opp {r['score_opp']}")
            if r['outcome'] is None:
                long=(r['direction']=='long'); e=r['entry']; tp_p,sl_p=bracket(r['pattern'],long)
                tp = e+tp_p if long else e-tp_p
                sl = e-sl_p if long else e+sl_p
                tpt=tk.execute(f"SELECT MIN(ts) FROM trades WHERE symbol=? AND ts>? AND price {'>=' if long else '<='} ?",(r['symbol'],r['ts_ms'],tp)).fetchone()[0]
                slt=tk.execute(f"SELECT MIN(ts) FROM trades WHERE symbol=? AND ts>? AND price {'<=' if long else '>='} ?",(r['symbol'],r['ts_ms'],sl)).fetchone()[0]
                outcome=None
                if tpt and (not slt or tpt<slt): outcome,pnl,ex=('WIN',tp_p,tpt)
                elif slt: outcome,pnl,ex=('LOSS',-sl_p,slt)
                if outcome:
                    win=(outcome=='WIN'); match=(r['valid']==1)==win
                    sh.execute("UPDATE l3_signal_validations SET outcome=?,pnl_pts=?,resolved_at=? WHERE signal_id=?",(outcome,pnl,int(time.time()*1000),sid))
                    sh.commit()
                    verdict='VALID' if r['valid'] else 'INVALID'
                    emit(f"{et(ex)} RESOLVED {flag}{r['symbol']} {tag} → {outcome} ({pnl:+}pt) | L3={verdict} {'MATCHED' if match else 'MISSED' if win else 'WRONG'}")
        sh.close(); tk.close()
    except Exception as e:
        emit(f"[watch] err: {e}")
    time.sleep(45)
