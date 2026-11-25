import * as v from 'valibot';

import { queryInt } from '#src/lib/query.ts';

/** `01712345678`, `8801712345678`, `+880 1712-345678` → `+8801712345678`; anything else is refused. */
export const bdMobile = (message = 'Enter a valid Bangladeshi mobile number, e.g. 01712345678') =>
    v.pipe(
        v.string(),
        v.transform(s => s.replace(/[\s-]/g, '')),
        v.transform(s => (s.startsWith('+880') ? s : s.startsWith('880') ? `+${s}` : s.startsWith('0') ? `+88${s}` : s)),
        v.regex(/^\+8801[3-9]\d{8}$/, message)
    );

const text = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(text(max)),
            v.transform(s => (s === '' ? null : s))
        )
    );
const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));

export const oidParams = v.object({ oid: uuid('Unknown member') });

const emergency = v.nullable(
    v.strictObject({
        name: v.pipe(text(120), v.minLength(1, 'Enter the contact’s name')),
        phone: bdMobile('Enter the contact’s mobile number'),
        relation: v.pipe(text(40), v.minLength(1, 'Enter the relation'))
    })
);

const fields = {
    name: v.pipe(text(120), v.minLength(3, 'Enter the member’s full name')),
    phone: bdMobile(),
    gender: v.picklist(['Male', 'Female'], 'Male or Female'),
    email: v.optional(
        v.nullable(
            v.pipe(
                v.string(),
                v.trim(),
                v.transform(s => s || null),
                v.nullable(v.pipe(v.string(), v.email('Enter a valid email address'), v.maxLength(200)))
            )
        )
    ),
    date_of_birth: v.optional(
        v.nullable(
            v.pipe(
                v.string(),
                v.transform(s => s || null),
                v.nullable(v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD')))
            )
        )
    ),
    address: optionalText(300),
    emergency_contact: v.optional(emergency),
    health_flags: v.optional(v.pipe(v.array(v.pipe(text(60), v.minLength(1))), v.maxLength(20)), []),
    health_declared: v.boolean(),
    photo_file_oid: v.optional(v.nullable(uuid('Unknown photo'))),
    notes: optionalText(2000)
};

/** `POST /v1/members`: the desk adds a member; the health declaration must be signed (mock rule). */
export const createSchema = v.pipe(
    v.strictObject({
        ...fields,
        gender: v.optional(fields.gender, 'Male'),
        /** The member signed the current policies on paper at the desk: recorded as accepted. */
        policies_signed: v.optional(v.boolean())
    }),
    v.check(b => b.health_declared, 'The member must sign the health declaration')
);
export type MemberCreate = v.InferOutput<typeof createSchema>;

/** `PATCH /v1/members/:oid`: only the fields sent change. The code, branch and status have their own actions. */
export const updateSchema = v.pipe(
    v.strictObject({
        name: v.optional(fields.name),
        phone: v.optional(fields.phone),
        gender: v.optional(fields.gender),
        email: fields.email,
        date_of_birth: fields.date_of_birth,
        address: fields.address,
        emergency_contact: fields.emergency_contact,
        health_flags: v.optional(v.pipe(v.array(v.pipe(text(60), v.minLength(1))), v.maxLength(20))),
        health_declared: v.optional(v.boolean()),
        photo_file_oid: fields.photo_file_oid,
        notes: fields.notes
    }),
    v.check(b => Object.keys(b).length > 0, 'Nothing to change')
);
export type MemberUpdate = v.InferOutput<typeof updateSchema>;

export const listQuery = v.object({
    q: v.optional(v.pipe(v.string(), v.maxLength(100))),
    status: v.optional(v.picklist(['', 'Active', 'Expired', 'Frozen', 'Suspended', 'Pending'])),
    plan: v.optional(v.pipe(v.string(), v.maxLength(60))),
    flag: v.optional(v.picklist(['', 'expiring', 'dues'])),
    page: v.optional(queryInt(1, 100_000), 1),
    size: v.optional(queryInt(1, 100), 10),
    sort_by: v.optional(v.string()),
    sort_order: v.optional(v.picklist(['asc', 'desc']))
});

export const lookupQuery = v.object({
    code: v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^MEM-[A-Z0-9]{2,6}-\d{6}$/, 'A member code like MEM-GUL-000123'))
});

export const attendanceQuery = v.object({ days: v.optional(queryInt(1, 366), 84) });

export const reasonSchema = v.strictObject({ reason: v.pipe(text(500), v.minLength(3, 'Give a reason (at least 3 characters)')) });

export const transferSchema = v.strictObject({
    to_branch_oid: uuid('Unknown branch'),
    reason: v.pipe(text(500), v.minLength(3, 'Give a reason (at least 3 characters)'))
});

/** Anonymising cannot be undone: the caller types the member code to confirm. */
export const anonymiseSchema = v.strictObject({ confirm_code: v.pipe(v.string(), v.trim(), v.toUpperCase()) });
