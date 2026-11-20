import * as v from 'valibot';

const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const taka = (field: string) =>
    v.pipe(v.number(`${field}: a number of taka`), v.minValue(0, `${field} cannot be negative`), v.maxValue(10_000_000), v.transform(Math.round));
const slugish = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z][a-z0-9-]{0,30}$/, 'Lower case letters, digits and dashes'));
const label = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1, 'Required'), v.maxLength(max));
const features = v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))), v.maxLength(20));
const date = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));
const nonEmpty = (b: object): boolean => Object.keys(b).length > 0;

export const oidParams = v.object({ oid: uuid('Unknown plan') });
export const templateParams = v.object({ oid: uuid('Unknown plan template') });
export const promoParams = v.object({ code: v.pipe(v.string(), v.toUpperCase(), v.regex(/^[A-Z0-9]{3,20}$/, 'Unknown promo code')) });

export const templateCreate = v.pipe(
    v.strictObject({
        tier: slugish,
        tier_name: label(60),
        period: slugish,
        period_label: label(60),
        months: v.pipe(v.number(), v.integer('Whole months'), v.minValue(1), v.maxValue(60)),
        base_price: taka('base_price'),
        persons: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)), 1),
        features: v.optional(features, []),
        featured: v.optional(v.boolean(), false),
        freezable: v.optional(v.boolean(), true),
        sort_order: v.optional(v.pipe(v.number(), v.integer()), 0),
        /** A membership, or a PT package of `sessions` sessions valid for `months` (D-079). */
        kind: v.optional(v.picklist(['membership', 'pt']), 'membership'),
        sessions: v.optional(v.nullable(v.pipe(v.number(), v.integer('Whole sessions'), v.minValue(1), v.maxValue(100))))
    }),
    v.forward(
        v.check(b => (b.kind === 'pt') === (b.sessions !== undefined && b.sessions !== null), 'A PT package has a number of sessions; a membership has none'),
        ['sessions']
    )
);
export type TemplateCreate = v.InferOutput<typeof templateCreate>;

/** Tier and period identify the template and do not change; months may (sold memberships keep their end dates). */
export const templateUpdate = v.pipe(
    v.strictObject({
        tier_name: v.optional(label(60)),
        period_label: v.optional(label(60)),
        months: v.optional(v.pipe(v.number(), v.integer('Whole months'), v.minValue(1), v.maxValue(60))),
        base_price: v.optional(taka('base_price')),
        persons: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))),
        features: v.optional(features),
        featured: v.optional(v.boolean()),
        freezable: v.optional(v.boolean()),
        sort_order: v.optional(v.pipe(v.number(), v.integer())),
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type TemplateUpdate = v.InferOutput<typeof templateUpdate>;

export const planCreate = v.strictObject({
    branch_oid: uuid('Unknown branch'),
    template_oid: uuid('Unknown plan template'),
    /** Defaults to the template's base price. */
    price: v.optional(taka('price')),
    admission_fee: v.optional(taka('admission_fee'), 0)
});

export const planUpdate = v.pipe(
    v.strictObject({ price: v.optional(taka('price')), admission_fee: v.optional(taka('admission_fee')), active: v.optional(v.boolean()) }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type PlanUpdate = v.InferOutput<typeof planUpdate>;

export const hqPlansQuery = v.strictObject({ branch_oid: v.optional(uuid('Unknown branch')) });
export const publicPlansQuery = v.strictObject({ branch: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Unknown branch'))) });

interface PromoEffect {
    percent?: number | null;
    amount?: number | null;
    waive_admission?: boolean;
}
const promoEffect = (p: PromoEffect): boolean => [p.percent != null, p.amount != null, p.waive_admission === true].filter(Boolean).length === 1;
const EFFECT = 'Choose one: a percent, an amount, or waiving the admission fee';
const promoFields = {
    label: label(80),
    percent: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0.01), v.maxValue(100)))),
    amount: v.optional(v.nullable(taka('amount'))),
    waive_admission: v.optional(v.boolean()),
    valid_from: date,
    valid_to: date
};

export const promoCreate = v.pipe(
    v.strictObject({ code: v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^[A-Z0-9]{3,20}$/, '3–20 letters or digits')), ...promoFields }),
    v.check(p => promoEffect(p), EFFECT),
    v.check(p => p.valid_from <= p.valid_to, '`valid_from` must not be after `valid_to`')
);
export type PromoCreate = v.InferOutput<typeof promoCreate>;

/** Any field; the merged row is checked again (one effect, dates in order), and the database checks it a third time. */
export const promoUpdate = v.pipe(
    v.strictObject({
        label: v.optional(promoFields.label),
        percent: promoFields.percent,
        amount: promoFields.amount,
        waive_admission: promoFields.waive_admission,
        valid_from: v.optional(date),
        valid_to: v.optional(date),
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type PromoUpdate = v.InferOutput<typeof promoUpdate>;
export const promoRules = { promoEffect, EFFECT };
