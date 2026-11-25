import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';

export type PaymentMethod = 'cash' | 'card' | 'bkash' | 'nagad' | 'bank';
export const METHODS: readonly PaymentMethod[] = ['cash', 'card', 'bkash', 'nagad', 'bank'];
/** bKash, Nagad, card and bank need the transaction reference. */
export const NEEDS_REFERENCE: readonly PaymentMethod[] = ['card', 'bkash', 'nagad', 'bank'];

export interface Freeze {
    from: string;
    to: string;
    days: number;
    reason: string;
    by: string;
    by_name: string;
    at: string;
}

export interface SubscriptionRow {
    oid: string;
    branch_oid: string;
    home_branch_oid: string;
    member_oid: string;
    plan_oid: string;
    plan_name: string;
    months: number;
    freezable: boolean;
    /** A membership, or a PT package. */
    kind: 'membership' | 'pt';
    /** PT sessions bought; null for a membership. */
    sessions: number | null;
    start_date: string;
    end_date: string;
    freezes: Freeze[];
    cancelled_at: Date | null;
    cancel_reason: string | null;
    upgraded_to: string | null;
    invoice_oid: string | null;
    created_at: Date;
    total: number;
    paid: number;
    /** invoice_due(): a refund never creates dues. */
    due: number;
    /** PT sessions that used a credit of this package (0 for a membership). */
    sessions_used: number;
}

export interface PaymentRow {
    oid: string;
    invoice_oid: string;
    /** Null on a walk-in POS sale. */
    member_oid: string | null;
    kind: 'payment' | 'refund';
    amount: number;
    method: PaymentMethod;
    reference: string | null;
    reason: string | null;
    received_at: Date;
    received_by: string;
    received_by_oid: string | null;
    approved_by: string | null;
}

export interface InvoiceRow {
    oid: string;
    branch_oid: string;
    branch_code: string;
    branch_slug: string;
    branch_name: string;
    /** Null on a walk-in POS sale: `member_code` is 'WALK-IN'. */
    member_oid: string | null;
    subscription_oid: string | null;
    number: string;
    kind: 'sale' | 'upgrade' | 'locker' | 'pos';
    member_code: string;
    member_name: string;
    member_phone: string | null;
    /** POS lines carry the product, quantity, unit price, VAT rate, discount and total too. */
    lines: ({ label: string; amount: number } & Record<string, unknown>)[];
    subtotal: number;
    discount: number;
    discount_label: string | null;
    vat_rate: number;
    vat_inclusive: boolean;
    vat_bin: string | null;
    vat: number;
    total: number;
    issued_at: Date;
    paid: number;
    refunded: number;
}

const SUBSCRIPTION = sql.raw(`s.oid, s.branch_oid, s.home_branch_oid, s.member_oid, s.plan_oid, s.plan_name, s.months, s.freezable, s.kind, s.sessions,
    s.start_date::text as start_date, s.end_date::text as end_date, s.freezes, s.cancelled_at, s.cancel_reason, s.upgraded_to,
    s.invoice_oid, s.created_at,
    coalesce(i.total, 0)::float8 as total,
    coalesce((select sum(case when p.kind = 'payment' then p.amount else -p.amount end) from payment p where p.invoice_oid = s.invoice_oid), 0)::float8 as paid,
    coalesce((select invoice_due(i.total, coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0), coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0))
        from payment p where p.invoice_oid = s.invoice_oid), 0)::float8 as due,
    (select count(*)::int from pt_session ps where ps.subscription_oid = s.oid and ps.charged) as sessions_used
    from subscription s left join invoice i on i.oid = s.invoice_oid`);

const INVOICE = sql.raw(`i.oid, i.branch_oid, b.code as branch_code, b.slug as branch_slug, b.name as branch_name, i.member_oid, i.subscription_oid,
    i.number, i.kind, i.member_code, i.member_name, i.member_phone, i.lines, i.subtotal::float8 as subtotal, i.discount::float8 as discount,
    i.discount_label, i.vat_rate::float8 as vat_rate, i.vat_inclusive, i.vat_bin, i.vat::float8 as vat, i.total::float8 as total, i.issued_at,
    coalesce((select sum(p.amount) from payment p where p.invoice_oid = i.oid and p.kind = 'payment'), 0)::float8 as paid,
    coalesce((select sum(p.amount) from payment p where p.invoice_oid = i.oid and p.kind = 'refund'), 0)::float8 as refunded
    from invoice i join branch b on b.oid = i.branch_oid`);

