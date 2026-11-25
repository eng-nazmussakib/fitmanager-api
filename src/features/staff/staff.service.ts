import type { Request } from 'express';

import type { StaffRole } from '#src/auth/auth.repo.ts';
import { refreshTokens } from '#src/auth/auth.repo.ts';
import { currentUser, forgetUser } from '#src/auth/middleware.ts';
import { hashPassword } from '#src/auth/password.ts';
import type { AppDeps } from '#src/container.ts';
import type { Queryable } from '#src/db/db.ts';
import { type BranchContext, branchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { AppError } from '#src/lib/http.ts';

import { type Actor, fitsBranch, mayAssign, mayManage, type Placement } from './staff.policy.ts';
import { type StaffMember, staffRepo } from './staff.repo.ts';

/**
 * Staff management, shared by the HQ routes and the branch routes. Every change runs in
 * one `withBranchTx` with its audit row (entity `staff`, the account's oid; never a password hash). The account
 * tables are not branch-scoped, so the scope comes from the policy (`staff.policy.ts`), checked against the row
 * read FOR UPDATE inside the same transaction.
 */
export interface StaffScope {
    actor: Actor;
    ctx: BranchContext;
    /** Branch routes see only the people assigned at their branch; HQ sees everyone. */
    onlyHere: boolean;
}

export function scopeOf(req: Request, onlyHere: boolean): StaffScope {
    const a = req.auth?.assignment;
    if (!a) throw new AppError(403, 'Choose a branch first');
    return { actor: { oid: currentUser(req).oid, role: a.role, branch: { oid: a.branch.oid, kind: a.branch.kind } }, ctx: branchContext(req), onlyHere };
}

const assignedHere = (s: StaffScope, m: StaffMember) => m.assignments.some(a => a.branch_oid === s.actor.branch.oid);

/** The person, if this scope may see them; 404 otherwise (a branch does not learn who works elsewhere). */
function visible(s: StaffScope, m: StaffMember | undefined): StaffMember {
    if (!m || (s.onlyHere && !assignedHere(s, m))) throw new AppError(404, 'No such staff member');
    return m;
}

export const canManage = (s: StaffScope, m: StaffMember) => mayManage(s.actor, m);

/** Locks and returns a person the actor may change. `self`: whether the actor may do this to their own account. */
async function manageable(tx: Queryable, s: StaffScope, oid: string, self: boolean): Promise<StaffMember> {
    const m = visible(s, await staffRepo.get(tx, oid, { lock: true }));
    if (!self && m.oid === s.actor.oid) throw new AppError(403, 'You cannot do this to your own account');
    if (!mayManage(s.actor, m)) throw new AppError(403, 'You may not manage this staff member');
    return m;
}

/** Checks a full assignment set against the policy and the branches' kinds. */
async function checkAssignments(tx: Queryable, s: StaffScope, list: readonly { branch_oid: string; role: StaffRole }[], allBranches: boolean): Promise<void> {
    const kinds = await staffRepo.branchKinds(
        tx,
        list.map(a => a.branch_oid)
    );
    for (const [i, a] of list.entries()) {
        const kind = kinds.get(a.branch_oid);
        const path = `assignments.${i}`;
        if (!kind) throw new AppError(400, 'Unknown branch', [{ path: `${path}.branch_oid`, message: 'Unknown branch' }]);
        const p: Placement = { branch_oid: a.branch_oid, branch_kind: kind, role: a.role };
        if (!fitsBranch(a.role, kind))
            throw new AppError(400, kind === 'HQ' ? 'HQ takes an HQ role (OWNER or HQ_ADMIN)' : 'A branch takes a branch role', [
                { path: `${path}.role`, message: 'Role does not fit this branch' }
            ]);
        if (!mayAssign(s.actor, p)) throw new AppError(403, `You may not assign ${a.role} there`, [{ path: `${path}.role`, message: 'Not allowed' }]);
    }
    if (allBranches) {
        if (!(s.actor.branch.kind === 'HQ' && s.actor.role === 'OWNER')) throw new AppError(403, 'Only an owner gives access to every branch');
        if (!list.some(a => kinds.get(a.branch_oid) === 'HQ'))
            throw new AppError(400, 'Every-branch access needs an HQ assignment', [{ path: 'all_branches', message: 'Needs an HQ assignment' }]);
    }
}

async function reload(tx: Queryable, oid: string): Promise<StaffMember> {
    const m = await staffRepo.get(tx, oid);
    if (!m) throw new Error(`staff ${oid} vanished inside its own transaction`);
    return m;
}

export function staffService(deps: Pick<AppDeps, 'db' | 'cache' | 'config'>) {
    const { db, cache, config } = deps;
    const audit = (tx: Queryable, s: StaffScope, action: string, oid: string, before?: StaffMember, after?: unknown) =>
        recordAudit(tx, s.ctx, { action, entity: 'staff', entityKey: oid, before, after });

    return {
        async list(s: StaffScope, filter: Parameters<typeof staffRepo.list>[1]) {
            const rows = await staffRepo.list(db, s.onlyHere ? { ...filter, branch_oid: s.actor.branch.oid } : filter);
            return rows.map(m => ({ ...m, manageable: m.oid !== s.actor.oid && canManage(s, m) }));
        },

        async get(s: StaffScope, oid: string) {
            const m = visible(s, await staffRepo.get(db, oid));
            return { ...m, manageable: m.oid !== s.actor.oid && canManage(s, m) };
        },

        async create(
            s: StaffScope,
            input: {
                username: string;
                name: string;
                email: string | null;
                password: string;
                assignments: { branch_oid: string; role: StaffRole }[];
                all_branches: boolean;
            }
        ): Promise<StaffMember> {
            const passwordHash = await hashPassword(input.password, config.auth.passwordHash);
            return withBranchTx(db, s.ctx, async tx => {
                await checkAssignments(tx, s, input.assignments, input.all_branches);
                const oid = await staffRepo.create(tx, {
                    username: input.username,
                    name: input.name,
                    email: input.email,
                    passwordHash,
                    allBranches: input.all_branches
                });
                await staffRepo.setAssignments(tx, oid, input.assignments, input.all_branches);
                const after = await reload(tx, oid);
                await audit(tx, s, 'create', oid, undefined, after);
                return after;
            });
        },

        async updateProfile(s: StaffScope, oid: string, patch: { name?: string | undefined; email?: string | null | undefined }): Promise<StaffMember> {
            const after = await withBranchTx(db, s.ctx, async tx => {
                const before = await manageable(tx, s, oid, false);
                await staffRepo.updateProfile(tx, oid, patch);
                const after = await reload(tx, oid);
                await audit(tx, s, 'update', oid, before, after);
                return after;
            });
            await forgetUser(cache, after);
            return after;
        },

        /** HQ: the whole set of assignments. */
        async replaceAssignments(s: StaffScope, oid: string, list: { branch_oid: string; role: StaffRole }[], allBranches: boolean): Promise<StaffMember> {
            const after = await withBranchTx(db, s.ctx, async tx => {
                const before = await manageable(tx, s, oid, false);
                await checkAssignments(tx, s, list, allBranches);
                await staffRepo.setAssignments(tx, oid, list, allBranches);
                const after = await reload(tx, oid);
                await audit(tx, s, 'assign', oid, before, after);
                return after;
            });
            await forgetUser(cache, after);
            return after;
        },

        /** Branch: the role at this branch, or (`null`) removal from it. */
        async setRoleHere(s: StaffScope, oid: string, role: StaffRole | null): Promise<StaffMember> {
            const after = await withBranchTx(db, s.ctx, async tx => {
                const before = await manageable(tx, s, oid, false);
                const here = s.actor.branch;
                if (role !== null) await checkAssignments(tx, s, [{ branch_oid: here.oid, role }], false);
                await staffRepo.setAssignmentAt(tx, oid, here.oid, role);
                const after = await reload(tx, oid);
                await audit(tx, s, role === null ? 'unassign' : 'assign', oid, before, after);
                return after;
            });
            await forgetUser(cache, after);
            return after;
        },

        /** Deactivating also ends every session; their access token stops working at the next request. */
        async setStatus(s: StaffScope, oid: string, status: 'Active' | 'Inactive'): Promise<StaffMember> {
            const after = await withBranchTx(db, s.ctx, async tx => {
                const before = await manageable(tx, s, oid, false);
                if (before.status === status) return before;
                await staffRepo.setStatus(tx, oid, status);
                if (status === 'Inactive') await refreshTokens.revokeAll(tx, oid);
                const after = await reload(tx, oid);
                await audit(tx, s, status === 'Inactive' ? 'deactivate' : 'activate', oid, before, after);
                return after;
            });
            await forgetUser(cache, after);
            return after;
        },

        /** A new temporary password: every session ends and the person must change it at sign-in. */
        async resetPassword(s: StaffScope, oid: string, password: string): Promise<void> {
            const hash = await hashPassword(password, config.auth.passwordHash);
            const m = await withBranchTx(db, s.ctx, async tx => {
                const before = await manageable(tx, s, oid, false);
                await staffRepo.setTemporaryPassword(tx, oid, hash);
                await refreshTokens.revokeAll(tx, oid);
                await audit(tx, s, 'reset_password', oid, undefined, { must_change_password: true });
                return before;
            });
            await forgetUser(cache, m);
        },

        /** Ends every session of the person (a lost phone, a shared computer). */
        async signOutEverywhere(s: StaffScope, oid: string): Promise<void> {
            await withBranchTx(db, s.ctx, async tx => {
                await manageable(tx, s, oid, false);
                await refreshTokens.revokeAll(tx, oid);
                await audit(tx, s, 'sign_out', oid);
            });
        }
    };
}
