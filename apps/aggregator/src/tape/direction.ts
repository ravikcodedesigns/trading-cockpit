// Direction convention — ONE documented mapping from every tape event to the price direction
// the event is EVIDENCE FOR (+1 up / −1 down / 0 none). The per-kind `side` fields carry
// heterogeneous semantics (aggressor side, defender side, puke side…), so summing them raw —
// as the pre-audit confluence did — mixes conventions. Confluence scoring and the forward
// outcome labeler (scripts/label_tape_outcomes.ts) both read THIS table, so the score and the
// validation sample can never disagree about what an event was supposed to predict.
//
//   kind        side means…                          expected direction
//   ───────     ─────────────────────────────        ─────────────────────────────────────────
//   block       aggressor                            with the aggressor (continuation)
//   sweep       aggressor                            with the aggressor (continuation)
//   stacked     dominant aggressor stack             with the stack (continuation)
//   absorption  the DEFENDER absorbing the flow      with the defender (their level holds)
//   wall        hold → defender · break/pulled →     side is already flipped at emit for
//               attacker (flipped at emit)           break/pulled → always `side`
//   iceberg     the DEFENDER (bid ice = 'buy')       active/held → defender · BROKE → flipped
//                                                    (a broken bid-iceberg is bearish evidence)
//   trapped     the side that will PUKE              with the puke
//   stoprun     the CASCADE direction                accepted/active → with the cascade ·
//                                                    RECLAIMED → flipped (the sweep failed — the
//                                                    triggered cohort is offside, spring logic)
//   spoof       the side that faked                  AWAY from the faked side (they want out)
//   unfinished  'buy' = unfinished HIGH magnet       toward the magnet (settled null — labeler
//                                                    only, never scored)
//   confluence  net winning direction                itself

import type { TapeEvent } from '@trading/contracts';

const sgn = (side: 'buy' | 'sell'): 1 | -1 => (side === 'buy' ? 1 : -1);

/** The price direction this event is evidence for: +1 up, −1 down, 0 no directional claim. */
export function expectedDir(ev: Pick<TapeEvent, 'kind' | 'side' | 'state'>): 1 | -1 | 0 {
  switch (ev.kind) {
    case 'block':
    case 'sweep':
    case 'stacked':
    case 'absorption':
    case 'trapped':
    case 'wall':        // break/pulled sides are flipped at the emit site — `side` is final
    case 'confluence':
    case 'unfinished':
      return sgn(ev.side);
    case 'iceberg':
      return ev.state === 'broke' ? (sgn(ev.side) === 1 ? -1 : 1) : sgn(ev.side);
    case 'stoprun':
      return ev.state === 'reclaimed' ? (sgn(ev.side) === 1 ? -1 : 1) : sgn(ev.side);
    case 'spoof':
      return sgn(ev.side) === 1 ? -1 : 1;
    default:
      return 0;
  }
}
