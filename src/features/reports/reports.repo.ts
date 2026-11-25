import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { addDays, dhakaInstant } from '#src/lib/clock.ts';

import type { Range } from './reports.build.ts';
import type { TrainerNumbers } from './reports.defs.ts';

/**
 * The reports' SQL: computed when read, grouped by branch (and by Dhaka day or by a dimension), so the
 * same query serves a branch and HQ. Numbers come back as float8/int; the service turns them into components.
 * Every query filters `branch_oid = any(branches)` itself, under the caller's RLS context.
 */

type Branches = readonly string[];
const span = (r: Range) => ({ from: dhakaInstant(r.from), to: dhakaInstant(addDays(r.to, 1)) });
const DAY = (col: string) => sql.raw(`((${col}) at time zone 'Asia/Dhaka')::date::text`);

/* ---------- revenue ---------- */

export function revenueDays(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{
        branch_oid: string;
        day: string;
        invoices: number;
        invoiced: number;
        shop: number;
        discount: number;
        vat: number;
        received: number;
        refunded: number;
    }>(sql`
        select branch_oid::text, day, sum(invoices)::int as invoices, sum(invoiced)::float8 as invoiced, sum(shop)::float8 as shop,
               sum(discount)::float8 as discount, sum(vat)::float8 as vat, sum(received)::float8 as received, sum(refunded)::float8 as refunded
        from (
            select branch_oid, ${DAY('issued_at')} as day, count(*) as invoices, sum(total) as invoiced,
                   sum(total) filter (where kind = 'pos') as shop, sum(discount) as discount, sum(vat) as vat, 0 as received, 0 as refunded
            from invoice where branch_oid = any (${b}::uuid[]) and issued_at >= ${from} and issued_at < ${to} group by 1, 2
            union all
            select branch_oid, ${DAY('received_at')}, 0, 0, 0, 0, 0,
                   coalesce(sum(amount) filter (where kind = 'payment'), 0), coalesce(sum(amount) filter (where kind = 'refund'), 0)
            from payment where branch_oid = any (${b}::uuid[]) and received_at >= ${from} and received_at < ${to} group by 1, 2
        ) x group by 1, 2`);
}

export function revenueBySource(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; dim: string; invoices: number; invoiced: number; discount: number; vat: number }>(sql`
        select i.branch_oid::text,
               case i.kind when 'pos' then 'Shop' when 'locker' then 'Locker rentals' else coalesce(s.plan_name, 'Other') end as dim,
               count(*)::int as invoices, sum(i.total)::float8 as invoiced, sum(i.discount)::float8 as discount, sum(i.vat)::float8 as vat
        from invoice i left join subscription s on s.oid = i.subscription_oid
        where i.branch_oid = any (${b}::uuid[]) and i.issued_at >= ${from} and i.issued_at < ${to}
        group by 1, 2`);
}

export function revenueByMethod(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; dim: string; payments: number; received: number; refunded: number }>(sql`
        select branch_oid::text, method as dim, count(*) filter (where kind = 'payment')::int as payments,
               coalesce(sum(amount) filter (where kind = 'payment'), 0)::float8 as received,
               coalesce(sum(amount) filter (where kind = 'refund'), 0)::float8 as refunded
        from payment where branch_oid = any (${b}::uuid[]) and received_at >= ${from} and received_at < ${to}
        group by 1, 2`);
}

/* ---------- dues (as of the range's end) ---------- */

/** Every invoice still owing at the end of `asOf`, with its age in days. invoice_due() (017): a refund never makes dues. */
function owing(b: Branches, asOf: string) {
    const to = dhakaInstant(addDays(asOf, 1));
    return sql`
        select i.branch_oid, i.member_oid, i.member_code, i.member_name, i.number,
               (${asOf}::date - ${DAY('i.issued_at')}::date) as age,
               invoice_due(i.total, coalesce(p.paid_in, 0), coalesce(p.refunded, 0)) as due
        from invoice i
        left join lateral (
            select sum(amount) filter (where kind = 'payment') as paid_in, sum(amount) filter (where kind = 'refund') as refunded
            from payment where invoice_oid = i.oid and received_at < ${to}
        ) p on true
        where i.branch_oid = any (${b}::uuid[]) and i.issued_at < ${to}`;
}

