import * as v from 'valibot';

import { LADDER } from './ladder.ts';

/** Request schemas of discipline (phase 5, D-092 to D-094). */
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
const date = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));

export const oidParams = v.object({ oid: uuid('Not found') });

export const CATEGORIES = ['conduct', 'safety', 'equipment', 'hygiene', 'harassment', 'access', 'payment', 'attendance', 'other'] as const;

export const incidentQuery = v.object({
    status: v.optional(v.picklist(['', 'open', 'closed'])),
    kind: v.optional(v.picklist(['', 'member', 'staff'])),
    appeal: v.optional(v.picklist(['', 'open'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)))
});
export type IncidentQuery = v.InferOutput<typeof incidentQuery>;

export const incidentCreate = v.pipe(
    v.strictObject({
        /** At HQ: the branch where it happened. At a branch: that branch, always. */
        branch_oid: v.optional(uuid('Unknown branch')),
        subject_kind: v.picklist(['member', 'staff'], 'A member or a staff member'),
        /** A member by code: their own branch's or a visitor (D-059). */
        member_code: v.optional(v.pipe(v.string(), v.trim(), v.toUpperCase(), v.maxLength(30))),
        staff_oid: v.optional(uuid('Unknown staff member')),
        occurred_at: v.pipe(v.string(), v.isoTimestamp('A date and time')),
        category: v.picklist(CATEGORIES, 'Choose a category'),
        summary: text(3, 120),
        description: text(3, 2000),
        clause_oid: v.optional(v.nullable(uuid('Unknown clause'))),
        witnesses: optionalText(500),
        internal_notes: optionalText(2000),
        evidence_file_oids: v.optional(v.pipe(v.array(uuid('Upload the file first')), v.maxLength(5, 'At most 5 files')))
    }),
    v.check(b => (b.subject_kind === 'member' ? Boolean(b.member_code) : Boolean(b.staff_oid)), 'Choose who it is about')
);
export type IncidentCreate = v.InferOutput<typeof incidentCreate>;

export const incidentUpdate = v.pipe(
    v.strictObject({
        witnesses: optionalText(500),
        internal_notes: optionalText(2000),
        evidence_file_oids: v.optional(v.pipe(v.array(uuid('Upload the file first')), v.maxLength(5, 'At most 5 files'))),
        closed: v.optional(v.boolean())
    }),
    v.check(b => Object.keys(b).length > 0, 'Nothing to change')
);
export type IncidentUpdate = v.InferOutput<typeof incidentUpdate>;

export const sanctionCreate = v.strictObject({
    level: v.picklist(LADDER, 'Choose a step'),
    /** Shown to the person (D-094). */
    reason: text(3, 500),
    /** Why another step than the suggested one (D-092). */
    choice_reason: optionalText(500),
    /** Suspensions. */
    starts_on: v.optional(date),
    ends_on: v.optional(date),
    /** Bans: this branch, or every branch (HQ only). */
    scope: v.optional(v.picklist(['branch', 'all']))
});
export type SanctionCreate = v.InferOutput<typeof sanctionCreate>;

export const liftSchema = v.strictObject({ reason: text(3, 500) });
export const appealCreate = v.strictObject({ body: text(10, 2000) });
export const appealDecide = v.strictObject({ decision: v.picklist(['upheld', 'rejected'], 'Uphold or reject'), note: text(3, 1000) });
export const staffQuery = v.object({ branch_oid: v.optional(uuid('Unknown branch')) });
