import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { memberPolicies } from '#src/features/policies/policies.service.ts';
import { addDays, dhakaInstant, dhakaNow, shortDate } from '#src/lib/clock.ts';
import { log } from '#src/lib/logger.ts';

/**
 * Messages to members. There is no email or SMS provider, ever:
 * every message is an in-app message, written to the `notification` table and shown in the member portal and on
 * the member's profile, where staff can also pass it on by hand (copy it, or open the phone's SMS app with it).
 * `channel` records how the member could be reached by hand (`email`, `sms`) or `log` when they gave neither;
 * `status` is `logged`, or `skipped` when there is nobody to send it to.
 */
export type NotificationKind =
    | 'receipt'
    | 'expiry_7d'
    | 'expiry_1d'
    | 'welcome'
    | 'class_cancelled'
    | 'waitlist_promoted'
    | 'pt_booked'
    | 'pt_cancelled'
    // The bell.
    | 'complaint_reply'
    | 'sanction'
    | 'appeal_decided'
    | 'policy_to_accept'
    | 'shop_receipt';

/** Read messages older than this are no longer listed; nothing deletes them. */
export const RETENTION_DAYS = 180;

export interface MemberContact {
    oid: string;
    code: string;
    name: string;
    email: string | null;
    phone: string | null;
}

/** The member's name and how staff could reach them by hand, or null when there is no such member (or anonymised). */
export async function memberContact(tx: Queryable, memberOid: string): Promise<MemberContact | null> {
    const [m] = await tx.query<MemberContact>(sql`select oid, code, name, email, phone from member where oid = ${memberOid} and anonymised_at is null`);
    return m ?? null;
}

export interface NotificationInput {
    branch_oid: string;
    member: MemberContact;
    kind: NotificationKind;
    subject: string;
    body: string;
    related_oid: string | null;
    /** One message per key: an expiry reminder is written once per plan, however often the list is read. */
    dedupe_key: string;
    /** When the message counts as sent (reminders: their due day at 00:05 Dhaka); default now. */
    at?: Date | undefined;
}

/** Records (and "delivers") one message in the caller's transaction. Returns false when it was already sent. */
export async function notify(tx: Queryable, n: NotificationInput): Promise<boolean> {
    const channel = n.member.email ? 'email' : n.member.phone ? 'sms' : 'log';
    const recipient = n.member.email ?? n.member.phone;
    const status = recipient ? 'logged' : 'skipped';
    const rows = await tx.query<{ oid: string }>(sql`
        insert into notification (branch_oid, member_oid, kind, channel, recipient, subject, body, status, related_oid, dedupe_key, created_at)
        values (${n.branch_oid}, ${n.member.oid}, ${n.kind}, ${channel}, ${recipient}, ${n.subject}, ${n.body}, ${status}, ${n.related_oid},
            ${n.dedupe_key}, ${n.at ?? new Date()})
        on conflict (dedupe_key) do nothing
        returning oid`);
    if (!rows.length) return false;
    // Never the body or the address in the log: the kind and the member code are enough to find the row.
    log().info({ notification: rows[0]?.oid, kind: n.kind, member: n.member.code, channel, status }, 'In-app message recorded');
    return true;
}

export interface NotificationRow {
    oid: string;
    kind: NotificationKind;
    channel: string;
    subject: string;
    body: string;
    status: string;
    created_at: Date;
    read_at: Date | null;
}

/** Expiry reminders: 7 days and 1 day before a plan ends. */
export const REMINDER_DAYS = [
    { days: 7, kind: 'expiry_7d' },
    { days: 1, kind: 'expiry_1d' }
] as const;

/**
 * Writes the member's expiry reminders that have fallen due by `now` and are not written yet (no nightly
 * job; this runs when the member's messages are read, so the list is the same as if a job had run every night).
 * A reminder is for a plan that is not cancelled (a ban covering the home branch cancels it), whose member is
 * not anonymised, and that was not renewed by then (no later plan that starts after it). A suspension does not stop
 * the plan, so it does not stop the reminders. Each is dated its due day at 00:05 Dhaka. Returns how many were
 * written.
 */
