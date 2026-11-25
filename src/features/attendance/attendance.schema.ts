import * as v from 'valibot';

import { queryInt } from '#src/lib/query.ts';

const code = v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^MEM-[A-Z0-9]{2,6}-\d{6}$/, 'A member code like MEM-GUL-000123'));
const member = { member_oid: v.optional(v.pipe(v.string(), v.uuid('Unknown member'))), code: v.optional(code) };
const hasMember = (b: { member_oid?: string | undefined; code?: string | undefined }) => Boolean(b.member_oid ?? b.code);

export const oidParams = v.object({ oid: v.pipe(v.string(), v.uuid('Check-in not found')) });

/** `POST /v1/attendance/evaluate`: by the scanned code (any branch's member) or an own member's oid. */
export const evaluateSchema = v.pipe(
    v.strictObject(member),
    v.check(b => hasMember(b), 'Scan a member code')
);

export const checkInSchema = v.pipe(
    v.strictObject({ ...member, override: v.optional(v.nullable(v.strictObject({ reason: v.pipe(v.string(), v.maxLength(500)) }))) }),
    v.check(b => hasMember(b), 'Scan a member code')
);

const entry = v.pipe(
    v.strictObject({
        ...member,
        in_at: v.pipe(v.string(), v.isoTimestamp('A time like 2026-11-19T18:00:00+06:00')),
        out_at: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp('A time like 2026-11-19T19:30:00+06:00')))),
        reason: v.pipe(v.string(), v.trim(), v.minLength(5, 'Give a reason (at least 5 characters)'), v.maxLength(500))
    }),
    v.check(b => hasMember(b), 'Choose a member')
);

/** `POST /v1/attendance/backdated`: one or many visits entered after the fact. */
export const backdateSchema = v.strictObject({ entries: v.pipe(v.array(entry), v.minLength(1, 'Add at least one visit'), v.maxLength(100)) });

export const daysQuery = v.object({ days: v.optional(queryInt(1, 366), 84) });
