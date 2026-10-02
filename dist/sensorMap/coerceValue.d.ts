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
 *   - `measurement: 'boolean'` (the catalog-3 state kinds, §19.1)
 *     forwards a valid 0/1 state, and forwards a PRESENT-but-invalid
 *     state as an explicit fault marker so the state wrapper can raise
 *     StatusFault rather than the value being silently dropped.
 *
 * Every wrapper's `setValue` signature is `(number)`, so the coercer
 * returns a `number` on success and `undefined` to DROP the tick (a
 * malformed timestamp string, a non-numeric numeric field). Dropping
 * matches v1's silent-skip; the caller logs at debug. Routing iterates
 * only fields PRESENT in the payload, so `undefined` here always means
 * "present value the numeric/timestamp contract cannot use" — never a
 * missing field (which is simply not iterated).
 */
import type { EffectiveSensorRow } from './types.js';
/**
 * The state marker for a PRESENT-but-invalid boolean reading (§19.1,
 * PR #67 review F3). Distinct from 0/1, so the boolean state wrappers
 * decode it to StatusFault; distinct from `undefined`, so routing
 * FORWARDS it instead of dropping it — a present malformed state must
 * never look healthy. A missing field is never coerced (routing skips
 * absent fields), so this is reachable only for a value that WAS
 * reported and is not a usable 0/1.
 */
export declare const INVALID_BOOLEAN_STATE = -1;
export declare function coerceValue(row: EffectiveSensorRow, raw: unknown): number | undefined;
//# sourceMappingURL=coerceValue.d.ts.map