export function duesTotals(tx: Queryable, b: Branches, asOf: string) {
    return tx.query<{ branch_oid: string; due: number; invoices: number; members: number; over_30: number }>(sql`
        select branch_oid::text, sum(due)::float8 as due, count(*)::int as invoices, count(distinct coalesce(member_oid::text, number))::int as members,
               coalesce(sum(due) filter (where age > 30), 0)::float8 as over_30
        from (${owing(b, asOf)}) o where due > 0 group by 1`);
}

export function duesByAge(tx: Queryable, b: Branches, asOf: string) {
    return tx.query<{ branch_oid: string; dim: string; due: number; invoices: number }>(sql`
        -- The buckets of DUE_AGES (reports.defs.ts).
        select branch_oid::text,
               case when age <= 30 then '0–30 days' when age <= 60 then '31–60 days' when age <= 90 then '61–90 days' else 'Over 90 days' end as dim,
               sum(due)::float8 as due, count(*)::int as invoices
        from (${owing(b, asOf)}) o where due > 0 group by 1, 2`);
}

export function duesLargest(tx: Queryable, b: Branches, asOf: string, limit: number) {
    return tx.query<{ branch_oid: string; member_code: string; member_name: string; due: number; invoices: number; oldest: number }>(sql`
        select branch_oid::text, member_code, member_name, sum(due)::float8 as due, count(*)::int as invoices, max(age)::int as oldest
        from (${owing(b, asOf)}) o where due > 0 and member_oid is not null
        group by 1, 2, 3 order by sum(due) desc, member_code limit ${limit}`);
}

/* ---------- members ---------- */

/** New members (joined, not a pending join request) and plan sales per day: first plans and renewals. */
export function memberDays(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; day: string; joined: number; first_plans: number; renewals: number; upgrades: number }>(sql`
        select branch_oid::text, day, sum(joined)::int as joined, sum(first_plans)::int as first_plans, sum(renewals)::int as renewals,
               sum(upgrades)::int as upgrades
        from (
            select branch_oid, joined_on::text as day, count(*) as joined, 0 as first_plans, 0 as renewals, 0 as upgrades
            from member where branch_oid = any (${b}::uuid[]) and joined_on between ${r.from}::date and ${r.to}::date and not pending
              and anonymised_at is null group by 1, 2
            union all
            select s.branch_oid, ${DAY('s.created_at')}, 0,
                   count(*) filter (where not earlier.any_before and i.kind <> 'upgrade'),
                   count(*) filter (where earlier.any_before and i.kind <> 'upgrade'),
                   count(*) filter (where i.kind = 'upgrade')
            from subscription s join invoice i on i.oid = s.invoice_oid
            cross join lateral (
                select exists (select from subscription e where e.member_oid = s.member_oid and e.kind = 'membership' and e.created_at < s.created_at) as any_before
            ) earlier
            where s.branch_oid = any (${b}::uuid[]) and s.kind = 'membership' and s.created_at >= ${from} and s.created_at < ${to}
            group by 1, 2
        ) x group by 1, 2`);
}

/**
 * Members at the end of the range: active (a plan covering the last day), lapsed (their last plan ended inside the
 * range and nothing came after it), expiring (a plan ending in the 14 days after, with nothing after it).
 */
export function memberState(tx: Queryable, b: Branches, r: Range) {
    const to = dhakaInstant(addDays(r.to, 1));
    return tx.query<{ branch_oid: string; active: number; lapsed: number; expiring: number }>(sql`
        with last_plan as (
            select distinct on (s.member_oid) s.member_oid, s.home_branch_oid as branch_oid, s.start_date, s.end_date
            from subscription s
            where s.home_branch_oid = any (${b}::uuid[]) and s.kind = 'membership' and s.created_at < ${to}
              -- A plan cancelled before it began (refunded in full) never ran.
              and s.end_date >= s.start_date
            order by s.member_oid, s.end_date desc
        )
        select branch_oid::text,
               count(*) filter (where start_date <= ${r.to}::date and end_date >= ${r.to}::date)::int as active,
               count(*) filter (where end_date between ${r.from}::date and ${r.to}::date - 1)::int as lapsed,
               count(*) filter (where end_date between ${r.to}::date + 1 and ${r.to}::date + 14)::int as expiring
        from last_plan group by 1`);
}

