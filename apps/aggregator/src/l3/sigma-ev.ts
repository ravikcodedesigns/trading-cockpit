// sigma-ev.ts — CRACKER Phase 0.5: the FROZEN event-time volatility estimator.
//
// σ_ev is the noise ruler for the whole system: it floors the Gate-2 stop
// (1R = max(structural, 1.0·σ_ev·√h_ref)), sizes the vertical barrier
// (T = 2·(1R/σ_1m)²), and scales the swing detector's base vol. One definition,
// frozen here; changing it mid-study is a protocol violation.
//
// FROZEN SPEC (CRACKER_PLAN §0.5):
//   • Input: 1-minute log returns of the mid/last price, bucketed internally.
//   • DRIFT-STRIPPED: returns are centered by an EWMA mean before squaring —
//     a trend day's drift is not volatility (the DDA long-drift lesson).
//   • EWMA variance, HALF-LIFE 30 min: λ = 2^(−1/30) per 1-min step. Slow
//     enough to be stable (the v1 2-min-reactive vol caused granularity drift),
//     fast enough to adapt within a session.
//   • SESSION-ANCHORED: state resets at 18:00 ET (futures reopen). During the
//     first WARMUP_MIN minutes the estimator returns the previous session's
//     final value (carried), or the floor if none.
//   • FLOOR/CAP in points: σ_1m ∈ [0.5, 60] (NQ scale) — no noise-swing
//     collapse in dead tape, no blowout on a single print.
//   (EWMA here is a statistical variance estimator, not a price indicator —
//    the lagging-indicator ban concerns signals.)
//
// Units: sigma1m() returns POINTS per √minute; sigmaH(h) = σ_1m·√h points.

export const SIGMA_CFG = {
  HALF_LIFE_MIN: 30,
  WARMUP_MIN: 15,
  FLOOR_PT: 0.5,
  CAP_PT: 60,
  SESSION_RESET_ET_HOUR: 18,   // futures reopen
};

const LAMBDA = Math.pow(2, -1 / SIGMA_CFG.HALF_LIFE_MIN);

/** ET hour of an epoch-ms timestamp (DST-aware). */
function etHour(tsMs: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(tsMs)));
}

export class SigmaEv {
  private curMinute = -1;
  private lastClose = NaN;
  private ewVar = NaN;          // EWMA of centered squared 1-min log returns
  private ewMean = 0;           // EWMA drift (same λ)
  private minutesSeen = 0;
  private carried = NaN;        // previous session's final σ_1m (points)
  private lastPrice = NaN;
  private lastSessionKey = '';

  /** Feed every price observation (any cadence); minute bucketing is internal. */
  update(price: number, tsMs: number): void {
    // session reset at 18:00 ET — key = date of the 18:00 boundary we're past
    const key = sessionKey(tsMs);
    if (key !== this.lastSessionKey) {
      if (this.minutesSeen > 0) this.carried = this.sigma1m();   // carry final value across the reset
      this.lastSessionKey = key;
      this.curMinute = -1; this.lastClose = NaN; this.ewVar = NaN; this.ewMean = 0; this.minutesSeen = 0;
    }
    const m = Math.floor(tsMs / 60_000);
    if (this.curMinute === -1) { this.curMinute = m; this.lastPrice = price; return; }
    if (m > this.curMinute) {
      // minute rolled: lastPrice is the completed minute's close
      if (isFinite(this.lastClose) && this.lastClose > 0 && this.lastPrice > 0) {
        const r = Math.log(this.lastPrice / this.lastClose);
        const centered = r - this.ewMean;
        this.ewMean = LAMBDA * this.ewMean + (1 - LAMBDA) * r;
        this.ewVar = isFinite(this.ewVar) ? LAMBDA * this.ewVar + (1 - LAMBDA) * centered * centered : centered * centered;
        this.minutesSeen++;
      }
      this.lastClose = this.lastPrice;
      this.curMinute = m;
    }
    this.lastPrice = price;
  }

  /** σ per √minute, in POINTS at the current price level. Floor/cap applied. */
  sigma1m(): number {
    if (this.minutesSeen < SIGMA_CFG.WARMUP_MIN) {
      return isFinite(this.carried) ? this.carried : SIGMA_CFG.FLOOR_PT;   // warmup: carry or floor
    }
    const retSigma = Math.sqrt(Math.max(0, this.ewVar));
    const pts = retSigma * (isFinite(this.lastPrice) ? this.lastPrice : 0);
    return Math.min(SIGMA_CFG.CAP_PT, Math.max(SIGMA_CFG.FLOOR_PT, pts));
  }

  /** Diffusion-scaled noise band over a horizon of h minutes: σ_1m·√h (points). */
  sigmaH(hMin: number): number { return this.sigma1m() * Math.sqrt(hMin); }
}

/** Session key: sessions run 18:00 ET → 18:00 ET; key = the calendar date (ET) on which the session STARTED. */
function sessionKey(tsMs: number): string {
  const shifted = tsMs - SIGMA_CFG.SESSION_RESET_ET_HOUR * 3600_000;
  // approximate ET date via formatter (DST-aware)
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(shifted));
  return d;
}
