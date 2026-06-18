#!/usr/bin/env python3
"""
harden_truecvd.py — permutation + bootstrap on the long TRUE-CVD floor.

SANDBOX / read-only. June-only (the entire true-CVD universe). No OOS split is
possible (May has no trustworthy true CVD), so this measures only:
  - PERMUTATION: is the W/L separation by true CVD better than chance on June?
       * pre-committed threshold -3000 (single test, no multiple-comparison risk)
       * sweep over a grid (multiple-comparison corrected = best-across-grid null)
  - BOOTSTRAP: how stable are AUC(0.749) and the gated WR/pnl? (95% CI)
Significance + stability ONLY — does NOT prove out-of-sample generalization.
"""

from datetime import datetime, timezone
import numpy as np

from cvd_headtohead import load_signals, day_tape, walk_forward, et_ms, TPSL, auc, MBO

GRID = [-1000, -2000, -3000, -4000, -5000, -6000, -8000, -10000]
PRECOMMIT = -3000
B = 10000
rng = np.random.default_rng(20260617)


ALLOWED_ACTIONS = {"OPEN", "SKIP_CVD"}  # CVD-decided population (n=44); set None for all


def build_long_recs():
    import duckdb
    con = duckdb.connect(); con.execute("PRAGMA threads=4")
    sigs = load_signals()
    by_date = {}
    for r in sigs:
        if r["direction"] != "long":
            continue
        if ALLOWED_ACTIONS is not None and r["action"] not in ALLOWED_ACTIONS:
            continue
        date = datetime.fromtimestamp(r["signal_ts"] / 1000 - 4 * 3600, timezone.utc).strftime("%Y-%m-%d")
        by_date.setdefault(date, []).append(r)
    recs = []
    for date in sorted(by_date):
        if not (MBO / "trades" / "symbol=NQ" / f"date={date}").exists():
            continue
        ts, px, cum = day_tape(con, date)
        oi = np.searchsorted(ts, et_ms(date, 9, 30), side="left")
        cum_open = cum[oi - 1] if oi > 0 else 0.0
        close_ms = et_ms(date, 15, 54)
        for r in by_date[date]:
            tp, sl = TPSL[(r["rule_id"], "long")]
            si = np.searchsorted(ts, r["signal_ts"], side="right") - 1
            if si < 0:
                continue
            true_cvd = float(cum[si] - cum_open)
            ei = np.searchsorted(ts, r["signal_ts"], side="right")
            outcome, pnl = walk_forward(ts, px, ei, r["entry"], "long", tp, sl, close_ms)
            if outcome in ("WIN", "LOSS"):
                recs.append((true_cvd, 1 if outcome == "WIN" else 0, pnl))
    return recs


def gated(cvd, win, pnl, thr):
    m = cvd >= thr
    n = int(m.sum())
    if n == 0:
        return 0, 0.0, 0.0
    return n, float(win[m].mean()), float(pnl[m].sum())


def main():
    recs = build_long_recs()
    cvd = np.array([r[0] for r in recs])
    win = np.array([r[1] for r in recs])
    pnl = np.array([r[2] for r in recs])
    n = len(recs)
    base_wr, base_pnl = win.mean(), pnl.sum()
    a_obs = auc(list(cvd[win == 1]), list(cvd[win == 0]))
    print(f"=== TRUE-CVD long floor — permutation + bootstrap (June, n={n}) ===")
    print(f"baseline: WR={100*base_wr:.0f}%  pnl={base_pnl:+.0f}pt  AUC={a_obs:.3f}\n")

    # observed gate metrics
    print("observed gate (true CVD >= thr):")
    obs = {}
    for thr in GRID:
        gn, gwr, gp = gated(cvd, win, pnl, thr)
        obs[thr] = (gn, gwr, gp)
        tag = "  <- pre-committed" if thr == PRECOMMIT else ""
        print(f"   >= {thr:>7}: n={gn:2} WR={100*gwr:3.0f}% pnl={gp:+7.0f}pt{tag}")

    # ── PERMUTATION: shuffle (win,pnl) vs cvd; metric = gated net pnl ──
    obs_pre = obs[PRECOMMIT][2]
    obs_best = max(obs[t][2] for t in GRID)
    obs_best_thr = max(GRID, key=lambda t: obs[t][2])
    obs_pre_auc = a_obs
    cnt_pre = cnt_best = cnt_auc = 0
    for _ in range(B):
        perm = rng.permutation(n)
        w_s, p_s = win[perm], pnl[perm]
        # pre-committed threshold
        if gated(cvd, w_s, p_s, PRECOMMIT)[2] >= obs_pre:
            cnt_pre += 1
        # sweep-corrected: best gated pnl across grid under the null
        best_null = max(gated(cvd, w_s, p_s, t)[2] for t in GRID)
        if best_null >= obs_best:
            cnt_best += 1
        # AUC null
        if auc(list(cvd[w_s == 1]), list(cvd[w_s == 0])) >= obs_pre_auc:
            cnt_auc += 1
    p_pre = (cnt_pre + 1) / (B + 1)
    p_best = (cnt_best + 1) / (B + 1)
    p_auc = (cnt_auc + 1) / (B + 1)
    print(f"\nPERMUTATION ({B} shuffles, label-permuted):")
    print(f"   pre-committed thr={PRECOMMIT}: net pnl={obs_pre:+.0f}pt   p={p_pre:.4f}")
    print(f"   sweep-corrected best thr={obs_best_thr}: net pnl={obs_best:+.0f}pt   p={p_best:.4f}")
    print(f"   AUC={obs_pre_auc:.3f}                          p={p_auc:.4f}")

    # ── BOOTSTRAP: resample n longs with replacement; CI on AUC + gate@-3000 ──
    aucs, wrs, pnls, ns = [], [], [], []
    for _ in range(B):
        idx = rng.integers(0, n, n)
        c, w, p = cvd[idx], win[idx], pnl[idx]
        au = auc(list(c[w == 1]), list(c[w == 0]))
        if not np.isnan(au):
            aucs.append(au)
        gn, gwr, gp = gated(c, w, p, PRECOMMIT)
        if gn > 0:
            wrs.append(gwr); pnls.append(gp); ns.append(gn)
    ci = lambda v: (np.percentile(v, 2.5), np.percentile(v, 97.5))
    al, ah = ci(aucs); wl, wh = ci(wrs); pl, ph = ci(pnls)
    print(f"\nBOOTSTRAP ({B} resamples, 95% CI):")
    print(f"   AUC:            {a_obs:.3f}   CI [{al:.3f}, {ah:.3f}]")
    print(f"   gate@{PRECOMMIT} WR:  {100*obs[PRECOMMIT][1]:.0f}%   CI [{100*wl:.0f}%, {100*wh:.0f}%]")
    print(f"   gate@{PRECOMMIT} pnl: {obs[PRECOMMIT][2]:+.0f}pt CI [{pl:+.0f}, {ph:+.0f}]  median n={int(np.median(ns))}")
    print(f"\nNOTE: significance + stability on June only. NOT out-of-sample — no")
    print(f"      held-out true-CVD period exists. OOS needs forward-accumulation")
    print(f"      or the 5-yr MBO historical.")


if __name__ == "__main__":
    main()
