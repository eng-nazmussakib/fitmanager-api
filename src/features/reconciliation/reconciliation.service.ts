import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { addDays, dhakaInstant } from '#src/lib/clock.ts';

/**
 * The phase 2 exit check (D-071): does the money reconcile? Read only, for HQ, over a range of Dhaka days.
 * 1. every invoice's paid amount (payments minus refunds) is between 0 and its total;
 * 2. each cash closing's expected cash equals the cash the system has for that staff member and day
 *    (cash payments minus cash refunds they took), and what they counted is shown beside it;
 * 3. every money write has its audit row: an invoice (create / upgrade; a locker rental's or a POS sale's invoice: invoice create), each later
 *    payment (pay), each refund (a POS return's too), each cash closing;
 * 4. every POS sale took its items off the stock, and every return put the undamaged ones back (phase 6, D-102).
 * Each check lists at most 100 offending rows; `ok` is true only when every check is clean.
 */

const LIMIT = 100;

interface Check<T> {
    key: string;
    label: string;
    ok: boolean;
    count: number;
    rows: T[];
}

function check<T>(key: string, label: string, rows: T[]): Check<T> {
    return { key, label, ok: rows.length === 0, count: rows.length, rows: rows.slice(0, LIMIT) };
}

async function invoicesOutOfRange(tx: Queryable, branches: readonly string[], from: Date, to: Date) {
    return tx.query<{ branch_code: string; number: string; total: number; paid: number }>(sql`
        select b.code as branch_code, i.number, i.total::float8 as total, coalesce(p.net, 0)::float8 as paid
        from invoice i join branch b on b.oid = i.branch_oid
        left join lateral (
            select sum(case when kind = 'payment' then amount else -amount end) as net from payment where invoice_oid = i.oid
        ) p on true
        where i.branch_oid = any (${branches}::uuid[]) and i.issued_at >= ${from} and i.issued_at < ${to}
          and (coalesce(p.net, 0) < 0 or coalesce(p.net, 0) > i.total)
        order by i.issued_at`);
}

async function closingsMismatch(tx: Queryable, branches: readonly string[], fromDay: string, toDay: string) {
    return tx.query<{ branch_code: string; day: string; staff: string; expected_cash: number; system_cash: number; counted_cash: number }>(sql`
        select b.code as branch_code, c.day::text as day, u.name as staff, c.expected_cash::float8 as expected_cash,
               coalesce(s.cash, 0)::float8 as system_cash, c.counted_cash::float8 as counted_cash
        from cash_closing c join branch b on b.oid = c.branch_oid join app_user u on u.oid = c.staff_oid
        left join lateral (
            select sum(case when p.kind = 'payment' then p.amount else -p.amount end) as cash from payment p
            where p.branch_oid = c.branch_oid and p.received_by = c.staff_oid and p.method = 'cash'
              and (p.received_at at time zone 'Asia/Dhaka')::date = c.day
        ) s on true
        where c.branch_oid = any (${branches}::uuid[]) and c.day between ${fromDay}::date and ${toDay}::date
          and c.expected_cash <> coalesce(s.cash, 0)
        order by c.day, b.code`);
}

async function closingsDifference(tx: Queryable, branches: readonly string[], fromDay: string, toDay: string) {
    return tx.query<{
        branch_code: string;
        day: string;
        staff: string;
        expected_cash: number;
        counted_cash: number;
        difference: number;
        note: string | null;
    }>(sql`
        select b.code as branch_code, c.day::text as day, u.name as staff, c.expected_cash::float8 as expected_cash,
               c.counted_cash::float8 as counted_cash, (c.counted_cash - c.expected_cash)::float8 as difference, c.note
        from cash_closing c join branch b on b.oid = c.branch_oid join app_user u on u.oid = c.staff_oid
        where c.branch_oid = any (${branches}::uuid[]) and c.day between ${fromDay}::date and ${toDay}::date
          and c.counted_cash <> c.expected_cash
        order by c.day, b.code`);
}

async function unaudited(tx: Queryable, branches: readonly string[], from: Date, to: Date, fromDay: string, toDay: string) {
    return tx.query<{ branch_code: string; kind: string; ref: string; at: Date }>(sql`
        with inv as (
            select i.oid, i.branch_oid, i.number, i.member_code, i.issued_at,
                   -- A plan's invoice is audited with its sale; a locker rental's (D-082) as the invoice itself.
                   exists (select 1 from audit_log a where a.branch_oid = i.branch_oid and a.entity_key = i.member_code || '/' || i.number
                           and ((a.entity = 'subscription' and a.action in ('create', 'upgrade')) or (a.entity = 'invoice' and a.action = 'create'))) as sold
            from invoice i where i.branch_oid = any (${branches}::uuid[])
        ),
        -- Payments and refunds that no 'pay' or 'refund' audit row names. The sale's audit row covers the one
        -- payment taken with the sale, so a sold invoice may have one of these; any more are unaudited.
        loose as (
            select p.*, inv.number, inv.sold,
                   row_number() over (partition by p.invoice_oid, p.kind order by p.received_at, p.oid) as n
            from payment p join inv on inv.oid = p.invoice_oid
            where not exists (select 1 from audit_log a where a.branch_oid = p.branch_oid and a.entity = 'invoice'
                              and a.action = case when p.kind = 'refund' then 'refund' else 'pay' end
                              and a.after ->> case when p.kind = 'refund' then 'refund' else 'payment' end = p.oid::text)
        )
        select b.code as branch_code, 'invoice' as kind, inv.number as ref, inv.issued_at as at
        from inv join branch b on b.oid = inv.branch_oid
        where inv.issued_at >= ${from} and inv.issued_at < ${to} and not inv.sold
        union all
        select b.code, l.kind, l.number || ' · ' || l.amount::text || ' ' || l.method, l.received_at
        from loose l join branch b on b.oid = l.branch_oid
        where l.received_at >= ${from} and l.received_at < ${to}
          and (l.kind = 'refund' or not l.sold or l.n > 1)
        union all
        select b.code, 'cash_closing', c.day::text || ' · ' || u.name, c.created_at
        from cash_closing c join branch b on b.oid = c.branch_oid join app_user u on u.oid = c.staff_oid
        where c.branch_oid = any (${branches}::uuid[]) and c.day between ${fromDay}::date and ${toDay}::date
          and not exists (select 1 from audit_log a where a.branch_oid = c.branch_oid and a.entity = 'cash_closing'
                          and a.action = 'close' and a.entity_key = c.day::text || '/' || u.name)
        order by at`);
}

