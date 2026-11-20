import type { Queryable } from '#src/db/db.ts';
import { type Sql, sql } from '#src/db/sql.ts';
import { livePhoto } from '#src/features/files/files.repo.ts';

export type MemberStatus = 'Active' | 'Expired' | 'Frozen' | 'Suspended' | 'Pending';
export type Gender = 'Male' | 'Female';

export interface EmergencyContact {
    name: string;
    phone: string;
    relation: string;
}

/** A member row with its derived state (status, plan, dues, last visit), before photo links are signed. */
export interface MemberRow {
    oid: string;
    branch_oid: string;
    branch_code: string;
    branch_slug: string;
    branch_name: string;
    code: string;
    name: string;
    phone: string | null;
    gender: Gender | null;
    email: string | null;
    date_of_birth: string | null;
    address: string | null;
    emergency_contact: EmergencyContact | null;
    health_flags: string[];
    health_declared: boolean;
    photo_file_oid: string | null;
    joined_on: string;
    pending: boolean;
    suspended_reason: string | null;
    notes: string | null;
    anonymised: boolean;
    source: 'desk' | 'web';
    status: MemberStatus;
    plan_name: string | null;
    valid_until: string | null;
    days_left: number | null;
    dues: number;
    last_visit: string | null;
    current_subscription_oid: string | null;
    frozen_until: string | null;
    /** The assigned trainer (D-078), if any. */
    trainer_oid: string | null;
    trainer_name: string | null;
    /** For the BMI (D-089), set with a measurement. */
    height_cm: number | null;
}

/**
 * One member's state, in SQL so lists filter, count and page in the database. "Relevant" subscription: the
 * current one, else the next upcoming, else the last. Status: Suspended → Pending → current (Frozen when a
 * freeze covers today, else Active) → upcoming (Active) → Expired. No grace period. Dues: what the member's
 * invoices at the branches in context still lack (payments minus refunds).
 */
function memberState(today: string): Sql {
    return sql`
        select m.oid, m.branch_oid, b.code as branch_code, b.slug as branch_slug, b.name as branch_name, m.code, m.name, m.phone, m.gender,
            m.email, m.date_of_birth::text as date_of_birth, m.address, m.emergency_contact, m.health_flags, m.health_declared,
            ${livePhoto('m.photo_file_oid')} as photo_file_oid, m.joined_on::text as joined_on, m.pending, m.suspended_reason, m.notes, m.anonymised_at is not null as anonymised,
            m.source,
            case
                when m.suspended_at is not null then 'Suspended'
                when m.pending then 'Pending'
                when rel.is_current and rel.frozen_until is not null then 'Frozen'
                when rel.is_current or rel.is_upcoming then 'Active'
                else 'Expired'
            end as status,
            rel.plan_name, rel.end_date::text as valid_until,
            case when rel.end_date is null then null else (rel.end_date - ${today}::date) end as days_left,
            coalesce(d.dues, 0)::float8 as dues,
            lv.last_visit,
            case when rel.is_current then rel.oid end as current_subscription_oid,
            rel.frozen_until::text as frozen_until,
            m.trainer_oid, (select u.name from trainer t join app_user u on u.oid = t.user_oid where t.oid = m.trainer_oid) as trainer_name,
            m.height_cm::float8 as height_cm
        from member m
        join branch b on b.oid = m.branch_oid
        left join lateral (
            select s.oid, s.plan_name, s.end_date,
                (s.start_date <= ${today}::date and ${today}::date <= s.end_date) as is_current,
                (s.start_date > ${today}::date) as is_upcoming,
                (select max((f ->> 'to')::date) from jsonb_array_elements(s.freezes) f
                    where (f ->> 'from')::date <= ${today}::date and ${today}::date <= (f ->> 'to')::date) as frozen_until
            from subscription s
            where s.member_oid = m.oid and s.kind = 'membership' and s.start_date <= s.end_date
            order by (s.start_date <= ${today}::date and ${today}::date <= s.end_date) desc,
                (s.start_date > ${today}::date) desc,
                case when s.start_date > ${today}::date then s.start_date end asc,
                s.end_date desc
            limit 1
        ) rel on true
        left join lateral (
            -- invoice_due() (migration 017): a refund never creates dues (D-067 a).
            select sum(invoice_due(i.total, x.paid_in, x.refunded)) as dues
            from invoice i cross join lateral (
                select coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as paid_in,
                       coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunded
                from payment p where p.invoice_oid = i.oid) x
            where i.member_oid = m.oid
        ) d on true
        left join lateral (select max(c.in_at) as last_visit from check_in c where c.member_oid = m.oid) lv on true`;
}

export interface ListQuery {
    q?: string | undefined;
    status?: MemberStatus | '' | undefined;
    plan?: string | undefined;
    flag?: 'expiring' | 'dues' | '' | undefined;
    page: number;
    size: number;
    sort_by?: string | undefined;
    sort_order?: 'asc' | 'desc' | undefined;
}

/** Sortable columns (a whitelist: never a column name from input). */
export const SORT_COLUMNS: Record<string, string> = {
    name: 'lower(ms.name)',
    code: 'ms.code',
    status: 'ms.status',
    valid_until: 'ms.valid_until',
    days_left: 'ms.days_left',
    dues: 'ms.dues',
    last_visit: 'ms.last_visit',
    joined_on: 'ms.joined_on'
};

