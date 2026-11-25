import * as v from 'valibot';

/** Request schemas of stock, purchase orders and transfers. */
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );
const text = (min: number, max: number, label = 'Required') =>
    v.pipe(v.string(), v.trim(), v.minLength(min, label), v.maxLength(max, `At most ${max} characters`));
const uuid = (label: string) => v.pipe(v.string(), v.uuid(label));
const qty = (min: number, max = 9999) => v.pipe(v.number(), v.integer('A whole number'), v.minValue(min), v.maxValue(max));
const cost = v.pipe(
    v.number(),
    v.minValue(0, 'Not below ৳0'),
    v.maxValue(1_000_000),
    v.transform(n => Math.round(n * 100) / 100)
);
const isoDate = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'A date'));
// valibot's check takes the array's own element type, so the helper is generic over it.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const unique = <T extends { product_oid: string }>(list: T[]) => new Set(list.map(l => l.product_oid)).size === list.length;

export const oidParams = v.object({ oid: uuid('Not found') });
export const productParams = v.object({ product_oid: uuid('Unknown product') });

export const stockQuery = v.object({
    low: v.optional(v.picklist(['0', '1'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)))
});

export const ADJUST_REASONS = ['damaged', 'expired', 'count', 'other'] as const;
export const adjustSchema = v.strictObject({
    /** Signed: +3 found in a count, −2 damaged. */
    qty: v.pipe(
        qty(-9999),
        v.check(n => n !== 0, 'Not zero')
    ),
    reason: v.picklist(ADJUST_REASONS, 'Choose a reason'),
    note: optionalText(300)
});

export const reorderSchema = v.strictObject({ reorder_level: qty(0) });

export const elsewhereQuery = v.object({
    product_oid: v.union([uuid('Unknown product'), v.pipe(v.array(uuid('Unknown product')), v.maxLength(50))])
});

/* ---------- purchase orders ---------- */

export const poCreate = v.strictObject({
    supplier_oid: uuid('Choose a supplier'),
    note: optionalText(500),
    lines: v.pipe(
        v.array(v.strictObject({ product_oid: uuid('Unknown product'), qty: qty(1, 99999), unit_cost: cost })),
        v.minLength(1, 'Add at least one product'),
        v.maxLength(50, 'At most 50 lines'),
        v.check(unique, 'Each product once')
    )
});
export type PoCreate = v.InferOutput<typeof poCreate>;

export const poQuery = v.object({
    status: v.optional(v.picklist(['open', 'pending', 'approved', 'rejected', 'sent', 'partial', 'received', 'cancelled', 'all'])),
    branch_oid: v.optional(uuid('Unknown branch'))
});

export const deliverySchema = v.strictObject({
    received_on: v.optional(isoDate),
    note: optionalText(300),
    lines: v.pipe(
        v.array(v.strictObject({ line_oid: uuid('Unknown line'), qty: qty(0, 99999), unit_cost: v.optional(cost) })),
        v.minLength(1, 'Enter what arrived'),
        v.check(list => list.some(l => l.qty > 0), 'Enter what arrived')
    )
});
export type DeliveryInput = v.InferOutput<typeof deliverySchema>;

export const decideSchema = v.strictObject({ note: optionalText(500) });
export const reasonSchema = v.strictObject({ reason: text(3, 300) });

/* ---------- transfers ---------- */

export const transferCreate = v.strictObject({
    from_branch_oid: uuid('Choose the branch to ask'),
    note: optionalText(500),
    lines: v.pipe(
        v.array(v.strictObject({ product_oid: uuid('Unknown product'), qty: qty(1) })),
        v.minLength(1, 'Add at least one product'),
        v.maxLength(50, 'At most 50 lines'),
        v.check(unique, 'Each product once')
    )
});
export type TransferCreate = v.InferOutput<typeof transferCreate>;

export const transferQuery = v.object({ direction: v.optional(v.picklist(['in', 'out', 'all'])) });

const lineQtys = v.pipe(v.array(v.strictObject({ line_oid: uuid('Unknown line'), qty: qty(0) })), v.minLength(1));
export const transferSend = v.strictObject({ lines: lineQtys, note: optionalText(500) });
export const transferReceive = v.strictObject({ lines: lineQtys, note: optionalText(500) });
export const transferClose = v.strictObject({ note: text(3, 500) });
