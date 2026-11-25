import type { BranchKind, StaffRole } from '#src/auth/auth.repo.ts';

/**
 * Who may manage which staff. The CASL rule `manage Staff` opens the staff routes; this narrows it to the
 * roles and branches an actor may hand out or touch:
 * - OWNER at HQ: every role, every branch.
 * - HQ_ADMIN at HQ: branch roles (BRANCH_MANAGER, FRONT_DESK, TRAINER) at any branch; never OWNER or HQ_ADMIN.
 * - BRANCH_MANAGER: FRONT_DESK and TRAINER at their own branch.
 * - OWNER or HQ_ADMIN acting at a branch (through `all_branches`): branch roles at that branch.
 * A person is managed only by someone who may manage EVERY role they hold, so a manager cannot touch someone who is
 * also a manager elsewhere, and only an OWNER changes an `all_branches` account.
 */
export const HQ_ROLES: readonly StaffRole[] = ['OWNER', 'HQ_ADMIN'];
export const BRANCH_ROLES: readonly StaffRole[] = ['BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER'];
const DESK_ROLES: readonly StaffRole[] = ['FRONT_DESK', 'TRAINER'];

/** The acting user's assignment at the request's branch. */
export interface Actor {
    oid: string;
    role: StaffRole;
    branch: { oid: string; kind: BranchKind };
}

export interface Placement {
    branch_oid: string;
    branch_kind: BranchKind;
    role: StaffRole;
}

export interface ManagedPerson {
    oid: string;
    all_branches: boolean;
    assignments: readonly Placement[];
}

/** HQ roles belong on the HQ row, branch roles on branch rows. */
export function fitsBranch(role: StaffRole, kind: BranchKind): boolean {
    return kind === 'HQ' ? HQ_ROLES.includes(role) : BRANCH_ROLES.includes(role);
}

/** May the actor give (or take away) `role` at this branch? */
export function mayAssign(actor: Actor, p: Placement): boolean {
    if (!fitsBranch(p.role, p.branch_kind)) return false;
    const here = p.branch_oid === actor.branch.oid;
    if (actor.branch.kind === 'HQ') {
        if (actor.role === 'OWNER') return true;
        if (actor.role === 'HQ_ADMIN') return BRANCH_ROLES.includes(p.role);
        return false;
    }
    if (actor.role === 'OWNER' || actor.role === 'HQ_ADMIN') return here && BRANCH_ROLES.includes(p.role);
    if (actor.role === 'BRANCH_MANAGER') return here && DESK_ROLES.includes(p.role);
    return false;
}

/** May the actor change this person's account (profile, status, password, sessions, assignments)? */
export function mayManage(actor: Actor, person: ManagedPerson): boolean {
    if (person.all_branches && !(actor.branch.kind === 'HQ' && actor.role === 'OWNER')) return false;
    return person.assignments.every(a => mayAssign(actor, a));
}

/** The roles the actor may hand out at a branch of this kind: what the web form offers. */
export function assignableRoles(actor: Actor, branch: { oid: string; kind: BranchKind }): StaffRole[] {
    return [...HQ_ROLES, ...BRANCH_ROLES].filter(role => mayAssign(actor, { branch_oid: branch.oid, branch_kind: branch.kind, role }));
}
