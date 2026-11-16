import * as v from 'valibot';

/**
 * Request schemas for the generic `Item` example: the same rules as the frontend forms (lib/validation.ts and
 * items/schema.ts in the React skeleton), because the API must re-check everything the browser checked.
 * Rename `Item` to your entity and keep the structure.
 */
export const REGEX = {
    BD_MOBILE: /^01[3-9]\d{8}$/,
    ENGLISH_TEXT: /^[A-Za-z\s.,\-()0-9]+$/,
    ISO_DATE: /^\d{4}-\d{2}-\d{2}$/
};

export const ITEM_STATUSES = ['Active', 'Inactive'] as const;

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1, 'Required'), v.maxLength(max, `At most ${max} characters`));
/** A query-string number (`?limit=20`) or a JSON number; NaN ('abc') is refused. */
const queryInt = (min: number, max = Number.MAX_SAFE_INTEGER) =>
    v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.number(), v.integer(), v.minValue(min), v.maxValue(max));

export const itemPayloadSchema = v.strictObject({
    name_en: v.pipe(text(100), v.regex(REGEX.ENGLISH_TEXT, 'English letters only')),
    category_oid: text(50),
    contact_mobile: v.pipe(v.string(), v.regex(REGEX.BD_MOBILE, 'A valid Bangladeshi mobile number, e.g. 01712345678')),
    effective_date: v.pipe(
        v.string(),
        v.regex(REGEX.ISO_DATE, 'A date as YYYY-MM-DD'),
        v.check(d => !Number.isNaN(Date.parse(d)), 'Not a real date')
    ),
    amount: v.pipe(v.number(), v.gtValue(0, 'Must be greater than 0'), v.maxValue(999_999_999_999)),
    status: v.picklist(ITEM_STATUSES),
    attachment: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[\w-]+\.(jpg|png|pdf)$/, 'Unknown attachment'))), null),
    lines: v.optional(v.pipe(v.array(v.strictObject({ label: text(100), value: text(500) })), v.maxLength(50)), [])
});
export type ItemPayload = v.InferOutput<typeof itemPayloadSchema>;

/** Sortable columns. The keys are what the client may send; the values are SQL, so they never come from input. */
export const SORT_COLUMNS = {
    code: 'i.code',
    name: 'i.name_en',
    name_en: 'i.name_en',
    category: 'c.name_en',
    effective_date: 'i.effective_date',
    amount: 'i.amount',
    status: 'i.status',
    created_at: 'i.created_at'
} as const;

export const itemFilterSchema = v.object({
    search_text: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100))),
    status: v.optional(v.picklist(ITEM_STATUSES)),
    category_oid: v.optional(v.pipe(v.string(), v.maxLength(50)))
});

export const itemListSchema = v.object({
    ...itemFilterSchema.entries,
    offset: v.optional(queryInt(0), 0),
    limit: v.optional(queryInt(1, 100), 10),
    sort_by: v.optional(v.picklist(Object.keys(SORT_COLUMNS) as (keyof typeof SORT_COLUMNS)[])),
    sort_order: v.optional(v.picklist(['asc', 'desc']), 'asc')
});
export type ItemFilter = v.InferOutput<typeof itemFilterSchema>;
export type ItemListQuery = v.InferOutput<typeof itemListSchema>;

export const itemExportSchema = v.object({ ...itemFilterSchema.entries, format: v.optional(v.picklist(['csv', 'xlsx']), 'csv') });

export const oidSchema = v.pipe(v.string(), v.uuid('Item not found'));
