/**
 * Value coercion at the routing boundary (finding-#4 Stage 3).
 *
 * AWN's REST payload is not uniformly numeric. Most fields are finite
 * numbers, but:
 *
 *   - `measurement: 'timestamp'` fields (`lastRain`, `lightning-last-strike`)
 *     arrive as ISO-8601 STRINGS (`"2026-04-21T22:19:00.000Z"`), except
 *     `lightning_time` which AWN reports as a millisecond NUMBER. v1's
 *     `parseDevices` special-cased the ISO form via `Date.parse` when the
 *     sensor was LastRain; the row-driven router preserves that.
 *   - `measurement: 'boolean'` (reserved for future kinds; no current row)
 *     coerces AWN's 0/1 semantics to a 0 or 1 number.
 *
 * Every wrapper's `setValue` signature is `(number)`, so the coercer
 * returns a `number` on success and `undefined` to DROP the tick (a
 * malformed timestamp string, a non-numeric numeric field). Dropping
 * matches v1's silent-skip; the caller logs at debug.
 */
import type { EffectiveSensorRow } from './types.js';
export declare function coerceValue(row: EffectiveSensorRow, raw: unknown): number | undefined;
//# sourceMappingURL=coerceValue.d.ts.map