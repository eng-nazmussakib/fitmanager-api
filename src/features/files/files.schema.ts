import * as v from 'valibot';

export const fileParams = v.object({ oid: v.pipe(v.string(), v.uuid('Unknown file')) });

/** `POST /v1/files`: what the browser is about to upload. The limits themselves are in files.service.ts (D-069). */
export const startSchema = v.strictObject({
    kind: v.picklist(['member_photo', 'member_document'], 'member_photo or member_document'),
    /** The file's own name, shown in lists; never used as a path. */
    name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Required'), v.maxLength(200)),
    content_type: v.pipe(v.string(), v.toLowerCase(), v.maxLength(100)),
    size: v.pipe(v.number(), v.integer('Bytes'), v.minValue(1, 'The file is empty')),
    member_oid: v.optional(v.nullable(v.pipe(v.string(), v.uuid('Unknown member'))))
});

export const uploadQuery = v.object({ token: v.pipe(v.string(), v.minLength(10), v.maxLength(2000)) });
