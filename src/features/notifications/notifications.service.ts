import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { addDays, dhakaInstant, dhakaNow, shortDate } from '#src/lib/clock.ts';
import { log } from '#src/lib/logger.ts';

/**
 * Messages to members (phase 2 step 9; D-060, D-070 f, D-075). There is no email or SMS provider, ever (D-075):
 * every message is an in-app message, written to the `notification` table and shown in the member portal and on
 * the member's profile, where staff can also pass it on by hand (copy it, or open the phone's SMS app with it).
 * `channel` records how the member could be reached by hand (`email`, `sms`) or `log` when they gave neither;
 * `status` is `logged`, or `skipped` when there is nobody to send it to.
 */
export type NotificationKind = 'receipt' | 'expiry_7d' | 'expiry_1d' | 'welcome' | 'class_cancelled' | 'waitlist_promoted' | 'pt_booked' | 'pt_cancelled';

export interface NotificationInput {
    branch_oid: string;
    member: { oid: string; code: string; name: string; email: string | null; phone: string | null };
    kind: NotificationKind;
    subject: string;
    body: string;
    related_oid: string | null;
    /** One message per key: an expiry reminder is written once per plan, however often the list is read. */
    dedupe_key: string;
    /** When the message counts as sent (reminders: their due day at 00:05 Dhaka); default now. */
    at?: Date;
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
    log().info({ notification: rows[0]?.oid, kind: n.kind, member: n.member.code, channel, status }, 'In-app message recorded (D-075)');
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
}

/** Expiry reminders: 7 days and 1 day before a plan ends (D-070 f). */
export const REMINDER_DAYS = [
    { days: 7, kind: 'expiry_7d' },
    { days: 1, kind: 'expiry_1d' }
] as const;

/**
 * Writes the member's expiry reminders that have fallen due by `now` and are not written yet (D-075: no nightly
 * job; this runs when the member's messages are read, so the list is the same as if a job had run every night).
 * A reminder is for a plan that is not cancelled (a ban covering the home branch cancels it, D-093), whose member is
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

export const notificationsRepo = {
    /** The member's messages, newest first, after writing any reminder that has fallen due. */
    async forMember(tx: Queryable, memberOid: string, now: Date, limit = 50) {
        await writeDueReminders(tx, memberOid, now);
        return tx.query<NotificationRow>(sql`
            select oid, kind, channel, subject, body, status, created_at from notification
            where member_oid = ${memberOid} order by created_at desc limit ${limit}`);
    }
};
