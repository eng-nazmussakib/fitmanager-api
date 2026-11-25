import * as v from 'valibot';

/** Request schemas of complaints, NPS and ratings. */
const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const text = (min: number, max: number) =>
    v.pipe(v.string(), v.trim(), v.minLength(min, min > 1 ? `At least ${min} characters` : 'Required'), v.maxLength(max, `At most ${max} characters`));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );

export const oidParams = v.object({ oid: uuid('Not found') });

export const COMPLAINT_CATEGORIES = ['facilities', 'equipment', 'cleanliness', 'staff', 'billing', 'classes', 'other'] as const;

export const complaintQuery = v.object({
    status: v.optional(v.picklist(['', 'open', 'in_progress', 'resolved', 'closed', 'active'])),
    overdue: v.optional(v.picklist(['', '0', '1'])),
    escalated: v.optional(v.picklist(['', '0', '1']))
});
export type ComplaintQuery = v.InferOutput<typeof complaintQuery>;

const complaintFields = {
    category: v.picklist(COMPLAINT_CATEGORIES, 'Choose a category'),
    subject: text(3, 120),
    body: text(10, 2000),
    photo_file_oid: v.optional(v.nullable(uuid('Upload the photo first'))),
    /** The staff member it is about, if any: hidden from them. */
    named_staff_oid: v.optional(v.nullable(uuid('Unknown staff member')))
};

/** The desk files on someone's behalf: a member of this branch, or a visitor by name. */
export const complaintCreate = v.pipe(
    v.strictObject({ ...complaintFields, member_oid: v.optional(v.nullable(uuid('Unknown member'))), member_name: optionalText(120) }),
    v.check(b => Boolean(b.member_oid) || Boolean(b.member_name && b.member_name.length >= 2), 'Choose the member, or give the person’s name')
);
export type ComplaintCreate = v.InferOutput<typeof complaintCreate>;

export const portalComplaintCreate = v.strictObject(complaintFields);
export type PortalComplaintCreate = v.InferOutput<typeof portalComplaintCreate>;

/** A staff reply; `resolved` closes the work with the reply as the resolution. */
export const complaintReply = v.strictObject({ body: text(2, 2000), status: v.optional(v.picklist(['in_progress', 'resolved'])) });
export const memberReply = v.strictObject({ body: text(2, 2000) });
export const escalateSchema = v.strictObject({ reason: text(3, 500) });

export const npsCreate = v.pipe(
    v.strictObject({
        /** Null: closed without answering; the card comes back after 90 days. */
        score: v.nullable(v.pipe(v.number(), v.integer('A whole number'), v.minValue(0), v.maxValue(10))),
        comment: optionalText(1000)
    }),
    v.check(b => b.score !== null || !b.comment, 'Give a score with a comment')
);

export const ratingCreate = v.pipe(
    v.strictObject({
        booking_oid: v.optional(uuid('Unknown class')),
        pt_session_oid: v.optional(uuid('Unknown session')),
        score: v.pipe(v.number(), v.integer('A whole number'), v.minValue(1, '1 to 5'), v.maxValue(5, '1 to 5')),
        comment: optionalText(1000)
    }),
    v.check(b => Boolean(b.booking_oid) !== Boolean(b.pt_session_oid), 'Rate one class or one PT session')
);
export type RatingCreate = v.InferOutput<typeof ratingCreate>;

export const feedbackQuery = v.object({ days: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.minValue(7), v.maxValue(365))) });
