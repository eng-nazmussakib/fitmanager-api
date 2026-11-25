import * as v from 'valibot';

import type { StaffRole } from '#src/auth/auth.repo.ts';
import { newPasswordSchema } from '#src/auth/password-policy.ts';

export const ROLES = ['OWNER', 'HQ_ADMIN', 'BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER'] as const satisfies readonly StaffRole[];

const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const role = v.picklist(ROLES, 'Unknown role');
const username = v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.regex(/^[a-z0-9][a-z0-9._-]{2,49}$/, '3–50 characters: letters, digits, dots, dashes or underscores')
);
const name = v.pipe(v.string(), v.trim(), v.minLength(1, 'Enter a name'), v.maxLength(100));
/** Optional; an empty string clears it. */
const email = v.pipe(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(200))),
    v.transform(e => (e === '' ? null : e)),
    v.check(e => e === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e), 'Enter a valid email address')
);

const assignment = v.strictObject({ branch_oid: uuid('Unknown branch'), role });
const assignments = v.pipe(
    v.array(assignment),
    v.minLength(1, 'Give at least one assignment'),
    v.maxLength(100),
    v.check(list => new Set(list.map(a => a.branch_oid)).size === list.length, 'One role per branch')
);

export const oidParams = v.object({ oid: uuid('Unknown staff member') });

export const hqListQuery = v.strictObject({
    branch_oid: v.optional(uuid('Unknown branch')),
    role: v.optional(role),
    status: v.optional(v.picklist(['Active', 'Inactive'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100)))
});
export const branchListQuery = v.strictObject({
    role: v.optional(role),
    status: v.optional(v.picklist(['Active', 'Inactive'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100)))
});

/** HQ: a new account with its assignments. `password` is the temporary password the admin types. */
export const hqCreateSchema = v.strictObject({
    username,
    name,
    email: v.optional(email, null),
    password: newPasswordSchema,
    assignments,
    all_branches: v.optional(v.boolean(), false)
});

/** Branch: a new account assigned at this branch only. */
export const branchCreateSchema = v.strictObject({
    username,
    name,
    email: v.optional(email, null),
    password: newPasswordSchema,
    role
});

export const profileSchema = v.pipe(
    v.strictObject({ name: v.optional(name), email: v.optional(email) }),
    v.check(b => b.name !== undefined || b.email !== undefined, 'Send name, email or both')
);

export const hqAssignmentsSchema = v.strictObject({ assignments, all_branches: v.optional(v.boolean(), false) });
export const branchRoleSchema = v.strictObject({ role });
export const resetPasswordSchema = v.strictObject({ password: newPasswordSchema });
