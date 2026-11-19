import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { clock12, dhakaNow, shortDate, taka } from '#src/lib/clock.ts';

export type TimelineKind = 'joined' | 'subscription' | 'payment' | 'freeze' | 'check_in' | 'override' | 'note' | 'status';

export interface TimelineEvent {
    oid: string;
    kind: TimelineKind;
    at: string;
    title: string;
    detail: string | null;
    by: string | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);
const time = (d: Date | string) => dhakaNow(new Date(d)).time;

/**
 * A member's history, newest first (the mock's timeline): joined, plans, freezes, cancels, payments and refunds,
 * overrides, the last 10 visits, suspensions and transfers (from the audit log). A read model: it reads the
 * sales and attendance tables directly, at the branches in context.
 */
export async function memberTimeline(tx: Queryable, member: { oid: string; code: string; joined_on: string }): Promise<TimelineEvent[]> {
    const events: TimelineEvent[] = [
        {
            oid: `${member.oid}-joined`,
            kind: 'joined',
            at: `${member.joined_on}T09:00:00+06:00`,
            title: 'Joined',
            detail: `Member code ${member.code}`,
            by: null
        }
    ];
    const subs = await tx.query<{
        oid: string;
        plan_name: string;
        start_date: string;
        end_date: string;
        freezes: { from: string; to: string; reason: string; at?: string; by_name?: string }[];
        cancelled_at: Date | null;
        cancel_reason: string | null;
        created_at: Date;
        by: string | null;
    }>(sql`
        select s.oid, s.plan_name, s.start_date::text, s.end_date::text, s.freezes, s.cancelled_at, s.cancel_reason, s.created_at, u.name as by
        from subscription s left join app_user u on u.oid = s.created_by where s.member_oid = ${member.oid}`);
    for (const s of subs) {
        events.push({
            oid: `${s.oid}-tl`,
            kind: 'subscription',
            at: iso(s.created_at),
            title: `Subscribed: ${s.plan_name}`,
            detail: `${shortDate(s.start_date)} to ${shortDate(s.end_date)}`,
            by: s.by
        });
        for (const f of s.freezes) {
            events.push({
                oid: `${s.oid}-${f.from}`,
                kind: 'freeze',
                at: f.at ?? `${f.from}T09:00:00+06:00`,
                title: 'Membership frozen',
                detail: `${shortDate(f.from)} to ${shortDate(f.to)}: ${f.reason}`,
                by: f.by_name ?? null
            });
        }
        if (s.cancelled_at)
            events.push({
                oid: `${s.oid}-cancel`,
                kind: 'status',
                at: iso(s.cancelled_at),
                title: `Plan ended early: ${s.plan_name}`,
                detail: s.cancel_reason,
                by: null
            });
    }
    const pays = await tx.query<{
        oid: string;
        kind: string;
        amount: number;
        method: string;
        reference: string | null;
        reason: string | null;
        received_at: Date;
        number: string;
        by: string | null;
    }>(sql`
        select p.oid, p.kind, p.amount::float8 as amount, p.method, p.reference, p.reason, p.received_at, i.number, u.name as by
        from payment p join invoice i on i.oid = p.invoice_oid left join app_user u on u.oid = p.received_by
        where p.member_oid = ${member.oid}`);
    for (const p of pays) {
        const refund = p.kind === 'refund';
        events.push({
            oid: p.oid,
            kind: 'payment',
            at: iso(p.received_at),
            title: `${refund ? 'Refund' : 'Payment'} ${taka(p.amount)} (${p.method})`,
            detail: `${p.number}${p.reference ? ` · ref ${p.reference}` : ''}${refund && p.reason ? ` · ${p.reason}` : ''}`,
            by: p.by
        });
    }
    const visits = await tx.query<{
        oid: string;
        in_at: Date;
        out_at: Date | null;
        override_reason: string | null;
        override_name: string | null;
        by: string | null;
        branch_name: string;
    }>(sql`
        select c.oid, c.in_at, c.out_at, c.override_reason, o.name as override_name, u.name as by, b.name as branch_name
        from check_in c join branch b on b.oid = c.branch_oid left join app_user u on u.oid = c.created_by left join app_user o on o.oid = c.override_by
        where c.member_oid = ${member.oid} order by c.in_at desc`);
    for (const c of visits.filter(v => v.override_reason)) {
        events.push({ oid: `${c.oid}-ov`, kind: 'override', at: iso(c.in_at), title: 'Check-in override', detail: c.override_reason, by: c.override_name });
    }
    for (const c of visits.slice(0, 10)) {
        events.push({
            oid: c.oid,
            kind: 'check_in',
            at: iso(c.in_at),
            title: `Checked in at ${c.branch_name}`,
            detail: c.out_at ? `${clock12(time(c.in_at))} to ${clock12(time(c.out_at))}` : `${clock12(time(c.in_at))}, still inside`,
            by: c.by
        });
    }
    const status = await tx.query<{
        oid: string;
        action: string;
        after: { reason?: string; suspended_reason?: string; to?: { name: string } } | null;
        created_at: Date;
        actor_name: string | null;
    }>(sql`
        select oid, action, after, created_at, actor_name from audit_log
        where entity = 'member' and entity_key = ${member.code} and action in ('suspend', 'unsuspend', 'transfer_out', 'transfer_in')`);
    const titles: Record<string, string> = {
        suspend: 'Suspended',
        unsuspend: 'Suspension lifted',
        transfer_out: 'Moved to another branch',
        transfer_in: 'Joined from another branch'
    };
    for (const a of status) {
        const detail =
            a.action === 'suspend'
                ? (a.after?.suspended_reason ?? null)
                : a.action.startsWith('transfer')
                  ? `${a.after?.to?.name ?? ''}: ${a.after?.reason ?? ''}`
                  : null;
        events.push({ oid: a.oid, kind: 'status', at: iso(a.created_at), title: titles[a.action] ?? a.action, detail, by: a.actor_name });
    }
    return events.sort((a, b) => (Date.parse(a.at) < Date.parse(b.at) ? 1 : -1));
}
