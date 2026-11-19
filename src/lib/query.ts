import * as v from 'valibot';

/** A query-string number (`?limit=20`) or a JSON number; NaN ('abc') is refused. */
export const queryInt = (min: number, max = Number.MAX_SAFE_INTEGER) =>
    v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.number(), v.integer(), v.minValue(min), v.maxValue(max));

/** A calendar date as `YYYY-MM-DD` that exists (no 2026-02-30). */
export const isoDate = (message = 'A date as YYYY-MM-DD') =>
    v.pipe(
        v.string(),
        v.regex(/^\d{4}-\d{2}-\d{2}$/, message),
        v.check(d => {
            const t = new Date(`${d}T00:00:00Z`);
            return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
        }, 'Not a real date')
    );
