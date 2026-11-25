import * as v from 'valibot';

/** Request schemas of the website content. */
const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const text = (min: number, max: number) =>
    v.pipe(v.string(), v.trim(), v.minLength(min, min > 1 ? `At least ${min} characters` : 'Required'), v.maxLength(max, `At most ${max} characters`));
const slug = v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.maxLength(80, 'At most 80 characters'),
    v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lower-case letters, digits and single dashes')
);
const day = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));
/** An ISO instant (with an offset), or null for a draft. */
const instant = v.nullable(v.pipe(v.string(), v.isoTimestamp('A date and time')));
/** One of the site's own images (`assets/…`), as the seeded content uses. */
const assetPath = v.pipe(v.string(), v.regex(/^assets\/[\w/.-]+$/, 'A path under assets/'));

export const oidParams = v.object({ oid: uuid('Not found') });
export const slugParams = v.object({ slug: v.pipe(v.string(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Not found')) });

const postFields = {
    title: text(3, 120),
    slug,
    excerpt: text(10, 300),
    body: v.pipe(v.string(), v.maxLength(40000, 'At most 40 000 characters')),
    category_oid: v.nullable(uuid('Choose a category')),
    cover_file_oid: v.optional(v.nullable(uuid('Upload the image first'))),
    cover_url: v.optional(v.nullable(assetPath)),
    cover_alt: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ''),
    published_at: instant
};
export const postCreate = v.strictObject(postFields);
export const postUpdate = v.strictObject(v.partial(v.strictObject(postFields)).entries);
export type PostCreate = v.InferOutput<typeof postCreate>;
export type PostUpdate = v.InferOutput<typeof postUpdate>;

export const categoryCreate = v.strictObject({ name: text(2, 40), slug });

const offerFields = {
    title: text(3, 80),
    slug,
    summary: text(10, 300),
    body: v.optional(v.pipe(v.string(), v.maxLength(8000, 'At most 8 000 characters')), ''),
    conditions: v.optional(v.pipe(v.array(text(1, 160)), v.maxLength(10, 'At most 10 conditions')), []),
    promo_code: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^[A-Z0-9]{3,20}$/, 'A promo code')))),
    starts_on: day,
    ends_on: v.optional(v.nullable(day)),
    sort_order: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999)), 0),
    published: v.optional(v.boolean(), true)
};
export const offerCreate = v.pipe(
    v.strictObject(offerFields),
    v.forward(
        v.check(o => !o.ends_on || o.ends_on >= o.starts_on, 'The end is before the start'),
        ['ends_on']
    )
);
export const offerUpdate = v.strictObject(v.partial(v.strictObject(offerFields)).entries);
export type OfferCreate = v.InferOutput<typeof offerCreate>;
export type OfferUpdate = v.InferOutput<typeof offerUpdate>;

export const galleryCreate = v.strictObject({
    /** At HQ: the branch the photo shows. At a branch: omitted (the branch itself). */
    branch_oid: v.optional(uuid('Choose a branch')),
    file_oid: uuid('Upload the image first'),
    alt: text(3, 200),
    width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)), 640),
    height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)), 480)
});
export const galleryUpdate = v.strictObject({
    alt: v.optional(text(3, 200)),
    sort_order: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(999)))
});
export const galleryQuery = v.object({ branch_oid: v.optional(uuid('Unknown branch')) });
export const publicGalleryQuery = v.object({ branch: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,40}$/, 'Unknown branch'))) });
export const publicPostsQuery = v.object({ category: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,80}$/, 'Unknown category'))) });

export const descriptionSchema = v.strictObject({ description: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(4000, 'At most 4 000 characters'))) });
