#!/usr/bin/env node
// Feed-health monitor — closes the 06-29 "unnoticed stale feed → live trades on bad regime" gap,
// now covering all three RS sources with source-appropriate thresholds:
//   FEED   (rs-feed → rs-context.json, 5s)  : stale >30s (by feedSetAt) OR dead-zero  → HALT trader + alert
//   MM     (rs-mm   → rs-context-mm.json, 60s): stale >150s                            → alert only
//   LEVELS (rs-levels → daily_levels.json, 09:32): today's NQ set missing              → alert only
// Feed staleness uses feedSetAt (rs-feed's OWN write) so a vx-poller write can't mask a dead rs-feed.
// Standalone + RTH-gated; reads files directly (works even if the aggregator is down). Run ~20s via launchd.
// FEED_HEALTH_FORCE=1 bypasses the RTH/timing gates for testing.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA = path.resolve(__dirname, '../data');
const CTX = path.join(DATA, 'rs-context.json');
const MM = path.join(DATA, 'rs-context-mm.json');
const NQ_LEVELS = path.resolve(__dirname, '../daily_levels.json');
const STALE_FILE = '/tmp/trader.context-stale';   // FEED stale → risk-guard.ts blocks the trader
const MM_MARK = '/tmp/feed-health.mm-stale';       // MM stale   → alert-only episode marker
const LV_MARK = '/tmp/feed-health.levels-stale';   // levels stale → alert-only episode marker
const WS_BEAT = '/tmp/trader.tradovate-ws';        // trader touches this on every Tradovate WS frame (~2.5s)
const WS_MARK = '/tmp/feed-health.ws-stale';       // broker-WS dead → alert-only episode marker
const FEED_STALE_SEC = 30;      // rs-feed 5s cadence → 6×
const MM_STALE_SEC = 150;       // rs-mm 60s cadence → 2.5×
const WS_STALE_SEC = 30;        // Tradovate heartbeats ~2.5s → 30s silence = dead/dropped WS
const WS_KICK_COOLDOWN_MS = 90_000;  // after an auto-restart, wait 90s (restart+reconnect) before retrying
const WS_MAX_KICKS = 3;              // then stop auto-restarting and escalate to a manual alert
const MM_READY_MIN = 577;       // 09:37 ET — rs-mm (09:36) should have written by now
const LEVELS_READY_MIN = 580;   // 09:40 ET — rs-levels (09:32) + retries should be done
const FORCE = process.env.FEED_HEALTH_FORCE === '1';
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';

function etParts() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { wd: g('weekday'), min: parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10), day: `${g('year')}-${g('month')}-${g('day')}` };
}
function macNotify(title, msg) { execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)} sound name "Basso"`], () => {}); }
async function discord(content) { if (!WEBHOOK || typeof fetch !== 'function') return; try { await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, username: 'feed-health' }) }); } catch { /* never throws */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function ageSec(iso) { return iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : Infinity; }
function kickstartTrader() {
  if (process.env.FEED_HEALTH_NO_KICK === '1') return Promise.resolve(true);   // test: exercise logic, don't bounce the trader
  return new Promise((resolve) => execFile('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.cockpit.trader`], (err) => resolve(!err)));
}

// Toggle a marker file + alert once per stale↔fresh transition. (For FEED the marker IS the trader halt.)
async function toggle(markerFile, reason, label, staleTitle) {
  const wasStale = fs.existsSync(markerFile);
  if (reason) {
    fs.writeFileSync(markerFile, `${new Date().toISOString()} — ${reason}\n`);
    if (!wasStale) { macNotify(staleTitle, reason); await discord(`⚠️ **${label} STALE** — ${reason}`); }
  } else if (wasStale) {
    try { fs.unlinkSync(markerFile); } catch { /* ignore */ }
    macNotify(`✅ ${label} recovered`, `${label} fresh again.`);
    await discord(`✅ **${label} recovered**`);
  }
}

