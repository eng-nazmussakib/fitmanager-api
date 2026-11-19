import type { Queryable } from '#src/db/db.ts';
import { type Sql, sql } from '#src/db/sql.ts';

import type { ProfileUpdate } from './branches.schema.ts';

/** Weekday numbers (0 = Sunday) and a range in Dhaka time, as the access rules read them. */
export interface HoursBlock {
    days: number[];
    open: string;
    close: string;
}

export interface BranchRef {
    oid: string;
    code: string;
    slug: string;
    name: string;
    kind: 'HQ' | 'BRANCH';
}

export interface BranchProfile extends BranchRef {
    status: 'Active' | 'Inactive';
    address: string | null;
    area: string | null;
    phone: string | null;
    email: string | null;
    map_url: string | null;
    opened_on: string | null;
    /** People allowed on the floor at once (live occupancy). */
    capacity: number;
    /** Dues above this block check-in, ৳ (D-061; a visitor's home branch limit applies, D-059). */
    dues_limit: number;
    facilities: string[];
    hours: HoursBlock[];
    ladies_hours: HoursBlock[];
}

/** What the public site may show: no dues limit, no status. */
export type PublicBranch = Omit<BranchProfile, 'dues_limit' | 'status'>;

export const REF = sql.raw('b.oid, b.code, b.slug, b.name, b.kind');
const PROFILE = sql.raw(`b.oid, b.code, b.slug, b.name, b.kind, b.status, b.address, b.area, b.phone, b.email, b.map_url,
    b.opened_on::text as opened_on, b.capacity, b.dues_limit::float8 as dues_limit, b.facilities, b.hours, b.ladies_hours`);
const PUBLIC = sql.raw(`b.oid, b.code, b.slug, b.name, b.kind, b.address, b.area, b.phone, b.email, b.map_url,
    b.opened_on::text as opened_on, b.capacity, b.facilities, b.hours, b.ladies_hours`);

/** `branch` has no RLS: which branches a caller may see is decided by the caller's assignments (`oids`). */
export const branchesRepo = {
    profiles: (db: Queryable, oids: readonly string[]) =>
        db.query<BranchProfile>(sql`
            select ${PROFILE} from branch b
            where b.oid = any (${`{${oids.join(',')}}`}::uuid[])
            order by b.kind = 'BRANCH', b.name`),

    async profile(db: Queryable, oid: string, forUpdate = false): Promise<BranchProfile | undefined> {
        const [row] = await db.query<BranchProfile>(sql`select ${PROFILE} from branch b where b.oid = ${oid} ${forUpdate ? sql`for update` : sql``}`);
        return row;
    },

    publicList: (db: Queryable) => db.query<PublicBranch>(sql`select ${PUBLIC} from branch b where b.kind = 'BRANCH' and b.status = 'Active' order by b.name`),

    async publicBySlug(db: Queryable, slug: string): Promise<PublicBranch | undefined> {
        const [row] = await db.query<PublicBranch>(sql`select ${PUBLIC} from branch b where b.kind = 'BRANCH' and b.status = 'Active' and b.slug = ${slug}`);
        return row;
    },

    /** Every active selling branch: the context public reads use (D-043: plans are branch rows). */
    activeBranchOids: async (db: Queryable) =>
        (await db.query<{ oid: string }>(sql`select oid from branch where kind = 'BRANCH' and status = 'Active' order by name`)).map(r => r.oid),

    async updateProfile(db: Queryable, oid: string, p: ProfileUpdate, by: string): Promise<BranchProfile | undefined> {
        const sets: Sql[] = [];
        const text = { address: p.address, area: p.area, phone: p.phone, email: p.email, map_url: p.map_url };
        for (const [column, value] of Object.entries(text)) if (value !== undefined) sets.push(sql`${sql.raw(column)} = ${value}::text`);
        if (p.opened_on !== undefined) sets.push(sql`opened_on = ${p.opened_on}::date`);
        if (p.capacity !== undefined) sets.push(sql`capacity = ${p.capacity}::int`);
        if (p.dues_limit !== undefined) sets.push(sql`dues_limit = ${p.dues_limit}::numeric`);
        // Arrays and JSON go in as JSON text: the same on pg and PGlite.
        if (p.facilities !== undefined) sets.push(sql`facilities = array(select jsonb_array_elements_text(${JSON.stringify(p.facilities)}::jsonb))`);
        if (p.hours !== undefined) sets.push(sql`hours = ${JSON.stringify(p.hours)}::jsonb`);
        if (p.ladies_hours !== undefined) sets.push(sql`ladies_hours = ${JSON.stringify(p.ladies_hours)}::jsonb`);
        const [row] = await db.query<BranchProfile>(sql`
            update branch b set ${sql.join([...sets, sql`updated_at = now()`, sql`updated_by = ${by}`])}
            where b.oid = ${oid}
            returning ${PROFILE}`);
        return row;
    }
};
