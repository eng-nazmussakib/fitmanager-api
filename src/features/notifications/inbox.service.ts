import type { Action, AppAbility, Subject } from '#src/auth/ability.ts';
import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';

import { RETENTION_DAYS } from './notifications.service.ts';

/**
 * The staff inbox: a short list of what a branch manager or HQ must act on, behind the console's bell. A
 * message is addressed to a branch (or the HQ row) and seen there by whoever holds the kind's permission, so the
 * list follows the role rules and never role names. Read state is per person; read messages older than 180
 * days are no longer listed (nothing deletes them).
 */
export type StaffMessageKind =
    | 'po_submitted'
    | 'po_approved'
    | 'po_rejected'
    | 'transfer_requested'
    | 'transfer_sent'
    | 'transfer_rejected'
    | 'ticket_urgent'
    | 'complaint_escalated'
    | 'appeal_filed';

/** Who sees each kind: the permission at the branch the message is addressed to. */
export const INBOX_RULES: Record<StaffMessageKind, [Action, Subject]> = {
    po_submitted: ['update', 'PurchaseOrder'],
    po_approved: ['update', 'PurchaseOrder'],
    po_rejected: ['update', 'PurchaseOrder'],
    transfer_requested: ['update', 'Transfer'],
    transfer_sent: ['update', 'Transfer'],
    transfer_rejected: ['update', 'Transfer'],
    ticket_urgent: ['update', 'Equipment'],
    complaint_escalated: ['manage', 'Complaint'],
    appeal_filed: ['manage', 'Incident']
};

export const kindsFor = (ability: AppAbility): StaffMessageKind[] =>
    (Object.keys(INBOX_RULES) as StaffMessageKind[]).filter(k => ability.can(...INBOX_RULES[k]));

export interface StaffMessageInput {
    /** The inbox: a branch, or the HQ row. */
    to_branch_oid: string;
    kind: StaffMessageKind;
    subject: string;
    body: string;
    /** The console page, relative to /console/:branch or /hq (`stock?tab=orders`, `incidents/<oid>`). */
    link: string;
    related_oid: string | null;
    dedupe_key: string;
    at?: Date | undefined;
}

/** Writes one inbox message in the caller's transaction (from the caller's branch). Once per `dedupe_key`. */
export async function tellStaff(tx: Queryable, ctx: BranchContext, m: StaffMessageInput): Promise<void> {
    await tx.query(sql`
        insert into staff_message (branch_oid, from_branch_oid, kind, subject, body, link, related_oid, dedupe_key, created_at)
        values (${m.to_branch_oid}, ${ctx.branchOid}, ${m.kind}, ${m.subject}, ${m.body}, ${m.link}, ${m.related_oid}, ${m.dedupe_key}, ${m.at ?? new Date()})
        on conflict (dedupe_key) do nothing`);
}

/** The HQ row (an HQ inbox message is addressed to it). */
export async function hqOid(tx: Queryable): Promise<string> {
    const [row] = await tx.query<{ oid: string }>(sql`select oid from branch where kind = 'HQ' limit 1`);
    if (!row) throw new Error('No HQ branch');
    return row.oid;
}

interface InboxRow {
    oid: string;
    kind: StaffMessageKind;
    subject: string;
    body: string;
    link: string;
    from_branch_oid: string;
    from_branch_name: string;
    created_at: Date;
    read_at: Date | null;
}

/** `GET /v1/inbox`: the caller's inbox at the active branch (or HQ), newest first, and how many are unread. */
export async function inbox(db: Db, ctx: BranchContext, userOid: string, kinds: readonly string[], now: Date, limit = 50) {
    if (!kinds.length) return { items: [], unread: 0 };
    return withBranchTx(db, ctx, async tx => {
        const rows = await tx.query<InboxRow>(sql`
            select m.oid, m.kind, m.subject, m.body, m.link, m.from_branch_oid, b.name as from_branch_name, m.created_at, r.read_at
            from staff_message m
            join branch b on b.oid = m.from_branch_oid
            left join staff_message_read r on r.message_oid = m.oid and r.user_oid = ${userOid}
            where m.branch_oid = ${ctx.branchOid} and m.kind = any (${kinds}::text[])
              and (r.read_at is null or m.created_at > ${new Date(now.getTime() - RETENTION_DAYS * 86_400_000)})
            order by m.created_at desc limit ${limit}`);
        return {
            items: rows.map(r => ({ ...r, created_at: r.created_at.toISOString(), read_at: r.read_at?.toISOString() ?? null })),
            unread: await unreadIn(tx, ctx, userOid, kinds)
        };
    });
}

async function unreadIn(tx: Queryable, ctx: BranchContext, userOid: string, kinds: readonly string[]): Promise<number> {
    const [row] = await tx.query<{ n: number }>(sql`
        select count(*)::int as n from staff_message m
        where m.branch_oid = ${ctx.branchOid} and m.kind = any (${kinds}::text[])
          and not exists (select 1 from staff_message_read r where r.message_oid = m.oid and r.user_oid = ${userOid})`);
    return row?.n ?? 0;
}

/** `GET /v1/inbox/count`: the bell's number. */
export async function inboxCount(db: Db, ctx: BranchContext, userOid: string, kinds: readonly string[]): Promise<number> {
    if (!kinds.length) return 0;
    return withBranchTx(db, ctx, tx => unreadIn(tx, ctx, userOid, kinds));
}

/** `POST /v1/inbox/read`: marks the caller's messages read (those named, or all they see here). Returns the unread count. */
export async function markInboxRead(db: Db, ctx: BranchContext, userOid: string, kinds: readonly string[], oids: readonly string[] | undefined, now: Date) {
    if (!kinds.length) return 0;
    return withBranchTx(db, ctx, async tx => {
        await tx.query(sql`
            insert into staff_message_read (message_oid, user_oid, branch_oid, read_at)
            select m.oid, ${userOid}, m.branch_oid, ${now} from staff_message m
            where m.branch_oid = ${ctx.branchOid} and m.kind = any (${kinds}::text[])
              and (${oids ?? null}::uuid[] is null or m.oid = any (${oids ?? null}::uuid[]))
            on conflict do nothing`);
        return unreadIn(tx, ctx, userOid, kinds);
    });
}