export function plansSold(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; dim: string; sold: number; renewals: number; invoiced: number }>(sql`
        select s.branch_oid::text, s.plan_name as dim, count(*)::int as sold,
               count(*) filter (where i.kind <> 'upgrade' and exists (select from subscription e where e.member_oid = s.member_oid and e.kind = 'membership' and e.created_at < s.created_at))::int as renewals,
               coalesce(sum(i.total), 0)::float8 as invoiced
        from subscription s left join invoice i on i.oid = s.invoice_oid
        where s.branch_oid = any (${b}::uuid[]) and s.kind = 'membership' and s.created_at >= ${from} and s.created_at < ${to}
        group by 1, 2`);
}

export function expiringSoon(tx: Queryable, b: Branches, r: Range, limit: number) {
    const to = dhakaInstant(addDays(r.to, 1));
    return tx.query<{ branch_oid: string; member_code: string; member_name: string; plan: string; ends: string }>(sql`
        select branch_oid, member_code, member_name, plan, ends from (
            select distinct on (s.member_oid) s.home_branch_oid::text as branch_oid, m.code as member_code, m.name as member_name,
                   s.plan_name as plan, s.end_date::text as ends, s.end_date
            from subscription s join member m on m.oid = s.member_oid
            where s.home_branch_oid = any (${b}::uuid[]) and s.kind = 'membership' and s.created_at < ${to} and s.cancelled_at is null
            order by s.member_oid, s.end_date desc
        ) x where end_date between ${r.to}::date + 1 and ${r.to}::date + 14
        order by end_date, member_code limit ${limit}`);
}

/* ---------- attendance ---------- */

export function visitDays(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; day: string; visits: number; members: number; visitors: number; stays: number; stay_minutes: number }>(sql`
        select branch_oid::text, ${DAY('in_at')} as day, count(*)::int as visits, count(distinct member_oid)::int as members,
               count(*) filter (where member_branch_oid <> branch_oid)::int as visitors,
               count(*) filter (where out_at is not null and not auto_out)::int as stays,
               coalesce(sum(extract(epoch from out_at - in_at) / 60) filter (where out_at is not null and not auto_out), 0)::float8 as stay_minutes
        from check_in where branch_oid = any (${b}::uuid[]) and in_at >= ${from} and in_at < ${to}
        group by 1, 2`);
}

/** Members who came at all in the range (a member counted once however often). */
export function uniqueVisitors(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; unique_members: number }>(sql`
        select branch_oid::text, count(distinct member_oid)::int as unique_members
        from check_in where branch_oid = any (${b}::uuid[]) and in_at >= ${from} and in_at < ${to} group by 1`);
}

/** Visits by weekday (0 = Sunday) and hour, Dhaka time. */
export function visitHours(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; dow: number; hour: number; visits: number }>(sql`
        select branch_oid::text, extract(dow from in_at at time zone 'Asia/Dhaka')::int as dow,
               extract(hour from in_at at time zone 'Asia/Dhaka')::int as hour, count(*)::int as visits
        from check_in where branch_oid = any (${b}::uuid[]) and in_at >= ${from} and in_at < ${to}
        group by 1, 2, 3`);
}

/* ---------- classes ---------- */

const SESSION_COMP = sql.raw(`
    count(*) filter (where c.cancelled_at is null)::int as held,
    count(*) filter (where c.cancelled_at is not null)::int as cancelled,
    coalesce(sum(c.capacity) filter (where c.cancelled_at is null), 0)::int as capacity,
    coalesce(sum(k.booked) filter (where c.cancelled_at is null), 0)::int as booked,
    coalesce(sum(k.attended) filter (where c.cancelled_at is null), 0)::int as attended,
    coalesce(sum(k.no_shows) filter (where c.cancelled_at is null), 0)::int as no_shows,
    coalesce(sum(k.waitlist) filter (where c.cancelled_at is null), 0)::int as waitlist,
    coalesce(sum(k.late) filter (where c.cancelled_at is null), 0)::int as late_cancels`);

const BOOKINGS = sql.raw(`
    left join lateral (
        select count(*) filter (where status in ('Booked', 'Attended', 'NoShow')) as booked,
               count(*) filter (where status = 'Attended') as attended,
               count(*) filter (where status = 'NoShow') as no_shows,
               count(*) filter (where status = 'Waitlist') as waitlist,
               count(*) filter (where late_cancel) as late
        from booking where session_oid = c.oid
    ) k on true`);