/** POS invoices whose lines do not match the `sold` moves, and returns whose undamaged items did not come back. */
async function stockNotMoved(tx: Queryable, branches: readonly string[], from: Date, to: Date) {
    return tx.query<{ branch_code: string; ref: string; expected: number; moved: number }>(sql`
        select b.code as branch_code, i.number as ref, l.qty as expected, coalesce(m.qty, 0) as moved
        from invoice i join branch b on b.oid = i.branch_oid
        cross join lateral (select coalesce(sum((x ->> 'qty')::int), 0)::int as qty from jsonb_array_elements(i.lines) x where x ? 'product_oid') l
        left join lateral (select (-sum(sm.qty))::int as qty from stock_movement sm where sm.ref_oid = i.oid and sm.kind = 'sold') m on true
        where i.kind = 'pos' and i.branch_oid = any (${branches}::uuid[]) and i.issued_at >= ${from} and i.issued_at < ${to}
          and l.qty <> coalesce(m.qty, 0)
        union all
        select b.code, i.number || ' · return', l.qty, coalesce(m.qty, 0)
        from pos_return r join invoice i on i.oid = r.invoice_oid join branch b on b.oid = r.branch_oid
        cross join lateral (select coalesce(sum((x ->> 'qty')::int) filter (where not coalesce((x ->> 'damaged')::boolean, false)), 0)::int as qty
            from jsonb_array_elements(r.lines) x) l
        left join lateral (select sum(sm.qty)::int as qty from stock_movement sm where sm.ref_oid = r.oid and sm.kind = 'returned') m on true
        where r.branch_oid = any (${branches}::uuid[]) and r.at >= ${from} and r.at < ${to} and l.qty <> coalesce(m.qty, 0)
        order by 2`);
}

async function totals(tx: Queryable, branches: readonly string[], from: Date, to: Date, fromDay: string, toDay: string) {
    const [row] = await tx.query<{ invoices: number; invoiced: number; received: number; refunded: number; closings: number }>(sql`
        select
          (select count(*)::int from invoice where branch_oid = any (${branches}::uuid[]) and issued_at >= ${from} and issued_at < ${to}) as invoices,
          (select coalesce(sum(total), 0)::float8 from invoice where branch_oid = any (${branches}::uuid[]) and issued_at >= ${from} and issued_at < ${to}) as invoiced,
          (select coalesce(sum(amount), 0)::float8 from payment where kind = 'payment' and branch_oid = any (${branches}::uuid[]) and received_at >= ${from} and received_at < ${to}) as received,
          (select coalesce(sum(amount), 0)::float8 from payment where kind = 'refund' and branch_oid = any (${branches}::uuid[]) and received_at >= ${from} and received_at < ${to}) as refunded,
          (select count(*)::int from cash_closing where branch_oid = any (${branches}::uuid[]) and day between ${fromDay}::date and ${toDay}::date) as closings`);
    return row ?? { invoices: 0, invoiced: 0, received: 0, refunded: 0, closings: 0 };
}

export async function reconciliation(db: Db, ctx: BranchContext, branches: readonly string[], fromDay: string, toDay: string) {
    const from = dhakaInstant(fromDay);
    const to = dhakaInstant(addDays(toDay, 1));
    return withBranchTx(db, ctx, async tx => {
        const checks = [
            check('invoice_paid', 'Every invoice is paid between 0 and its total', await invoicesOutOfRange(tx, branches, from, to)),
            check('closing_expected', 'Every cash closing expects the cash the system took', await closingsMismatch(tx, branches, fromDay, toDay)),
            check(
                'audit',
                'Every invoice, payment, refund and cash closing has its audit row',
                (await unaudited(tx, branches, from, to, fromDay, toDay)).map(r => ({ ...r, at: r.at.toISOString() }))
            ),
            check('stock_moved', 'Every POS sale and return moved the stock', await stockNotMoved(tx, branches, from, to))
        ];
        return {
            from: fromDay,
            to: toDay,
            ok: checks.every(c => c.ok),
            totals: await totals(tx, branches, from, to, fromDay, toDay),
            checks,
            // Not an error: what the staff counted differs from what the system expected (short or over).
            cash_differences: await closingsDifference(tx, branches, fromDay, toDay)
        };
    });
}
