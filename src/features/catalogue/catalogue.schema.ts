import * as v from 'valibot';

import { bdMobile } from '#src/features/members/members.schema.ts';

/** Request schemas of the catalogue and suppliers (phase 6, D-099). */
const text = (min: number, max: number, label = 'Required') =>
    v.pipe(v.string(), v.trim(), v.minLength(min, label), v.maxLength(max, `At most ${max} characters`));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );

export const oidParams = v.object({ oid: v.pipe(v.string(), v.uuid('Not found')) });

export const CATEGORIES = ['supplements', 'drinks', 'snacks', 'apparel', 'accessories', 'other'] as const;
export const UNITS = ['piece', 'bottle', 'pack', 'box', 'tub', 'pair'] as const;

const money = v.pipe(v.number(), v.integer('Whole taka'), v.minValue(1, 'More than ৳0'), v.maxValue(10_000_000));
const vatRate = v.optional(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(0.5, 'At most 50%'))));
const photos = v.optional(v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.maxLength(3, 'At most 3 photos')));

export const productCreate = v.strictObject({
    name: text(2, 80),
    category: v.picklist(CATEGORIES, 'Choose a category'),
    unit: v.picklist(UNITS, 'Choose a unit'),
    description: optionalText(500),
    price: money,
    /** Null or left out: the HQ rate in force. */
    vat_rate: vatRate,
    photo_file_oids: photos,
    supplier_oid: v.optional(v.nullable(v.pipe(v.string(), v.uuid('Unknown supplier')))),
    reorder_level: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
    active: v.optional(v.boolean())
});
export type ProductCreate = v.InferOutput<typeof productCreate>;

export const productUpdate = v.partial(productCreate);
export type ProductUpdate = v.InferOutput<typeof productUpdate>;

export const productQuery = v.object({
    all: v.optional(v.picklist(['0', '1'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
    category: v.optional(v.picklist(CATEGORIES))
});
export type ProductQuery = v.InferOutput<typeof productQuery>;

export const supplierCreate = v.strictObject({
    name: text(2, 120),
    contact_name: optionalText(120),
    phone: v.optional(v.nullable(bdMobile())),
    email: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email('An email address'), v.maxLength(254)))),
    address: optionalText(300),
    notes: optionalText(1000),
    active: v.optional(v.boolean())
});
export type SupplierCreate = v.InferOutput<typeof supplierCreate>;

export const supplierUpdate = v.partial(supplierCreate);
export type SupplierUpdate = v.InferOutput<typeof supplierUpdate>;