export function classDays(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{
        branch_oid: string;
        day: string;
        held: number;
        cancelled: number;
        capacity: number;
        booked: number;
        attended: number;
        no_shows: number;
        waitlist: number;
        late_cancels: number;
    }>(sql`
        select c.branch_oid::text, c.session_date::text as day, ${SESSION_COMP}
        from class_session c ${BOOKINGS}
        where c.branch_oid = any (${b}::uuid[]) and c.starts_at >= ${from} and c.starts_at < ${to}
        group by 1, 2`);
}

export function classByType(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{
        branch_oid: string;
        dim: string;
        held: number;
        cancelled: number;
        capacity: number;
        booked: number;
        attended: number;
        no_shows: number;
    }>(sql`
        select c.branch_oid::text, t.name as dim, ${SESSION_COMP}
        from class_session c join class_type t on t.oid = c.class_type_oid ${BOOKINGS}
        where c.branch_oid = any (${b}::uuid[]) and c.starts_at >= ${from} and c.starts_at < ${to}
        group by 1, 2`);
}

/* ---------- trainers (PT and classes, counts only: no commission) ---------- */

export function trainerNumbers(tx: Queryable, b: Branches, r: Range, trainerOid?: string) {
    const { from, to } = span(r);
    const only = trainerOid ? sql`and trainer_oid = ${trainerOid}` : sql.raw('');
    return tx.query<TrainerNumbers>(sql`
        select x.branch_oid::text, x.trainer_oid::text, u.name as trainer,
               sum(pt_completed)::int as pt_completed, sum(pt_no_shows)::int as pt_no_shows, sum(pt_cancelled)::int as pt_cancelled,
               sum(pt_booked)::int as pt_booked, sum(classes)::int as classes, sum(class_attended)::int as class_attended,
               sum(class_no_shows)::int as class_no_shows, sum(ratings)::int as ratings, sum(rating_sum)::int as rating_sum
        from (
            select branch_oid, trainer_oid, count(*) filter (where status = 'Completed') as pt_completed,
                   count(*) filter (where status = 'NoShow') as pt_no_shows, count(*) filter (where status = 'Cancelled') as pt_cancelled,
                   count(*) filter (where status = 'Booked') as pt_booked, 0 as classes, 0 as class_attended, 0 as class_no_shows, 0 as ratings, 0 as rating_sum
            from pt_session where branch_oid = any (${b}::uuid[]) and starts_at >= ${from} and starts_at < ${to} ${only} group by 1, 2
            union all
            select c.branch_oid, c.trainer_oid, 0, 0, 0, 0, count(*), coalesce(sum(k.attended), 0), coalesce(sum(k.no_shows), 0), 0, 0
            from class_session c ${BOOKINGS}
            where c.branch_oid = any (${b}::uuid[]) and c.cancelled_at is null and c.starts_at >= ${from} and c.starts_at < ${to}
              ${trainerOid ? sql`and c.trainer_oid = ${trainerOid}` : sql.raw('')} group by 1, 2
            union all
            select branch_oid, trainer_oid, 0, 0, 0, 0, 0, 0, 0, count(*), sum(score)
            from rating where branch_oid = any (${b}::uuid[]) and trainer_oid is not null and created_at >= ${from} and created_at < ${to} ${only}
            group by 1, 2
        ) x join trainer t on t.oid = x.trainer_oid join app_user u on u.oid = t.user_oid
        group by 1, 2, 3 order by 3`);
}

/** Completed PT sessions per day (the trainers report's chart). */
export function ptDays(tx: Queryable, b: Branches, r: Range, trainerOid?: string) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; day: string; pt_completed: number; classes: number }>(sql`
        select branch_oid::text, day, sum(pt)::int as pt_completed, sum(classes)::int as classes from (
            select branch_oid, ${DAY('starts_at')} as day, count(*) as pt, 0 as classes from pt_session
            where branch_oid = any (${b}::uuid[]) and status = 'Completed' and starts_at >= ${from} and starts_at < ${to}
              ${trainerOid ? sql`and trainer_oid = ${trainerOid}` : sql.raw('')} group by 1, 2
            union all
            select branch_oid, session_date::text, 0, count(*) from class_session
            where branch_oid = any (${b}::uuid[]) and cancelled_at is null and starts_at >= ${from} and starts_at < ${to}
              ${trainerOid ? sql`and trainer_oid = ${trainerOid}` : sql.raw('')} group by 1, 2
        ) x group by 1, 2`);
}

/* ---------- shop (margin at average cost) ---------- */

