import { refreshTokens } from '#src/auth/auth.repo.ts';
import { forgetUser } from '#src/auth/middleware.ts';
import { hashPassword } from '#src/auth/password.ts';
import type { AppDeps } from '#src/container.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { memberAttendance } from '#src/features/attendance/attendance.service.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { livePhoto } from '#src/features/files/files.repo.ts';
import { viewUrl } from '#src/features/files/files.service.ts';
import { memberAt, toWire } from '#src/features/members/members.service.ts';
import { notificationsRepo, notificationWire } from '#src/features/notifications/notifications.service.ts';
import { salesRepo } from '#src/features/sales/sales.repo.ts';
import { invoiceWire, subscriptionWire } from '#src/features/sales/sales.service.ts';
import { nextBooking } from '#src/features/scheduling/classes.service.ts';
import { addDays, daysBetween, dhakaInstant, type DhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

/**
 * The member portal: status, plan, dues, invoices and receipts, visits,
 * messages. A member's account is an `app_user` of kind 'member' whose username is the member code; the desk
 * sets a temporary password and the member must change it at the first sign-in (the staff flow).
 * Every portal read runs in the member's HOME branch context, taken from the account, never from a header.
 */

type Deps = Pick<AppDeps, 'db' | 'cache' | 'config'>;

/** The desk gives (or resets) portal access with a temporary password. Every session of the account ends. */
export async function grantPortalAccess(deps: Deps, ctx: BranchContext, memberOid: string, today: string, password: string) {
    const hash = await hashPassword(password, deps.config.auth.passwordHash);
    const result = await withBranchTx(deps.db, ctx, async tx => {
        const m = await memberAt(tx, ctx, memberOid, today);
        if (m.anonymised) throw new AppError(409, 'This member was anonymised');
        if (m.status === 'Pending') throw new AppError(409, 'The membership starts with the first sale; give portal access after it.');
        const [existing] = await tx.query<{ oid: string; username: string }>(sql`select oid, username from app_user where member_oid = ${memberOid}`);
        let userOid: string;
        if (existing) {
            await tx.query(sql`
                update app_user set password_hash = ${hash}, must_change_password = true, status = 'Active', name = ${m.name}, updated_at = now()
                where oid = ${existing.oid}`);
            await refreshTokens.revokeAll(tx, existing.oid);
            userOid = existing.oid;
        } else {
            const [row] = await tx.query<{ oid: string }>(sql`
                insert into app_user (username, password_hash, name, email, kind, member_oid, must_change_password)
                values (${m.code}, ${hash}, ${m.name}, ${m.email}, 'member', ${memberOid}, true) returning oid`);
            if (!row) throw new Error('app_user insert returned no row');
            userOid = row.oid;
        }
        await recordAudit(tx, ctx, {
            action: existing ? 'reset_portal_password' : 'grant_portal',
            entity: 'member',
            entityKey: m.code,
            before: null,
            after: { username: m.code, must_change_password: true }
        });
        return { oid: userOid, username: m.code, reset: Boolean(existing) };
    });
    await forgetUser(deps.cache, { oid: result.oid });
    return { username: result.username, must_change_password: true, reset: result.reset };
}

/** The signed-in member's context: their home branch, from the account (an anonymised member gets nothing). */
export async function memberContext(
    deps: Deps,
    user: { oid: string; name: string; member_oid: string | null }
): Promise<{ ctx: BranchContext; memberOid: string }> {
    if (!user.member_oid) throw new AppError(403, 'Members only');
    const memberOid = user.member_oid;
    const home = await deps.db.transaction(async tx => {
        const [row] = await tx.query<{ home: string | null }>(sql`select member_home_branch(${memberOid}::uuid) as home`);
        return row?.home ?? null;
    });
    if (!home) throw new AppError(404, 'Member not found');
    return { ctx: { ...systemContext(home), actor: { oid: user.oid, name: user.name } }, memberOid };
}

/** Consecutive days with a visit, ending today or yesterday. */
function streak(days: Set<string>, today: string): number {
    let n = 0;
    let day = days.has(today) ? today : addDays(today, -1);
    while (days.has(day)) {
        n++;
        day = addDays(day, -1);
    }
    return n;
}

type PortalDeps = Deps & { jwtSecret: string; apiPrefix: string; files: AppDeps['files'] };

/** `GET /v1/me/summary`: the portal home (the mock's PortalSummary, without class bookings). */
export async function summary(deps: PortalDeps, user: { oid: string; name: string; member_oid: string | null }, now: DhakaNow) {
    const { ctx, memberOid } = await memberContext(deps, user);
    return withBranchTx(deps.db, ctx, async tx => {
        const m = await memberAt(tx, ctx, memberOid, now.date);
        // The membership only: a PT package is shown on the PT page.
        const subs = (await salesRepo.subscriptions(tx, memberOid)).filter(s => s.kind === 'membership');
        const current = subs.find(s => s.oid === m.current_subscription_oid) ?? null;
        const relevant =
            current ?? subs.find(s => s.start_date > now.date && s.start_date <= s.end_date) ?? subs.filter(s => s.start_date <= s.end_date).at(-1) ?? null;
        const visits = await tx.query<{ day: string }>(sql`
            select distinct to_char(in_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD') as day from check_in
            where member_oid = ${memberOid} and in_at >= ${dhakaInstant(addDays(now.date, -400))}`);
        const days = new Set(visits.map(v => v.day));
        const monthStart = `${now.date.slice(0, 8)}01`;
        const [month] = await tx.query<{ n: number }>(
            sql`select count(*)::int as n from check_in where member_oid = ${memberOid} and in_at >= ${dhakaInstant(monthStart)}`
        );
        const wire = await toWire(deps, m);
        return {
            member: { oid: m.oid, code: m.code, name: m.name, photo_url: wire.photo_url, branch_name: m.branch_name, status: m.status },
            subscription: relevant ? subscriptionWire(relevant, now.date) : null,
            days_left: m.days_left,
            days_total: relevant ? daysBetween(relevant.start_date, relevant.end_date) + 1 : null,
            dues: m.dues,
            next_booking: await nextBooking(tx, memberOid, now.at),
            streak_days: streak(days, now.date),
            visits_this_month: month?.n ?? 0
        };
    });
}

/** `GET /v1/me/payments`: the member's invoices and receipts, newest first (all branches that sold to them). */
export async function invoices(deps: PortalDeps, user: { oid: string; name: string; member_oid: string | null }, now: DhakaNow) {
    const { ctx, memberOid } = await memberContext(deps, user);
    // A member who moved home keeps their older receipts: every branch, this member only.
    const every = (await deps.db.query<{ oid: string }>(sql`select oid from branch`)).map(r => r.oid);
    const wide: BranchContext = { ...ctx, branchOids: every };
    return withBranchTx(deps.db, wide, async tx => {
        await memberAt(tx, ctx, memberOid, now.date);
        const list = await salesRepo.memberInvoices(tx, memberOid, every);
        const pays = await salesRepo.payments(
            tx,
            list.map(i => i.oid)
        );
        return list.map(i => invoiceWire(i, pays));
    });
}

export async function attendance(deps: PortalDeps, user: { oid: string; name: string; member_oid: string | null }, now: DhakaNow) {
    const { ctx, memberOid } = await memberContext(deps, user);
    return memberAttendance({ db: deps.db, jwtSecret: deps.jwtSecret, apiPrefix: deps.apiPrefix }, ctx, now, memberOid, 84);
}

/**
 * The member's context for their own messages: the home branch, reading every branch, because a message is written
 * where it happened (a class cancelled at another branch). Every query filters on the member's own oid.
 */
export async function memberEverywhere(deps: Deps, user: { oid: string; name: string; member_oid: string | null }) {
    const { ctx, memberOid } = await memberContext(deps, user);
    const all = await deps.db.query<{ oid: string }>(sql`select oid from branch`);
    return { ctx: { ...ctx, branchOids: [ctx.branchOid, ...all.map(b => b.oid).filter(b => b !== ctx.branchOid)] }, memberOid };
}

/** `GET /v1/me/notifications`: the member's in-app messages, with their read state. */
export async function notifications(deps: PortalDeps, user: { oid: string; name: string; member_oid: string | null }, now: DhakaNow) {
    const { ctx, memberOid } = await memberEverywhere(deps, user);
    return withBranchTx(deps.db, ctx, async tx => {
        await memberAt(tx, ctx, memberOid, now.date);
        return (await notificationsRepo.forMember(tx, memberOid, now.at)).map(notificationWire);
    });
}

/** `/auth/me` for a member: their code and home branch (null for staff, or a member whose record is gone). */
export async function portalIdentity(deps: PortalDeps, user: { oid: string; name: string; member_oid: string | null }) {
    if (!user.member_oid) return null;
    const { ctx, memberOid } = await memberContext(deps, user).catch(() => ({ ctx: null, memberOid: '' }));
    if (!ctx) return null;
    return withBranchTx(deps.db, ctx, async tx => {
        const [m] = await tx.query<{ code: string; photo_file_oid: string | null; branch_oid: string; b_code: string; slug: string; b_name: string }>(sql`
            select m.code, ${livePhoto('m.photo_file_oid')} as photo_file_oid, m.branch_oid, b.code as b_code, b.slug, b.name as b_name
            from member m join branch b on b.oid = m.branch_oid where m.oid = ${memberOid} and m.branch_oid = ${ctx.branchOid}`);
        if (!m) return null;
        const photo = m.photo_file_oid ? await viewUrl(deps, { oid: m.photo_file_oid, branch_oid: m.branch_oid }) : null;
        return {
            oid: memberOid,
            code: m.code,
            branch: { oid: m.branch_oid, code: m.b_code, slug: m.slug, name: m.b_name, kind: 'BRANCH' as const },
            photo_url: photo
        };
    });
}
