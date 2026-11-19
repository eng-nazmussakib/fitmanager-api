import type { BranchKind, StaffRole } from '#src/auth/auth.repo.ts';
import type { Queryable } from '#src/db/db.ts';
import { containsPattern, pgErrorCode, sql } from '#src/db/sql.ts';
import { AppError } from '#src/lib/http.ts';

/** One staff account with its explicit assignments (inactive branches included, so HQ sees every row). */
export interface StaffMember {
    oid: string;
    username: string;
    name: string;
    email: string | null;
    status: 'Active' | 'Inactive';
    all_branches: boolean;
    must_change_password: boolean;
    created_at: string;
    updated_at: string;
    assignments: StaffPlacement[];
}

export interface StaffPlacement {
    branch_oid: string;
    branch_code: string;
    branch_name: string;
    branch_kind: BranchKind;
    branch_status: 'Active' | 'Inactive';
    role: StaffRole;
}

export interface StaffFilter {
    /** Only people with an assignment at this branch. */
    branch_oid?: string | undefined;
    role?: StaffRole | undefined;
    status?: 'Active' | 'Inactive' | undefined;
    /** Name, username or email contains. */
    q?: string | undefined;
}

/** Never selects the password hash: these rows go to the client and into the audit log. */
const SELECT = sql.raw(`
    select u.oid, u.username, u.name, u.email, u.status, u.all_branches, u.must_change_password, u.created_at, u.updated_at,
           coalesce((
               select json_agg(json_build_object(
                          'branch_oid', b.oid, 'branch_code', b.code, 'branch_name', b.name, 'branch_kind', b.kind,
                          'branch_status', b.status, 'role', a.role_code)
                      order by b.kind = 'HQ' desc, b.name)
               from staff_assignment a join branch b on b.oid = a.branch_oid
               where a.user_oid = u.oid
           ), '[]'::json) as assignments
    from app_user u`);

/** Duplicate usernames and unknown branches or roles become 409 / 400 instead of a 500. */
function translate(err: unknown): never {
    const code = pgErrorCode(err);
    if (code === '23505') throw new AppError(409, 'This username is taken', [{ path: 'username', message: 'This username is taken' }]);
    if (code === '23503') throw new AppError(400, 'Unknown branch or role', [{ path: 'assignments', message: 'Unknown branch or role' }]);
    throw err;
}

export interface NewStaff {
    username: string;
    name: string;
    email: string | null;
    passwordHash: string;
    allBranches: boolean;
}

export const staffRepo = {
    async list(db: Queryable, f: StaffFilter): Promise<StaffMember[]> {
        const pattern = f.q ? containsPattern(f.q) : undefined;
        const filter = sql.where([
            sql`u.kind = 'staff'`,
            f.status !== undefined && sql`u.status = ${f.status}`,
            pattern !== undefined && sql`(u.name ilike ${pattern} or u.username ilike ${pattern} or u.email ilike ${pattern})`,
            (f.branch_oid !== undefined || f.role !== undefined) &&
                sql`exists (select 1 from staff_assignment a where a.user_oid = u.oid and ${sql.where([
                    f.branch_oid !== undefined && sql`a.branch_oid = ${f.branch_oid}`,
                    f.role !== undefined && sql`a.role_code = ${f.role}`
                ])})`
        ]);
        return db.query<StaffMember>(sql`${SELECT} where ${filter} order by u.name, u.username`);
    },

    async get(db: Queryable, oid: string, opts: { lock?: boolean } = {}): Promise<StaffMember | undefined> {
        if (opts.lock) await db.query(sql`select 1 from app_user where oid = ${oid} for update`);
        const [row] = await db.query<StaffMember>(sql`${SELECT} where u.oid = ${oid} and u.kind = 'staff'`);
        return row;
    },

    async create(db: Queryable, s: NewStaff): Promise<string> {
        try {
            const [row] = await db.query<{ oid: string }>(sql`
                insert into app_user (username, password_hash, name, email, kind, all_branches, must_change_password)
                values (${s.username}, ${s.passwordHash}, ${s.name}, ${s.email}, 'staff', ${s.allBranches}, true)
                returning oid`);
            if (!row) throw new Error('insert returned no row');
            return row.oid;
        } catch (err) {
            translate(err);
        }
    },

    async updateProfile(db: Queryable, oid: string, p: { name?: string | undefined; email?: string | null | undefined }): Promise<void> {
        await db.query(sql`
            update app_user set
                name = coalesce(${p.name ?? null}::text, name),
                email = case when ${p.email !== undefined} then ${p.email ?? null}::text else email end,
                updated_at = now()
            where oid = ${oid}`);
    },

    /** Replaces every assignment of the person (and the `all_branches` flag) with this set. */
    async setAssignments(db: Queryable, oid: string, list: readonly { branch_oid: string; role: StaffRole }[], allBranches: boolean): Promise<void> {
        try {
            await db.query(sql`delete from staff_assignment where user_oid = ${oid}`);
            for (const a of list)
                await db.query(sql`insert into staff_assignment (user_oid, branch_oid, role_code) values (${oid}, ${a.branch_oid}, ${a.role})`);
            await db.query(sql`update app_user set all_branches = ${allBranches}, updated_at = now() where oid = ${oid}`);
        } catch (err) {
            translate(err);
        }
    },

    /** One assignment at one branch: set (insert or change the role), or remove with `role = null`. */
    async setAssignmentAt(db: Queryable, oid: string, branchOid: string, role: StaffRole | null): Promise<void> {
        if (role === null) await db.query(sql`delete from staff_assignment where user_oid = ${oid} and branch_oid = ${branchOid}`);
        else
            await db.query(sql`
                insert into staff_assignment (user_oid, branch_oid, role_code) values (${oid}, ${branchOid}, ${role})
                on conflict (user_oid, branch_oid) do update set role_code = excluded.role_code`);
        await db.query(sql`update app_user set updated_at = now() where oid = ${oid}`);
    },

    async setStatus(db: Queryable, oid: string, status: 'Active' | 'Inactive'): Promise<void> {
        await db.query(sql`update app_user set status = ${status}, updated_at = now() where oid = ${oid}`);
    },

    /** An admin-typed temporary password (D-054): the person must replace it at their next sign-in. */
    async setTemporaryPassword(db: Queryable, oid: string, hash: string): Promise<void> {
        await db.query(sql`update app_user set password_hash = ${hash}, must_change_password = true, updated_at = now() where oid = ${oid}`);
    },

    /** Active branches, HQ first: the choices for an assignment (the HQ staff form). */
    async activeBranches(db: Queryable): Promise<{ oid: string; code: string; name: string; kind: BranchKind }[]> {
        return db.query(sql`select oid, code, name, kind from branch where status = 'Active' order by kind = 'HQ' desc, name`);
    },

    /** Kind of each named branch (unknown ids are missing from the map). */
    async branchKinds(db: Queryable, oids: readonly string[]): Promise<Map<string, BranchKind>> {
        if (oids.length === 0) return new Map();
        const rows = await db.query<{ oid: string; kind: BranchKind }>(sql`select oid, kind from branch where oid = any (${`{${oids.join(',')}}`}::uuid[])`);
        return new Map(rows.map(r => [r.oid, r.kind]));
    }
};
