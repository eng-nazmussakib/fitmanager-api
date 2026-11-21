import type { Db, Queryable } from '#src/db/db.ts';
import { pgErrorCode, sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimFile, memberFiles, viewUrl } from '#src/features/files/files.service.ts';
import { acceptPolicies } from '#src/features/policies/policies.service.ts';
import type { FileStore } from '#src/lib/file-store.ts';
import { AppError } from '#src/lib/http.ts';

import { type ListQuery, type MemberRow, membersRepo, type MemberStatus } from './members.repo.ts';
import type { MemberCreate, MemberUpdate } from './members.schema.ts';

/**
 * Members (phase 2 step 3; D-022, D-059, D-068). A member belongs to one home branch (the request's branch for
 * every action here); other branches never read the record. Every change is audited at the branch, keyed by the
 * member code.
 */
export interface MemberDeps {
    db: Db;
    files: FileStore;
    jwtSecret: string;
    apiPrefix: string;
}

export const ANONYMISED_NAME = 'Anonymised member';

/** The wire shape (`Member` in the web app): snake_case, the photo as a signed link. */
export async function toWire(deps: Pick<MemberDeps, 'jwtSecret' | 'apiPrefix'>, m: MemberRow) {
    const { branch_code, branch_slug, branch_name, photo_file_oid, sanction_level, sanction_reason, sanction_until, sanction_branch, ...rest } = m;
    return {
        ...rest,
        photo_file_oid,
        photo_url: photo_file_oid ? await viewUrl(deps, { oid: photo_file_oid, branch_oid: m.branch_oid }) : null,
        branch: { oid: m.branch_oid, code: branch_code, slug: branch_slug, name: branch_name, kind: 'BRANCH' as const },
        // What makes the member Suspended or Banned (D-093): the record is on the discipline tab.
        sanction: sanction_level ? { level: sanction_level, reason: sanction_reason ?? '', until: sanction_until, branch_name: sanction_branch ?? '' } : null
    };
}

/** A list row (`MemberListItem`). */
export async function toListItem(deps: Pick<MemberDeps, 'jwtSecret' | 'apiPrefix'>, m: MemberRow) {
    return {
        oid: m.oid,
        code: m.code,
        name: m.name,
        phone: m.phone,
        gender: m.gender,
        photo_url: m.photo_file_oid ? await viewUrl(deps, { oid: m.photo_file_oid, branch_oid: m.branch_oid }) : null,
        status: m.status,
        plan_name: m.plan_name,
        valid_until: m.valid_until,
        days_left: m.days_left,
        dues: m.dues,
        last_visit: m.last_visit,
        joined_on: m.joined_on
    };
}

function actorOf(ctx: BranchContext): string {
    if (!ctx.actor) throw new AppError(401, 'Please sign in');
    return ctx.actor.oid;
}

function phoneTaken(err: unknown): never {
    if (pgErrorCode(err) === '23505') {
        throw new AppError(409, 'This mobile number already belongs to a member (at this or another branch).', [
            { path: 'phone', message: 'Already a member' }
        ]);
    }
    throw err;
}

/** The member at the request's branch, or 404: another branch's member looks like one that does not exist. */
export async function memberAt(tx: Queryable, ctx: BranchContext, oid: string, today: string): Promise<MemberRow> {
    const m = await membersRepo.get(tx, oid, [ctx.branchOid], today);
    if (!m) throw new AppError(404, 'Member not found');
    return m;
}

export async function listMembers(deps: MemberDeps, ctx: BranchContext, today: string, q: ListQuery) {
    const { rows, count, counts } = await withBranchTx(deps.db, ctx, tx => membersRepo.list(tx, ctx.branchOid, today, q));
    const byStatus: Partial<Record<MemberStatus, number>> = {};
    for (const c of counts) byStatus[c.status] = c.n;
    return { rows: await Promise.all(rows.map(r => toListItem(deps, r))), count, page: q.page, size: q.size, counts: byStatus };
}

