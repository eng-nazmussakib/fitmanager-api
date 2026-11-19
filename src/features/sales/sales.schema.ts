import * as v from 'valibot';

const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const taka = v.pipe(v.number('A number of taka'), v.minValue(0, 'Cannot be negative'), v.maxValue(10_000_000), v.transform(Math.round));
const reason = v.pipe(v.string(), v.trim(), v.minLength(3, 'Give a reason (at least 3 characters)'), v.maxLength(500));
const method = v.picklist(['cash', 'card', 'bkash', 'nagad', 'bank'], 'Choose a payment method');
const reference = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100))));

export const oidParams = v.object({ oid: uuid('Not found') });

const discount = v.optional(
    v.strictObject({
        kind: v.picklist(['none', 'amount', 'percent', 'promo']),
        value: v.optional(v.pipe(v.number(), v.minValue(0)), 0),
        code: v.optional(v.pipe(v.string(), v.maxLength(20)))
    }),
    { kind: 'none', value: 0 }
);

const payment = v.optional(v.strictObject({ method: v.optional(method, 'cash'), amount: taka, reference }), { method: 'cash', amount: 0 });

/** `POST /v1/subscriptions/quote` and `POST /v1/subscriptions` (with the first payment, which may be partial or 0). */
export const saleSchema = v.strictObject({
    member_oid: uuid('Unknown member'),
    plan_oid: uuid('Unknown plan'),
    start_date: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'))),
    discount,
    charge_admission: v.optional(v.boolean(), false),
    payment
});

export const freezeSchema = v.strictObject({
    from: v.optional(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'))),
    days: v.pipe(v.number(), v.integer('Whole days')),
    reason
});

export const cancelSchema = v.strictObject({ reason });

export const upgradeSchema = v.strictObject({ plan_oid: uuid('Unknown plan'), payment });

export const paySchema = v.strictObject({ invoice_oid: uuid('Invoice not found'), method: v.optional(method, 'cash'), amount: taka, reference });

export const refundSchema = v.strictObject({ amount: v.optional(taka), method: v.optional(method, 'cash'), reference, reason });

export const closeSchema = v.strictObject({ counted_cash: taka, note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(500)))) });