const PAYMENT = sql.raw(`p.oid, p.invoice_oid, p.member_oid, p.kind, p.amount::float8 as amount, p.method, p.reference, p.reason, p.received_at,
    coalesce(u.name, '') as received_by, p.received_by as received_by_oid, a.name as approved_by
    from payment p left join app_user u on u.oid = p.received_by left join app_user a on a.oid = p.approved_by`);

export const salesRepo = {
    /** A member's subscriptions visible in the context (sold here, or the member's home is here). */
    subscriptions: (tx: Queryable, memberOid: string) =>
        tx.query<SubscriptionRow>(sql`select ${SUBSCRIPTION} where s.member_oid = ${memberOid} order by s.start_date`),

    subscription: async (tx: Queryable, oid: string, branchOids: readonly string[], forUpdate = false) => {
        const [row] = await tx.query<SubscriptionRow>(sql`
            select ${SUBSCRIPTION} where s.oid = ${oid} and (s.branch_oid = any (${branchOids}::uuid[]) or s.home_branch_oid = any (${branchOids}::uuid[]))
            ${forUpdate ? sql.raw('for update of s') : sql.raw('')}`);
        return row;
    },

    insertSubscription: async (
        tx: Queryable,
        s: Omit<SubscriptionRow, 'oid' | 'freezes' | 'cancelled_at' | 'cancel_reason' | 'upgraded_to' | 'total' | 'paid' | 'due' | 'sessions_used'>,
        actor: string
    ) => {
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into subscription (branch_oid, home_branch_oid, member_oid, plan_oid, plan_name, months, freezable, kind, sessions, start_date, end_date,
                invoice_oid, created_at, created_by)
            values (${s.branch_oid}, ${s.home_branch_oid}, ${s.member_oid}, ${s.plan_oid}, ${s.plan_name}, ${s.months}, ${s.freezable}, ${s.kind}, ${s.sessions},
                ${s.start_date}, ${s.end_date}, ${s.invoice_oid}, ${s.created_at}, ${actor})
            returning oid`);
        if (!row) throw new Error('subscription insert returned no row');
        return row.oid;
    },

    setInvoice: async (tx: Queryable, subscriptionOid: string, invoiceOid: string) => {
        await tx.query(sql`update subscription set invoice_oid = ${invoiceOid} where oid = ${subscriptionOid}`);
    },

    freeze: async (tx: Queryable, oid: string, freeze: Freeze, endDate: string) => {
        await tx.query(sql`update subscription set freezes = freezes || ${JSON.stringify([freeze])}::jsonb, end_date = ${endDate} where oid = ${oid}`);
    },

    end: async (tx: Queryable, oid: string, endDate: string, reason: string, actor: string, at: Date, upgradedTo: string | null = null) => {
        await tx.query(sql`
            update subscription set end_date = ${endDate}, cancelled_at = ${at}, cancel_reason = ${reason}, cancelled_by = ${actor},
                upgraded_to = ${upgradedTo}
            where oid = ${oid}`);
    },

    insertInvoice: async (tx: Queryable, i: Omit<InvoiceRow, 'oid' | 'branch_code' | 'branch_slug' | 'branch_name' | 'paid' | 'refunded'>, actor: string) => {
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into invoice (branch_oid, member_oid, subscription_oid, number, kind, member_code, member_name, member_phone, lines, subtotal,
                discount, discount_label, vat_rate, vat_inclusive, vat_bin, vat, total, issued_at, created_by)
            values (${i.branch_oid}, ${i.member_oid}, ${i.subscription_oid}, ${i.number}, ${i.kind}, ${i.member_code}, ${i.member_name}, ${i.member_phone},
                ${JSON.stringify(i.lines)}::jsonb, ${i.subtotal}, ${i.discount}, ${i.discount_label}, ${i.vat_rate}, ${i.vat_inclusive}, ${i.vat_bin},
                ${i.vat}, ${i.total}, ${i.issued_at}, ${actor})
            returning oid`);
        if (!row) throw new Error('invoice insert returned no row');
        return row.oid;
    },

    invoice: async (tx: Queryable, oid: string, branchOids: readonly string[], forUpdate = false) => {
        const [row] = await tx.query<InvoiceRow>(sql`
            select ${INVOICE} where i.oid = ${oid} and i.branch_oid = any (${branchOids}::uuid[]) ${forUpdate ? sql.raw('for update of i') : sql.raw('')}`);
        return row;
    },

    memberInvoices: (tx: Queryable, memberOid: string, branchOids: readonly string[]) =>
        tx.query<InvoiceRow>(sql`select ${INVOICE} where i.member_oid = ${memberOid} and i.branch_oid = any (${branchOids}::uuid[]) order by i.issued_at desc`),

    payments: (tx: Queryable, invoiceOids: readonly string[]) =>
        invoiceOids.length
            ? tx.query<PaymentRow>(sql`select ${PAYMENT} where p.invoice_oid = any (${invoiceOids}::uuid[]) order by p.received_at`)
            : Promise.resolve([]),

    insertPayment: async (
        tx: Queryable,
        p: {
            branch_oid: string;
            invoice_oid: string;
            member_oid: string | null;
            kind: 'payment' | 'refund';
            amount: number;
            method: PaymentMethod;
            reference: string | null;
            reason: string | null;
            approved_by: string | null;
            received_at: Date;
        },
        actor: string
    ) => {
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into payment (branch_oid, invoice_oid, member_oid, kind, amount, method, reference, reason, approved_by, received_at, received_by)
            values (${p.branch_oid}, ${p.invoice_oid}, ${p.member_oid}, ${p.kind}, ${p.amount}, ${p.method}, ${p.reference}, ${p.reason}, ${p.approved_by}, ${p.received_at}, ${actor})
            returning oid`);
        if (!row) throw new Error('payment insert returned no row');
        return row.oid;
    },

    /** Payments and refunds at the branch, newest first, with the member and invoice. */
    recentPayments: (tx: Queryable, branchOid: string, limit: number) =>
        tx.query<PaymentRow & { invoice_number: string; member_name: string; member_code: string }>(sql`
            select r.*, i.number as invoice_number, i.member_name, i.member_code
            from (select ${PAYMENT} where p.branch_oid = ${branchOid} order by p.received_at desc limit ${limit}) r
            join invoice i on i.oid = r.invoice_oid
            order by r.received_at desc`),

    /** Members of the branch who owe the most. */
    topDues: (tx: Queryable, branchOid: string, limit: number) =>
        tx.query<{ member_oid: string; member_name: string; member_code: string; dues: number }>(sql`
            select i.member_oid, max(i.member_name) as member_name, max(i.member_code) as member_code,
                sum(invoice_due(i.total, x.paid_in, x.refunded))::float8 as dues
            from invoice i cross join lateral (
                select coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as paid_in,
                       coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunded
                from payment p where p.invoice_oid = i.oid) x
            where i.branch_oid = ${branchOid}
            group by i.member_oid
            having sum(invoice_due(i.total, x.paid_in, x.refunded)) > 0
            order by dues desc limit ${limit}`),

    /** A Dhaka day's money at the branch, per method and staff member (refunds count against). */
    dayTakings: (tx: Queryable, branchOid: string, from: Date, to: Date) =>
        tx.query<{ method: PaymentMethod; staff_oid: string | null; staff_name: string | null; count: number; amount: number }>(sql`
            select p.method, p.received_by as staff_oid, max(u.name) as staff_name, count(*)::int as count,
                sum(case when p.kind = 'payment' then p.amount else -p.amount end)::float8 as amount
            from payment p left join app_user u on u.oid = p.received_by
            where p.branch_oid = ${branchOid} and p.received_at >= ${from} and p.received_at < ${to}
            group by p.method, p.received_by`),

    dayInvoices: async (tx: Queryable, branchOid: string, from: Date, to: Date) => {
        const [row] = await tx.query<{ invoices: number; new_members: number; renewals: number; pos_sales: number }>(sql`
            select count(*)::int as invoices,
                count(*) filter (where i.lines @> '[{"label": "Admission fee"}]')::int as new_members,
                count(*) filter (where i.kind <> 'pos' and not i.lines @> '[{"label": "Admission fee"}]')::int as renewals,
                count(*) filter (where i.kind = 'pos')::int as pos_sales
            from invoice i where i.branch_oid = ${branchOid} and i.issued_at >= ${from} and i.issued_at < ${to}`);
        return row ?? { invoices: 0, new_members: 0, renewals: 0, pos_sales: 0 };
    },

    closings: (tx: Queryable, branchOid: string, day: string) =>
        tx.query<{
            oid: string;
            staff_oid: string;
            staff_name: string;
            expected_cash: number;
            counted_cash: number;
            note: string | null;
            created_at: Date;
        }>(sql`
            select c.oid, c.staff_oid, u.name as staff_name, c.expected_cash::float8 as expected_cash, c.counted_cash::float8 as counted_cash, c.note, c.created_at
            from cash_closing c join app_user u on u.oid = c.staff_oid where c.branch_oid = ${branchOid} and c.day = ${day} order by c.created_at`),

    /** Any check-in since a time (refund eligibility: "not used since"). */
    visitedSince: async (tx: Queryable, memberOid: string, since: Date) => {
        const [row] = await tx.query<{ n: number }>(sql`select count(*)::int as n from check_in where member_oid = ${memberOid} and in_at >= ${since}`);
        return (row?.n ?? 0) > 0;
    }
};
