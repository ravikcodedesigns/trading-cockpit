// Economic Calendar
//
// Loads high-impact macro events from data/economic-calendar.json.
// Used to:
//   - Send a pre-market morning briefing to Discord at 9:15 AM ET
//   - Append a news warning to signal Discord pings on event days
//   - Expose today's events via /econ/today endpoint

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_PATH = path.resolve(__dirname, '../../../data/economic-calendar.json');

export interface EconEvent {
  name:    string;   // "Consumer Price Index"
  short:   string;   // "CPI"
  time_et: string;   // "08:30"
  impact:  'HIGH' | 'MED' | 'LOW';
  note:    string;   // "Apr 2026 CPI"
}

let _calendar: Record<string, EconEvent[]> = {};

export function loadCalendar(): void {
  try {
    const raw = fs.readFileSync(CALENDAR_PATH, 'utf-8');
    _calendar = JSON.parse(raw);
    const totalDays = Object.keys(_calendar).length;
    logger.info({ totalDays }, 'economic calendar loaded');
  } catch (err) {
    logger.warn({ err }, 'economic calendar not found or invalid — no event awareness');
    _calendar = {};
  }
}

// Returns today's events in America/New_York timezone
export function getTodayEvents(): EconEvent[] {
  const today = todayNY();
  return _calendar[today] ?? [];
}

// Returns events within the next N calendar days (including today)
export function getUpcomingEvents(days = 5): { date: string; events: EconEvent[] }[] {
  const results: { date: string; events: EconEvent[] }[] = [];
  const nowMs = Date.now();
  for (let i = 0; i < days; i++) {
    const date = dateNY(nowMs + i * 86_400_000);
    const events = _calendar[date];
    if (events?.length) results.push({ date, events });
  }
  return results;
}

// True if today has at least one HIGH impact event
export function isHighImpactDay(): boolean {
  return getTodayEvents().some(e => e.impact === 'HIGH');
}

// Short label for today's events, e.g. "CPI + PPI" or "" if none
export function todayEventLabel(): string {
  return getTodayEvents()
    .map(e => e.short)
    .join(' + ');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayNY(): string {
  return dateNY(Date.now());
}

function dateNY(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms))
    .replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'); // MM/DD/YYYY → YYYY-MM-DD
}
