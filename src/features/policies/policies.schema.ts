import * as v from 'valibot';

/** Request schemas of policies. */
const text = (min: number, max: number, label = 'Required') =>
    v.pipe(v.string(), v.trim(), v.minLength(min, label), v.maxLength(max, `At most ${max} characters`));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );

export const oidParams = v.object({ oid: v.pipe(v.string(), v.uuid('Unknown policy')) });
export const slugParams = v.object({ slug: v.pipe(v.string(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Unknown policy'), v.maxLength(60)) });

const clause = v.strictObject({
    /** "3" or "3.2"; numbered 1, 2, 3… in order when left out. */
    number: v.optional(v.pipe(v.string(), v.trim(), v.regex(/^[0-9]{1,2}(\.[0-9]{1,2})?$/, 'A number like 3 or 3.2'))),
    heading: text(2, 120),
    body: text(2, 2000)
});
const clauses = v.pipe(
    v.array(clause),
    v.minLength(1, 'A policy has at least one clause'),
    v.maxLength(40, 'At most 40 clauses'),
    v.check(list => {
        const numbers = list.map((c, i) => c.number ?? String(i + 1));
        return new Set(numbers).size === numbers.length;
    }, 'Each clause needs its own number')
);
export type ClauseInput = v.InferOutput<typeof clause>;

export const policyCreate = v.strictObject({
    slug: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lower-case words joined by dashes'), v.maxLength(60)),
    title: text(3, 80),
    summary: optionalText(300),
    required: v.boolean(),
    public: v.boolean(),
    sort_order: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
    clauses
});
export type PolicyCreate = v.InferOutput<typeof policyCreate>;

export const policyUpdate = v.pipe(
    v.strictObject({
        title: v.optional(text(3, 80)),
        summary: optionalText(300),
        required: v.optional(v.boolean()),
        public: v.optional(v.boolean()),
        sort_order: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999))),
        active: v.optional(v.boolean())
    }),
    v.check(b => Object.keys(b).length > 0, 'Nothing to change')
);
export type PolicyUpdate = v.InferOutput<typeof policyUpdate>;

/** A new version: "accept again" makes every member accept it (after the grace period). */
export const versionCreate = v.strictObject({
    mode: v.picklist(['accept_again', 'wording_only'], 'Accept again, or wording only'),
    change_note: optionalText(500),
    clauses
});
export type VersionCreate = v.InferOutput<typeof versionCreate>;

/** The desk records paper acceptance: of these policies, or of every one that is due. */
export const paperAccept = v.strictObject({ policy_oids: v.optional(v.array(v.pipe(v.string(), v.uuid('Unknown policy')))) });

export const portalAccept = v.strictObject({ version_oid: v.pipe(v.string(), v.uuid('Unknown version')) });