export async function lookupMember(deps: MemberDeps, ctx: BranchContext, today: string, code: string) {
    const m = await withBranchTx(deps.db, ctx, tx => membersRepo.byCode(tx, code, ctx.branchOid, today));
    if (!m) throw new AppError(404, `No member with code ${code} at this branch`);
    return toListItem(deps, m);
}

export async function memberDetail(deps: MemberDeps, ctx: BranchContext, oid: string, today: string) {
    return toWire(deps, await withBranchTx(deps.db, ctx, tx => memberAt(tx, ctx, oid, today)));
}

export async function createMember(
    deps: MemberDeps,
    ctx: BranchContext,
    today: string,
    input: Omit<MemberCreate, 'gender'> & { gender: MemberCreate['gender'] | null },
    source: 'desk' | 'web' = 'desk'
) {
    const actor = source === 'web' ? null : actorOf(ctx);
    const row = await withBranchTx(deps.db, ctx, async tx => {
        const [branch] = await tx.query<{ code: string; kind: string }>(sql`select code, kind from branch where oid = ${ctx.branchOid}`);
        if (branch?.kind !== 'BRANCH') throw new AppError(400, 'Members join a branch, not HQ');
        const seq = await membersRepo.nextNumber(tx, ctx.branchOid, 'member');
        const code = `MEM-${branch.code}-${String(seq).padStart(6, '0')}`;
        const oid = await membersRepo
            .insert(tx, {
                branch_oid: ctx.branchOid,
                code,
                name: input.name,
                phone: input.phone,
                gender: input.gender,
                email: input.email ?? null,
                date_of_birth: input.date_of_birth ?? null,
                address: input.address ?? null,
                emergency_contact: input.emergency_contact ?? null,
                health_flags: input.health_flags,
                health_declared: input.health_declared,
                notes: input.notes ?? null,
                joined_on: today,
                // No subscription yet: the membership starts with the first sale (D-022).
                pending: true,
                source,
                created_by: actor,
                updated_by: actor
            })
            .catch(phoneTaken);
        if (input.photo_file_oid) {
            await claimFile(tx, ctx.branchOid, input.photo_file_oid, oid, 'member_photo');
            await membersRepo.update(tx, oid, { photo_file_oid: input.photo_file_oid }, actor ?? oid);
        }
        const created = await memberAt(tx, ctx, oid, today);
        await recordAudit(tx, ctx, { action: 'create', entity: 'member', entityKey: code, before: null, after: auditView(created) });
        if (input.policies_signed && source === 'desk') await acceptPolicies(tx, ctx, { oid, code, joined_on: today }, 'paper', today);
        return created;
    });
    return toWire(deps, row);
}

/** What the audit log keeps of a member: the record, not the derived state that changes by itself every day. */
function auditView(m: MemberRow) {
    const {
        status: _s,
        plan_name: _p,
        valid_until: _v,
        days_left: _d,
        dues: _du,
        last_visit: _l,
        current_subscription_oid: _c,
        frozen_until: _f,
        sanction_level: _sl,
        sanction_reason: _sr,
        sanction_until: _su,
        sanction_branch: _sb,
        ...rest
    } = m;
    return rest;
}

export async function updateMember(deps: MemberDeps, ctx: BranchContext, oid: string, today: string, input: MemberUpdate) {
    const actor = actorOf(ctx);
    const row = await withBranchTx(deps.db, ctx, async tx => {
        const locked = await membersRepo.lock(tx, oid, ctx.branchOid);
        if (!locked) throw new AppError(404, 'Member not found');
        if (locked.anonymised) throw new AppError(409, 'This member was anonymised: the record cannot be changed');
        const before = await memberAt(tx, ctx, oid, today);
        if (input.photo_file_oid) await claimFile(tx, ctx.branchOid, input.photo_file_oid, oid, 'member_photo');
        await membersRepo.update(tx, oid, { ...input }, actor).catch(phoneTaken);
        const after = await memberAt(tx, ctx, oid, today);
        await recordAudit(tx, ctx, { action: 'update', entity: 'member', entityKey: after.code, before: auditView(before), after: auditView(after) });
        return after;
    });
    return toWire(deps, row);
}