/**
 * Per product line sold: what it brought in without VAT, and what it cost (the `sold` moves at the average cost
 * of the time). Returns: what went back without VAT, and the cost of what went back on the shelf (damaged items
 * stay a cost). Grouped by branch, day and product.
 */
function shopLines(b: Branches, r: Range) {
    const { from, to } = span(r);
    return sql`
        select i.branch_oid, ${DAY('i.issued_at')} as day, (l ->> 'product_oid')::uuid as product_oid,
               (l ->> 'qty')::int as qty, ((l ->> 'total')::numeric - (l ->> 'vat')::numeric) as net, (l ->> 'total')::numeric as gross,
               0::numeric as returned_net, 0::int as returned_qty
        from invoice i cross join lateral jsonb_array_elements(i.lines) l
        where i.kind = 'pos' and i.branch_oid = any (${b}::uuid[]) and i.issued_at >= ${from} and i.issued_at < ${to} and l ? 'product_oid'
        union all
        select r.branch_oid, ${DAY('r.at')}, (x ->> 'product_oid')::uuid, 0, 0, 0,
               (x ->> 'amount')::numeric * case when (il ->> 'total')::numeric > 0 then 1 - (il ->> 'vat')::numeric / (il ->> 'total')::numeric else 1 end,
               (x ->> 'qty')::int
        from pos_return r join invoice i on i.oid = r.invoice_oid
        cross join lateral jsonb_array_elements(r.lines) x
        cross join lateral (select i.lines -> (x ->> 'index')::int as il) li
        where r.branch_oid = any (${b}::uuid[]) and r.at >= ${from} and r.at < ${to}`;
}

function shopCosts(b: Branches, r: Range) {
    const { from, to } = span(r);
    return sql`
        select branch_oid, ${DAY('at')} as day, product_oid,
               -- sold moves are negative (a cost), returned ones positive (the cost back)
               sum(-qty * unit_cost) as cost
        from stock_movement
        where kind in ('sold', 'returned') and branch_oid = any (${b}::uuid[]) and at >= ${from} and at < ${to}
        group by 1, 2, 3`;
}

export function shopDays(tx: Queryable, b: Branches, r: Range) {
    return tx.query<{
        branch_oid: string;
        day: string;
        qty: number;
        net: number;
        gross: number;
        returned_net: number;
        returned_qty: number;
        cost: number;
        sales: number;
    }>(sql`
        select branch_oid::text, day, sum(qty)::int as qty, sum(net)::float8 as net, sum(gross)::float8 as gross,
               round(sum(returned_net))::float8 as returned_net, sum(returned_qty)::int as returned_qty, sum(cost)::float8 as cost, sum(sales)::int as sales
        from (
            select branch_oid, day, qty, net, gross, returned_net, returned_qty, 0 as cost, 0 as sales from (${shopLines(b, r)}) l
            union all
            select branch_oid, day, 0, 0, 0, 0, 0, cost, 0 from (${shopCosts(b, r)}) c
            union all
            select branch_oid, ${DAY('issued_at')}, 0, 0, 0, 0, 0, 0, count(*) from invoice
            where kind = 'pos' and branch_oid = any (${b}::uuid[]) and issued_at >= ${span(r).from} and issued_at < ${span(r).to} group by 1, 2
        ) x group by 1, 2`);
}

export function shopByProduct(tx: Queryable, b: Branches, r: Range, by: 'product' | 'category') {
    const dim = by === 'product' ? sql.raw('p.name') : sql.raw('p.category');
    return tx.query<{ branch_oid: string; dim: string; qty: number; net: number; returned_net: number; cost: number }>(sql`
        select x.branch_oid::text, ${dim} as dim, sum(qty)::int as qty, sum(net)::float8 as net, round(sum(returned_net))::float8 as returned_net,
               sum(cost)::float8 as cost
        from (
            select branch_oid, product_oid, qty, net, returned_net, 0 as cost from (${shopLines(b, r)}) l
            union all
            select branch_oid, product_oid, 0, 0, 0, cost from (${shopCosts(b, r)}) c
        ) x join product p on p.oid = x.product_oid
        group by 1, 2`);
}

/* ---------- operations: stock value, equipment spend, complaints, NPS ---------- */

export function stockValue(tx: Queryable, b: Branches) {
    return tx.query<{ branch_oid: string; dim: string; units: number; value: number; low: number }>(sql`
        select s.branch_oid::text, p.category as dim, sum(s.on_hand)::int as units, sum(s.on_hand * s.avg_cost)::float8 as value,
               count(*) filter (where s.on_hand <= s.reorder_level and p.active)::int as low
        from stock s join product p on p.oid = s.product_oid
        where s.branch_oid = any (${b}::uuid[]) group by 1, 2`);
}

