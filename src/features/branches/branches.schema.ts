import * as v from 'valibot';

const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const time = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm (24 hours)'));
const text = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));
/** An empty string clears an optional text field. */
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(text(max)),
            v.transform(s => (s === '' ? null : s))
        )
    );

/** One block of opening hours: weekday numbers (0 = Sunday … 6 = Saturday) and a time range in Dhaka time. */
export const hoursBlock = v.pipe(
    v.strictObject({
        days: v.pipe(
            v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
            v.minLength(1, 'Pick at least one day'),
            v.check(d => new Set(d).size === d.length, 'Each day once')
        ),
        open: time,
        close: time
    }),
    v.check(h => h.open < h.close, 'Opening must be before closing (a range cannot pass midnight)')
);
const hours = v.pipe(v.array(hoursBlock), v.maxLength(21, 'At most 21 blocks'));

export const oidParams = v.object({ oid: uuid('Unknown branch') });
export const slugParams = v.object({ slug: v.pipe(v.string(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Unknown branch')) });

/** `PATCH /v1/hq/branches/:oid`: the profile. Code, slug, name and kind are not changed here. */
export const profileSchema = v.pipe(
    v.strictObject({
        address: optionalText(200),
        area: optionalText(80),
        phone: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.regex(/^\+8801[3-9]\d{8}$|^\+880\d{9,10}$/, 'A Bangladeshi number as +880…')))),
        email: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200), v.email('Enter a valid email address')))),
        map_url: v.optional(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(500), v.url('Enter a full link'), v.startsWith('https://', 'Use an https:// link')))
        ),
        opened_on: v.optional(v.nullable(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD')))),
        capacity: v.optional(v.pipe(v.number(), v.integer('Whole people'), v.minValue(0), v.maxValue(10000))),
        dues_limit: v.optional(v.pipe(v.number(), v.minValue(0, 'Cannot be negative'), v.maxValue(10_000_000), v.transform(Math.round))),
        facilities: v.optional(v.pipe(v.array(v.pipe(text(60), v.minLength(1))), v.maxLength(40))),
        hours: v.optional(hours),
        ladies_hours: v.optional(hours)
    }),
    v.check(b => Object.keys(b).length > 0, 'Nothing to change')
);
export type ProfileUpdate = v.InferOutput<typeof profileSchema>;
