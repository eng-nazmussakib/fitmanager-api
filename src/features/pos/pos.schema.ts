import * as v from 'valibot';

/** Request schemas of the POS. */
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );
const uuid = (label: string) => v.pipe(v.string(), v.uuid(label));

export const oidParams = v.object({ oid: uuid('Sale not found') });

const line = v.pipe(
    v.strictObject({
        product_oid: uuid('Unknown product'),
        qty: v.pipe(v.number(), v.integer('A whole number'), v.minValue(1, 'At least 1'), v.maxValue(999)),
        /** Taka off the line: a branch manager's, with a reason. */
        discount: v.optional(v.pipe(v.number(), v.integer('Whole taka'), v.minValue(0), v.maxValue(1_000_000))),
        discount_reason: optionalText(120)
    }),
    v.check(l => !l.discount || !!l.discount_reason, 'Give the reason for the discount')
);

export const cartSchema = v.strictObject({
    /** A member of this branch, or null for a walk-in. */
    member_oid: v.optional(v.nullable(uuid('Unknown member'))),
    lines: v.pipe(
        v.array(line),
        v.minLength(1, 'Add a product'),
        v.maxLength(30, 'At most 30 lines'),
        v.check(list => new Set(list.map(l => l.product_oid)).size === list.length, 'Each product once')
    )
});
export type CartInput = v.InferOutput<typeof cartSchema>;

export const saleSchema = v.strictObject({
    ...cartSchema.entries,
    /** A walk-in's name on the receipt (optional). */
    walk_in_name: optionalText(120),
    payment: v.strictObject({
        method: v.picklist(['cash', 'card', 'bkash', 'nagad', 'bank'], 'Choose a payment method'),
        /** A walk-in pays it all; a member may pay less, and the rest is charged to their account. */
        amount: v.pipe(v.number(), v.minValue(0)),
        reference: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100))))
    })
});
export type SaleInput = v.InferOutput<typeof saleSchema>;

export const salesQuery = v.object({
    day: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)))
});

export const returnSchema = v.strictObject({
    lines: v.pipe(
        v.array(
            v.strictObject({
                /** The line's position among the sale's product lines, from 0. */
                index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(29)),
                qty: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(999)),
                /** Damaged items are not put back on the shelf. */
                damaged: v.optional(v.boolean())
            })
        ),
        v.minLength(1, 'Choose what comes back'),
        v.check(list => new Set(list.map(l => l.index)).size === list.length, 'Each line once')
    ),
    method: v.picklist(['cash', 'card', 'bkash', 'nagad', 'bank'], 'Choose how the money goes back'),
    reference: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100)))),
    reason: v.pipe(v.string(), v.trim(), v.minLength(3, 'Say why it came back'), v.maxLength(300))
});
export type ReturnInput = v.InferOutput<typeof returnSchema>;
