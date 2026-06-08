// ─────────────────────────────────────────────────────────────────────────────
// Standardized color & style palette for all chart levels (RS + structural).
//
// This is the single source of truth. Both the cockpit chart renderer and
// the scripts that generate daily_levels.json read from here. Daily-level
// JSON entries may include `color`, `style`, `width` overrides, but if the
// label matches a known entry below, the standard wins — so the chart never
// surprises the user with mismatched colors from stale JSON.
//
// Last updated: 2026-06-07 (per Ravi's color spec).
// ─────────────────────────────────────────────────────────────────────────────

export type LevelStyleName = 'solid' | 'dashed' | 'large-dashed' | 'dotted';
export type LevelWidth = 1 | 2 | 3 | 4;

export interface LevelStyle {
  color: string;
  style: LevelStyleName;
  width: LevelWidth;
}

// Master palette — keyed by level label exactly as it appears in
// daily_levels.json's `additionalLevels[].label` field, or in the chart's
// hardcoded RS framework lines (MHP/HP/DD↑/DD↓/Bull H/Bull L/Bear H/Bear L).
export const LEVEL_STYLES: Record<string, LevelStyle> = {
  // ─── RS framework ──────────────────────────────────────────────────────
  'MHP':        { color: '#FFA500', style: 'solid',  width: 2 },   // orange
  'ON MHP':     { color: '#FFA500', style: 'solid',  width: 2 },
  'HP':         { color: '#00FFFF', style: 'solid',  width: 2 },   // cyan
  'ON HP':      { color: '#00FFFF', style: 'solid',  width: 2 },
  'DD↑':        { color: '#89C241', style: 'solid',  width: 2 },   // upper DD band
  'DD↓':        { color: '#89C241', style: 'solid',  width: 2 },   // lower DD band
  'DD':         { color: '#89C241', style: 'solid',  width: 2 },   // generic DD reference
  'HG':         { color: '#FFFFFF', style: 'dashed', width: 3 },   // bold dashed white

  // ─── Structural (per Ravi's spec 2026-06-07) ───────────────────────────
  'PDH':        { color: '#2596BE', style: 'dashed', width: 3 },   // bold dashed cyan-blue
  'PDL':        { color: '#BF3C24', style: 'dashed', width: 3 },   // bold dashed red-brown
  'ONH':        { color: '#175676', style: 'dashed', width: 2 },   // dark blue
  'ONL':        { color: '#D45E77', style: 'dashed', width: 2 },   // pink
  'VAH':        { color: '#D8D06E', style: 'solid',  width: 1 },   // light yellow thin
  'VAL':        { color: '#8C8641', style: 'solid',  width: 1 },   // dark yellow thin
  'POC':        { color: '#545FDE', style: 'solid',  width: 3 },   // purple bold

  // ─── Index opens/closes (all bold white) ───────────────────────────────
  'QQQ Open':   { color: '#FFFFFF', style: 'solid',  width: 3 },
  'QQQ Close':  { color: '#FFFFFF', style: 'solid',  width: 3 },
  'SPY Open':   { color: '#FFFFFF', style: 'solid',  width: 3 },
  'SPY Close':  { color: '#FFFFFF', style: 'solid',  width: 3 },
  'SPX Open':   { color: '#FFFFFF', style: 'solid',  width: 3 },
  'SPX Close':  { color: '#FFFFFF', style: 'solid',  width: 3 },

  // ─── Levels NOT explicitly specified — kept at sensible defaults ───────
  //     (Surface to Ravi if these need to change.)
  'PDC':        { color: '#BBBBBB', style: 'solid',  width: 1 },   // prev day close (grey)
  'NQ Close':   { color: '#FFD700', style: 'solid',  width: 2 },   // gold
  'ES Close':   { color: '#FFD700', style: 'solid',  width: 2 },
  'ONO':        { color: '#FF9A3C', style: 'dotted', width: 1 },   // overnight open
  'Bull Zone':  { color: '#2BB673', style: 'solid',  width: 1 },
  'Bear Zone':  { color: '#D64545', style: 'solid',  width: 1 },
  'Bull H':     { color: '#2BB673', style: 'solid',  width: 2 },
  'Bull L':     { color: '#2BB673', style: 'solid',  width: 2 },
  'Bear H':     { color: '#D64545', style: 'solid',  width: 2 },
  'Bear L':     { color: '#D64545', style: 'solid',  width: 2 },
};

/** Lookup the canonical style for a level label. Returns undefined if unknown. */
export function lookupLevelStyle(label: string): LevelStyle | undefined {
  return LEVEL_STYLES[label];
}

/** Apply canonical style on top of a level object. Caller can pass any subset
 *  of fields; known labels get fully canonicalized. */
export function applyLevelStyle<T extends { label: string; color?: string; style?: string; width?: number }>(
  level: T,
): T {
  const canonical = lookupLevelStyle(level.label);
  if (!canonical) return level;
  return { ...level, color: canonical.color, style: canonical.style, width: canonical.width };
}
