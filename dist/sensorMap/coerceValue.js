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
export function coerceValue(row, raw) {
    // Unrecognized rows have no wrapper and should never reach here; guard
    // defensively rather than reading a measurement that doesn't exist.
    if (row.kind === 'unrecognized') {
        return undefined;
    }
    if (row.measurement === 'timestamp') {
        if (typeof raw === 'number') {
            return Number.isFinite(raw) ? raw : undefined;
        }
        if (typeof raw === 'string') {
            const parsed = Date.parse(raw);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }
    if (row.measurement === 'boolean') {
        // AWN reports 0/1; anything truthy is "on". The wrapper receives a
        // canonical 0 or 1.
        if (typeof raw === 'number') {
            return Number.isFinite(raw) ? (raw !== 0 ? 1 : 0) : undefined;
        }
        if (typeof raw === 'boolean') {
            return raw ? 1 : 0;
        }
        return undefined;
    }
    // Every other measurement is numeric — pass a finite number through,
    // drop anything else (the wrapper's setValue never receives a string).
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}
//# sourceMappingURL=coerceValue.js.map