/** The first sale turns a join request into a member (called by sales in the same transaction). */
export async function activateMember(tx: Queryable, oid: string, actor: string): Promise<void> {
    await tx.query(sql`update member set pending = false, updated_by = ${actor}, updated_at = now() where oid = ${oid} and pending`);
}

/**
 * Moves the home branch (D-068 d): HQ or the home branch's manager, only with zero dues. A running plan carries
 * on (its subscription's home branch moves; the money stays with the branch that sold it), the photo and
 * documents follow, and the history stays where it was made. Audited at both branches.
 */
export async function transferMember(deps: MemberDeps, ctx: BranchContext, oid: string, today: string, toBranchOid: string, reason: string) {
    const actor = actorOf(ctx);
    if (toBranchOid === ctx.branchOid) throw new AppError(400, 'The member is already at this branch', [{ path: 'to_branch_oid', message: 'Same branch' }]);
    const [target] = await deps.db.query<{ oid: string; name: string; kind: string; status: string }>(
        sql`select oid, name, kind, status from branch where oid = ${toBranchOid}`
    );
    if (target?.kind !== 'BRANCH' || target.status !== 'Active')
        throw new AppError(400, 'Choose an open branch', [{ path: 'to_branch_oid', message: 'Not a branch' }]);
    // Both ends in context: the row moves out of this branch into the other.
    const both: BranchContext = { ...systemContext(ctx.branchOid, [ctx.branchOid, toBranchOid]), actor: ctx.actor, requestId: ctx.requestId };
    const moved = await withBranchTx(deps.db, both, async tx => {
        const locked = await membersRepo.lock(tx, oid, ctx.branchOid);
        if (!locked) throw new AppError(404, 'Member not found');
        if (locked.anonymised) throw new AppError(409, 'This member was anonymised');
        const before = await memberAt(tx, ctx, oid, today);
        if (before.dues > 0) throw new AppError(409, `Clear the dues of ৳${before.dues.toLocaleString('en-IN')} before the transfer.`);
        const [open] = await tx.query<{ n: number }>(sql`select count(*)::int as n from check_in where member_oid = ${oid} and out_at is null`);
        if (open?.n) throw new AppError(409, 'Check the member out first');
        await tx.query(sql`
            insert into member_transfer (member_oid, from_branch_oid, to_branch_oid, reason, created_by)
            values (${oid}, ${ctx.branchOid}, ${toBranchOid}, ${reason}, ${actor})`);
        await membersRepo.update(tx, oid, { branch_oid: toBranchOid }, actor);
        await tx.query(sql`update subscription set home_branch_oid = ${toBranchOid} where member_oid = ${oid}`);
        await memberFiles.move(tx, oid, toBranchOid);
        // Training history goes with them (D-089); the running routine ends here, as its exercises may be this branch's.
        await tx.query(sql`update routine set ended_on = greatest(${today}::date, started_on) where member_oid = ${oid} and ended_on is null`);
        for (const table of ['routine', 'workout', 'workout_set', 'measurement'] as const) {
            await tx.query(sql`update ${sql.raw(table)} set branch_oid = ${toBranchOid} where member_oid = ${oid}`);
        }
        const change = { from: { oid: ctx.branchOid, name: before.branch_name }, to: { oid: toBranchOid, name: target.name }, reason };
        await recordAudit(tx, ctx, { action: 'transfer_out', entity: 'member', entityKey: before.code, before: { branch_oid: ctx.branchOid }, after: change });
        await recordAudit(
            tx,
            { ...ctx, branchOid: toBranchOid },
            { action: 'transfer_in', entity: 'member', entityKey: before.code, before: { branch_oid: ctx.branchOid }, after: change }
        );
        return { code: before.code, to: target.name };
    });
    return { oid, code: moved.code, branch_oid: toBranchOid, branch_name: moved.to };
}

