// Unified notification surface. Each method fans out to every wired channel
// (Discord webhook + Pushover) so callers don't need to know which transports
// are enabled. Channels are individually toggled by their respective env vars
// in config.ts — empty creds = silent for that channel.
//
// Order: Pushover first (fast — <1s mobile push), Discord second (slower —
// 5-30m mobile push but provides a searchable history). Both fire async and
// in parallel; one failing never blocks the other.

import { discord }  from './discord.js';
import { pushover } from './pushover.js';

export const notify = {
  open:         (o: Parameters<typeof pushover.open>[0])         => { pushover.open(o);         discord.open(o);         },
  close:        (o: Parameters<typeof pushover.close>[0])        => { pushover.close(o);        discord.close(o);        },
  reject:       (o: Parameters<typeof pushover.reject>[0])       => { pushover.reject(o);       discord.reject(o);       },
  block:        (o: Parameters<typeof pushover.block>[0])        => { pushover.block(o);        discord.block(o);        },
  orphan:       (o: Parameters<typeof pushover.orphan>[0])       => { pushover.orphan(o);       discord.orphan(o);       },
  halt:         (r: string)                                      => { pushover.halt(r);         discord.halt(r);         },
  startup:      (o: Parameters<typeof pushover.startup>[0])      => { pushover.startup(o);      discord.startup(o);      },
  dailySummary: (o: Parameters<typeof pushover.dailySummary>[0]) => { pushover.dailySummary(o); discord.dailySummary(o); },
};