(async () => {
  const et = etParts();
  const inRTH = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(et.wd) && et.min >= 570 && et.min < 960;
  if (!inRTH && !FORCE) process.exit(0);   // off-hours: feed idle, staleness expected

  // 1) FEED — critical → HALT the trader. feedSetAt (rs-feed's own write) + dead-zero value check.
  const ctx = readJson(CTX);
  let feedReason = null;
  if (!ctx || !(ctx.feedSetAt || ctx.setAt)) {
    feedReason = 'no rs-context.json / unreadable';
  } else {
    const a = ageSec(ctx.feedSetAt || ctx.setAt);
    const nq = (ctx.bySymbol && ctx.bySymbol.NQ) || {};
    const deadZero = ctx.ddRatio === 0 && nq.mhpResilience === 0 && nq.hpResilience === 0 && nq.redistResilience === 0;
    if (a > FEED_STALE_SEC) feedReason = `feed stale ${a}s (rs-feed not writing)`;
    else if (deadZero) feedReason = 'dead-zero (DD + resiliences all 0)';
  }
  await toggle(STALE_FILE, feedReason, 'FEED', '⚠️ FEED STALE — trader halted');

  // 2) MM — alert only (secondary input, 60s). Only once rs-mm should have run.
  if (et.min >= MM_READY_MIN || FORCE) {
    const mm = readJson(MM);
    const a = ageSec(mm?.setAt);
    const mmReason = !mm ? 'no rs-context-mm.json (rs-mm never ran?)' : (a > MM_STALE_SEC ? `MM stale ${a}s (rs-mm not refreshing)` : null);
    await toggle(MM_MARK, mmReason, 'MM', '⚠️ MM stale (rs-mm)');
  }

  // 3) LEVELS — alert only (once-daily). Check today's NQ set is present after rs-levels should have run.
  if (et.min >= LEVELS_READY_MIN || FORCE) {
    const lv = readJson(NQ_LEVELS);
    const today = lv?.days?.[et.day]?.levels?.[0];
    const hasZones = today && (today.zones?.bull?.length || today.zones?.bear?.length || today.bullZone || today.bearZone);
    const lvReason = hasZones ? null : `no NQ levels for today (${et.day}) — rs-levels 09:32 failed?`;
    await toggle(LV_MARK, lvReason, 'LEVELS', '⚠️ LEVELS missing (rs-levels)');
  }

  // 4) BROKER WS — the trader touches WS_BEAT on every Tradovate frame; silence = the connection dropped
  //    (the trader can look "ready" but can't place orders — the 06-23 zombie). Dead >30s → AUTO-RESTART
  //    the trader (rate-limited); after WS_MAX_KICKS fruitless restarts, stop and escalate to a manual alert.
  let wsAge = Infinity;
  try { wsAge = Math.round((Date.now() - fs.statSync(WS_BEAT).mtimeMs) / 1000); } catch { /* file missing = never beat */ }
  if (wsAge > WS_STALE_SEC) {
    const detail = Number.isFinite(wsAge) ? `silent ${wsAge}s` : 'never connected (trader down?)';
    const st = readJson(WS_MARK) || { count: 0, lastKickMs: 0 };
    const now = Date.now();
    if (st.count >= WS_MAX_KICKS) {
      // auto-restart exhausted → manual escalation (throttled to ~5 min so it doesn't spam)
      if (now - (st.lastKickMs || 0) > 5 * 60_000) {
        st.lastKickMs = now; fs.writeFileSync(WS_MARK, JSON.stringify(st));
        macNotify('🚨 Tradovate WS DOWN — auto-restart FAILED', `${detail}; ${WS_MAX_KICKS} restarts didn't fix it — MANUAL check needed`);
        await discord(`🚨 **Tradovate WS DOWN — ${WS_MAX_KICKS} auto-restarts FAILED** (${detail}). Manual check needed.`);
      }
    } else if (now - (st.lastKickMs || 0) > WS_KICK_COOLDOWN_MS) {
      st.count += 1; st.lastKickMs = now;
      fs.writeFileSync(WS_MARK, JSON.stringify(st));
      const ok = await kickstartTrader();
      macNotify('⚠️ Tradovate WS DOWN — restarting trader', `${detail} — auto-restart #${st.count}${ok ? '' : ' (kickstart cmd failed!)'}`);
      await discord(`⚠️ **Tradovate WS DOWN — auto-restarting trader (#${st.count})**: ${detail}`);
    }
    // else: within the cooldown window — trader is restarting/reconnecting; wait.
  } else if (fs.existsSync(WS_MARK)) {   // WS alive again → clear the episode
    try { fs.unlinkSync(WS_MARK); } catch { /* ignore */ }
    macNotify('✅ Tradovate WS recovered', 'Broker connection back — trader OK.');
    await discord('✅ **Tradovate WS recovered** — broker connection back.');
  }
})();