/**
 * "Delete my data" (D-068 c): wipes the personal fields, the photo and documents, the name and phone copied onto
 * invoices and check-ins, and closes the portal account. Invoices, payments and check-ins stay under the code.
 */
export async function anonymiseMember(deps: MemberDeps, ctx: BranchContext, oid: string, today: string, confirmCode: string) {
    const actor = actorOf(ctx);
    // The copies live at every branch the member visited or bought at: a context of all branches, for this one
    // member (every statement below names the member; the lock names the home branch).
    const every = (await deps.db.query<{ oid: string }>(sql`select oid from branch`)).map(r => r.oid);
    const wide: BranchContext = { ...ctx, branchOids: every };
    const keys = await withBranchTx(deps.db, wide, async tx => {
        const locked = await membersRepo.lock(tx, oid, ctx.branchOid);
        if (!locked) throw new AppError(404, 'Member not found');
        if (locked.anonymised) throw new AppError(409, 'Already anonymised');
        if (confirmCode !== locked.code)
            throw new AppError(400, `Type the member code ${locked.code} to confirm`, [{ path: 'confirm_code', message: 'Does not match' }]);
        const before = await memberAt(tx, ctx, oid, today);
        // Training data is personal (D-089): deleted, not kept under the code. The photos go with the files below.
        await tx.query(sql`delete from measurement where member_oid = ${oid}`);
        await tx.query(sql`delete from workout where member_oid = ${oid}`);
        await tx.query(sql`delete from routine where member_oid = ${oid}`);
        await tx.query(sql`update member set height_cm = null where oid = ${oid}`);
        const storageKeys = await memberFiles.deleteAll(tx, oid, actor);
        await membersRepo.update(
            tx,
            oid,
            {
                name: ANONYMISED_NAME,
                phone: null,
                email: null,
                date_of_birth: null,
                address: null,
                emergency_contact: null,
                health_flags: [],
                health_declared: false,
                photo_file_oid: null,
                notes: null,
                anonymised_at: new Date()
            },
            actor
        );
        await tx.query(sql`update invoice set member_name = ${ANONYMISED_NAME}, member_phone = null where member_oid = ${oid}`);
        await tx.query(sql`update check_in set member_name = ${ANONYMISED_NAME}, member_photo_file_oid = null where member_oid = ${oid}`);
        await tx.query(sql`update notification set recipient = null where member_oid = ${oid}`);
        // Governance copies (phase 5): the cases, complaints and ratings stay, under the code, without the name.
        await tx.query(sql`update incident set subject_name = ${ANONYMISED_NAME} where member_oid = ${oid}`);
        await tx.query(sql`update complaint set member_name = ${ANONYMISED_NAME}, photo_file_oid = null where member_oid = ${oid}`);
        await tx.query(sql`update rating set member_name = ${ANONYMISED_NAME} where member_oid = ${oid}`);
        await tx.query(sql`update appeal set filed_by_name = ${ANONYMISED_NAME} where sanction_oid in (select oid from sanction where member_oid = ${oid})`);
        await tx.query(sql`update app_user set status = 'Inactive', updated_at = now() where member_oid = ${oid}`);
        // The audit row keeps only that it happened: copying the wiped data here would undo the request.
        await recordAudit(tx, ctx, {
            action: 'anonymise',
            entity: 'member',
            entityKey: before.code,
            before: { status: before.status },
            after: { anonymised: true }
        });
        return storageKeys;
    });
    for (const key of keys) await deps.files.delete(key).catch(() => undefined);
    return { oid, anonymised: true };
}