export const membersRepo = {
    list: async (tx: Queryable, branchOid: string, today: string, q: ListQuery) => {
        const text = (q.q ?? '').trim().toLowerCase();
        const digits = text.replace(/\D/g, '');
        const filters: Sql[] = [sql`ms.branch_oid = ${branchOid}`];
        if (text) {
            const like = `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
            filters.push(
                digits.length >= 3
                    ? sql`(lower(ms.name) like ${like} or lower(ms.code) like ${like} or ms.phone like ${`%${digits}%`})`
                    : sql`(lower(ms.name) like ${like} or lower(ms.code) like ${like})`
            );
        }
        if (q.status) filters.push(sql`ms.status = ${q.status}`);
        if (q.plan) filters.push(sql`lower(coalesce(ms.plan_name, '')) like ${`${q.plan.toLowerCase()}%`}`);
        if (q.flag === 'expiring') filters.push(sql`ms.status = 'Active' and ms.days_left between 0 and 7`);
        if (q.flag === 'dues') filters.push(sql`ms.dues > 0`);
        const column = q.sort_by ? SORT_COLUMNS[q.sort_by] : undefined;
        const order = column ? sql.raw(`${column} ${q.sort_order === 'desc' ? 'desc' : 'asc'} nulls last, ms.code desc`) : sql.raw('ms.code desc');
        const base = sql`with ms as (${memberState(today)} where m.branch_oid = ${branchOid})`;
        const rows = await tx.query<MemberRow & { total: number }>(sql`
            ${base}
            select ms.*, count(*) over ()::int as total from ms
            where ${sql.join(filters, ' and ')}
            order by ${order}
            limit ${q.size} offset ${(q.page - 1) * q.size}`);
        const counts = await tx.query<{ status: MemberStatus; n: number }>(sql`${base} select status, count(*)::int as n from ms group by status`);
        return { rows, count: rows[0]?.total ?? (q.page > 1 ? await countOf(tx, base, filters) : 0), counts };
    },

    /** Every member's state at these branches (dashboards). */
    states: (tx: Queryable, branchOids: readonly string[], today: string) =>
        tx.query<MemberRow>(sql`${memberState(today)} where m.branch_oid = any (${branchOids}::uuid[]) and m.anonymised_at is null`),

    get: async (tx: Queryable, oid: string, branchOids: readonly string[], today: string) => {
        const [row] = await tx.query<MemberRow>(sql`${memberState(today)} where m.oid = ${oid} and m.branch_oid = any (${branchOids}::uuid[])`);
        return row;
    },

    byCode: async (tx: Queryable, code: string, branchOid: string, today: string) => {
        const [row] = await tx.query<MemberRow>(sql`${memberState(today)} where m.code = ${code.toUpperCase()} and m.branch_oid = ${branchOid}`);
        return row;
    },

    lock: async (tx: Queryable, oid: string, branchOid: string) => {
        const [row] = await tx.query<{ oid: string; code: string; phone: string | null; anonymised: boolean }>(sql`
            select oid, code, phone, anonymised_at is not null as anonymised from member
            where oid = ${oid} and branch_oid = ${branchOid} for update`);
        return row;
    },

    /** The next number of a per-branch sequence ('member', 'invoice:2026'), taken inside the transaction. */
    nextNumber: async (tx: Queryable, branchOid: string, name: string) => {
        const [row] = await tx.query<{ value: number }>(sql`
            insert into branch_counter (branch_oid, name, value) values (${branchOid}, ${name}, 1)
            on conflict (branch_oid, name) do update set value = branch_counter.value + 1
            returning value`);
        if (!row) throw new Error('branch_counter returned no row');
        return row.value;
    },

    insert: async (tx: Queryable, row: Record<string, unknown>) => {
        const keys = Object.keys(row);
        const [out] = await tx.query<{ oid: string }>(sql`
            insert into member (${sql.raw(keys.join(', '))})
            values (${sql.join(
                keys.map(k =>
                    k === 'emergency_contact'
                        ? sql`${row[k] == null ? null : JSON.stringify(row[k])}::jsonb`
                        : k === 'health_flags'
                          ? textArray(row[k] as string[])
                          : sql`${row[k]}`
                ),
                ', '
            )})
            returning oid`);
        if (!out) throw new Error('member insert returned no row');
        return out.oid;
    },

    update: async (tx: Queryable, oid: string, patch: Record<string, unknown>, actor: string) => {
        const sets = Object.entries(patch).map(([k, value]) =>
            k === 'emergency_contact'
                ? sql`emergency_contact = ${value === null ? null : JSON.stringify(value)}::jsonb`
                : k === 'health_flags'
                  ? sql`health_flags = ${textArray(value as string[])}`
                  : sql`${sql.raw(k)} = ${value}`
        );
        await tx.query(sql`update member set ${sql.join([...sets, sql`updated_by = ${actor}`, sql`updated_at = now()`], ', ')} where oid = ${oid}`);
    }
};

const textArray = (list: readonly string[]) => sql`array(select jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`;

async function countOf(tx: Queryable, base: Sql, filters: Sql[]): Promise<number> {
    const [row] = await tx.query<{ n: number }>(sql`${base} select count(*)::int as n from ms where ${sql.join(filters, ' and ')}`);
    return row?.n ?? 0;
}

/** Columns a patch may set (a whitelist for `update`). */
export const MEMBER_COLUMNS = new Set([
    'name',
    'phone',
    'gender',
    'email',
    'date_of_birth',
    'address',
    'emergency_contact',
    'health_flags',
    'health_declared',
    'photo_file_oid',
    'notes',
    'pending',
    'suspended_at',
    'suspended_reason',
    'anonymised_at',
    'branch_oid'
]);
