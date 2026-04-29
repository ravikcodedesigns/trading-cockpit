import { z } from 'zod';
import { state } from './state.js';
import { logger } from './logger.js';
import type { AggregatorEvent, SourceName } from '@trading/contracts';

const symbolSchema = z.enum(['NQ', 'ES']);
const sideSchema = z.enum(['bid', 'ask']);

// Permissive base — sources can add fields as long as core is valid
const baseEventSchema = z.object({
  ts: z.number().optional(),
  type: z.string().min(1),
  symbol: symbolSchema.optional(),
}).passthrough();

const absorptionSchema = baseEventSchema.extend({
  type: z.literal('absorption'),
  symbol: symbolSchema,
  side: sideSchema,
  price: z.number(),
  size: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});

const icebergSchema = baseEventSchema.extend({
  type: z.literal('iceberg'),
  symbol: symbolSchema,
  side: sideSchema,
  price: z.number(),
  estimatedTotalSize: z.number().nonnegative(),
});

const heartbeatSchema = baseEventSchema.extend({ type: z.literal('heartbeat') });

const barSchema = baseEventSchema.extend({
  type: z.literal('bar'),
  symbol: symbolSchema,
  interval: z.union([z.literal('1s'), z.literal('1m')]),
  partial: z.boolean().optional().default(false),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
  buyVolume: z.number().nonnegative(),
  sellVolume: z.number().nonnegative(),
});

const tickSchema = baseEventSchema.extend({
  type: z.literal('tick'),
  symbol: symbolSchema,
  price: z.number(),
  size: z.number().nonnegative(),
  side: sideSchema.optional(),
});

const flashAlphaSchema = baseEventSchema.extend({
  type: z.literal('snapshot'),
  symbol: symbolSchema,
  gexTotal: z.number(),
  zeroGamma: z.number(),
  dealerFlip: z.number(),
  gammaRegime: z.enum(['positive', 'negative', 'neutral']),
  callWalls: z.array(z.number()),
  putWalls: z.array(z.number()),
});

const SCHEMAS_BY_SOURCE: Record<string, z.ZodTypeAny> = {
  bookmap: z.union([heartbeatSchema, absorptionSchema, icebergSchema, barSchema]),
  tradovate: tickSchema,
  flashalpha: flashAlphaSchema,
};

export function ingest(sourceId: SourceName, raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    logger.warn({ sourceId }, 'ingest: non-object payload');
    return;
  }

  const schema = SCHEMAS_BY_SOURCE[sourceId];
  if (!schema) {
    logger.warn({ sourceId }, 'ingest: unknown source');
    return;
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { sourceId, errors: parsed.error.flatten() },
      'ingest: schema validation failed'
    );
    return;
  }

  const event = {
    ts: (raw as { ts?: number }).ts ?? Date.now(),
    source: sourceId,
    ...parsed.data,
  } as AggregatorEvent;

  state.applyEvent(event);
}