export function equipmentSpend(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{ branch_oid: string; dim: string; repairs: number; repair_cost: number; bought: number; purchase_cost: number }>(sql`
        select branch_oid::text, dim, sum(repairs)::int as repairs, sum(repair_cost)::float8 as repair_cost, sum(bought)::int as bought,
               sum(purchase_cost)::float8 as purchase_cost
        from (
            select k.branch_oid, e.category as dim, count(*) as repairs, coalesce(sum(k.cost), 0) as repair_cost, 0 as bought, 0 as purchase_cost
            from maintenance_ticket k join equipment e on e.oid = k.equipment_oid
            where k.branch_oid = any (${b}::uuid[]) and k.closed_at >= ${from} and k.closed_at < ${to} group by 1, 2
            union all
            select branch_oid, category, 0, 0, count(*), coalesce(sum(cost), 0) from equipment
            where branch_oid = any (${b}::uuid[]) and purchased_on between ${r.from}::date and ${r.to}::date group by 1, 2
        ) x group by 1, 2`);
}

export function openTickets(tx: Queryable, b: Branches) {
    return tx.query<{ branch_oid: string; open_tickets: number; urgent: number; out_of_order: number }>(sql`
        select k.branch_oid::text, count(*) filter (where k.status in ('open', 'in_progress'))::int as open_tickets,
               count(*) filter (where k.status in ('open', 'in_progress') and k.priority = 'urgent')::int as urgent,
               (select count(*) from equipment e where e.branch_oid = k.branch_oid and e.status = 'out_of_order')::int as out_of_order
        from maintenance_ticket k where k.branch_oid = any (${b}::uuid[]) group by k.branch_oid`);
}

export function complaintsByCategory(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{
        branch_oid: string;
        dim: string;
        complaints: number;
        resolved: number;
        escalated: number;
        responded: number;
        response_hours: number;
    }>(sql`
        select branch_oid::text, category as dim, count(*)::int as complaints,
               count(*) filter (where status in ('resolved', 'closed'))::int as resolved,
               count(*) filter (where escalated_at is not null)::int as escalated,
               count(*) filter (where first_response_at is not null)::int as responded,
               coalesce(sum(extract(epoch from first_response_at - created_at) / 3600) filter (where first_response_at is not null), 0)::float8 as response_hours
        from complaint where branch_oid = any (${b}::uuid[]) and created_at >= ${from} and created_at < ${to}
        group by 1, 2`);
}

export function feedbackDays(tx: Queryable, b: Branches, r: Range) {
    const { from, to } = span(r);
    return tx.query<{
        branch_oid: string;
        day: string;
        answers: number;
        promoters: number;
        detractors: number;
        complaints: number;
        ratings: number;
        rating_sum: number;
    }>(sql`
        select branch_oid::text, day, sum(answers)::int as answers, sum(promoters)::int as promoters, sum(detractors)::int as detractors,
               sum(complaints)::int as complaints, sum(ratings)::int as ratings, sum(rating_sum)::int as rating_sum
        from (
            select branch_oid, ${DAY('created_at')} as day, count(*) as answers, count(*) filter (where score >= 9) as promoters,
                   count(*) filter (where score <= 6) as detractors, 0 as complaints, 0 as ratings, 0 as rating_sum
            from nps_response where branch_oid = any (${b}::uuid[]) and score is not null and created_at >= ${from} and created_at < ${to} group by 1, 2
            union all
            select branch_oid, ${DAY('created_at')}, 0, 0, 0, count(*), 0, 0
            from complaint where branch_oid = any (${b}::uuid[]) and created_at >= ${from} and created_at < ${to} group by 1, 2
            union all
            select branch_oid, ${DAY('created_at')}, 0, 0, 0, 0, count(*), sum(score)
            from rating where branch_oid = any (${b}::uuid[]) and created_at >= ${from} and created_at < ${to} group by 1, 2
        ) x group by 1, 2`);
}

export function branchesOf(tx: Queryable, b: Branches) {
    return tx.query<{ oid: string; code: string; name: string }>(sql`
        select oid::text, code, name from branch where oid = any (${b}::uuid[]) and kind = 'BRANCH' order by name`);
}