export async function writeDueReminders(tx: Queryable, memberOid: string, now: Date): Promise<number> {
    const today = dhakaNow(now).date;
    const subs = await tx.query<{
        oid: string;
        home_branch_oid: string;
        plan_name: string;
        end_date: string;
        code: string;
        name: string;
        email: string | null;
        phone: string | null;
    }>(sql`
        select s.oid, s.home_branch_oid, s.plan_name, s.end_date::text as end_date, m.code, m.name, m.email, m.phone
        from subscription s join member m on m.oid = s.member_oid
        where s.member_oid = ${memberOid} and s.kind = 'membership' and s.end_date - 7 <= ${today}::date and s.end_date >= ${addDays(today, -400)}::date
          and s.cancelled_at is null and m.anonymised_at is null
          and not exists (select 1 from subscription n where n.member_oid = s.member_oid and n.kind = 'membership' and n.start_date > s.end_date and n.cancelled_at is null)`);
    let written = 0;
    for (const s of subs) {
        for (const r of REMINDER_DAYS) {
            const due = addDays(s.end_date, -r.days);
            if (due > today) continue;
            const sent = await notify(tx, {
                branch_oid: s.home_branch_oid,
                member: { oid: memberOid, code: s.code, name: s.name, email: s.email, phone: s.phone },
                kind: r.kind,
                subject: r.days === 1 ? 'Your membership ends tomorrow' : `Your membership ends in ${r.days} days`,
                body: `Dear ${s.name}, your ${s.plan_name} plan ends on ${shortDate(s.end_date)}. Renew at the front desk to keep training.`,
                related_oid: s.oid,
                dedupe_key: `${r.kind}:${s.oid}`,
                at: dhakaInstant(due, '00:05')
            });
            if (sent) written++;
        }
    }
    return written;
}

/**
 * A message for each required policy the member has still to accept, once per version that needs it.
 * Written when the member's messages are read, like the reminders: publishing a policy writes nothing for hundreds of
 * members at once.
 */
export async function writePolicyReminders(tx: Queryable, memberOid: string, now: Date): Promise<number> {
    const [m] = await tx.query<MemberContact & { joined_on: string; branch_oid: string }>(sql`
        select oid, code, name, email, phone, joined_on::text as joined_on, branch_oid from member where oid = ${memberOid} and anonymised_at is null`);
    if (!m) return 0;
    let written = 0;
    for (const p of await memberPolicies(tx, m, dhakaNow(now).date)) {
        if (p.state !== 'due' && p.state !== 'overdue') continue;
        const sent = await notify(tx, {
            branch_oid: m.branch_oid,
            member: m,
            kind: 'policy_to_accept',
            subject: p.required_version > 1 ? `${p.title} has changed` : `Please accept: ${p.title}`,
            body: `Dear ${m.name}, please read and accept the ${p.title}${p.blocks_on ? ` by ${shortDate(p.blocks_on)}, or check-in pauses from that day` : ''}. It is under Policies in the portal, or ask at the front desk.`,
            related_oid: p.policy_oid,
            dedupe_key: `policy:${p.policy_oid}:v${p.required_version}:${memberOid}`,
            at: now
        });
        if (sent) written++;
    }
    return written;
}

/** Messages still listed: unread ones, and read ones from the last 180 days. */
const listed = (memberOid: string, now: Date) =>
    sql`member_oid = ${memberOid} and (read_at is null or created_at > ${new Date(now.getTime() - RETENTION_DAYS * 86_400_000)})`;

export const notificationsRepo = {
    /** Writes the reminders and policy messages that have fallen due (idempotent). */
    async writeDue(tx: Queryable, memberOid: string, now: Date) {
        await writeDueReminders(tx, memberOid, now);
        await writePolicyReminders(tx, memberOid, now);
    },
    /** The member's messages, newest first, after writing any that have fallen due. */
    async forMember(tx: Queryable, memberOid: string, now: Date, limit = 50) {
        await this.writeDue(tx, memberOid, now);
        return tx.query<NotificationRow>(sql`
            select oid, kind, channel, subject, body, status, created_at, read_at from notification
            where ${listed(memberOid, now)} order by created_at desc limit ${limit}`);
    },
    async unread(tx: Queryable, memberOid: string, now: Date): Promise<number> {
        await this.writeDue(tx, memberOid, now);
        const [row] = await tx.query<{ n: number }>(sql`select count(*)::int as n from notification where member_oid = ${memberOid} and read_at is null`);
        return row?.n ?? 0;
    },
    /** Marks the member's messages read: those named, or all. Returns how many are still unread. */
    async markRead(tx: Queryable, memberOid: string, oids: readonly string[] | undefined, now: Date): Promise<number> {
        await tx.query(sql`
            update notification set read_at = ${now}
            where member_oid = ${memberOid} and read_at is null and (${oids ?? null}::uuid[] is null or oid = any (${oids ?? null}::uuid[]))`);
        const [row] = await tx.query<{ n: number }>(sql`select count(*)::int as n from notification where member_oid = ${memberOid} and read_at is null`);
        return row?.n ?? 0;
    }
};

export const notificationWire = (n: NotificationRow) => ({ ...n, created_at: n.created_at.toISOString(), read_at: n.read_at?.toISOString() ?? null });
