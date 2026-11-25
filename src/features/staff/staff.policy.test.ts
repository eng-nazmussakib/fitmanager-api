import type { StaffRole } from '#src/auth/auth.repo.ts';

import { type Actor, assignableRoles, mayAssign, mayManage, type Placement } from './staff.policy.ts';

const HQ = { oid: 'hq', kind: 'HQ' as const };
const GUL = { oid: 'gul', kind: 'BRANCH' as const };
const DHA = { oid: 'dha', kind: 'BRANCH' as const };
const actor = (role: StaffRole, branch: Actor['branch']): Actor => ({ oid: 'me', role, branch });
const at = (branch: Actor['branch'], role: StaffRole): Placement => ({ branch_oid: branch.oid, branch_kind: branch.kind, role });

describe('staff policy', () => {
    it('roles each actor may hand out', () => {
        expect(assignableRoles(actor('OWNER', HQ), HQ)).toEqual(['OWNER', 'HQ_ADMIN']);
        expect(assignableRoles(actor('OWNER', HQ), GUL)).toEqual(['BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER']);
        expect(assignableRoles(actor('HQ_ADMIN', HQ), HQ)).toEqual([]);
        expect(assignableRoles(actor('HQ_ADMIN', HQ), DHA)).toEqual(['BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER']);
        expect(assignableRoles(actor('BRANCH_MANAGER', GUL), GUL)).toEqual(['FRONT_DESK', 'TRAINER']);
        expect(assignableRoles(actor('BRANCH_MANAGER', GUL), DHA)).toEqual([]);
        expect(assignableRoles(actor('FRONT_DESK', GUL), GUL)).toEqual([]);
        expect(assignableRoles(actor('TRAINER', GUL), GUL)).toEqual([]);
    });

    it('an HQ role never goes on a branch row, nor a branch role on HQ', () => {
        expect(mayAssign(actor('OWNER', HQ), at(GUL, 'OWNER'))).toBe(false);
        expect(mayAssign(actor('OWNER', HQ), at(HQ, 'FRONT_DESK'))).toBe(false);
    });

    it('an owner or HQ admin acting at a branch manages branch roles there only', () => {
        expect(mayAssign(actor('OWNER', GUL), at(GUL, 'BRANCH_MANAGER'))).toBe(true);
        expect(mayAssign(actor('OWNER', GUL), at(DHA, 'FRONT_DESK'))).toBe(false);
        expect(mayAssign(actor('HQ_ADMIN', GUL), at(GUL, 'TRAINER'))).toBe(true);
    });

    it('a person is managed only by someone who may manage every role they hold', () => {
        const manager = actor('BRANCH_MANAGER', GUL);
        expect(mayManage(manager, { oid: 'x', all_branches: false, assignments: [at(GUL, 'FRONT_DESK')] })).toBe(true);
        expect(mayManage(manager, { oid: 'x', all_branches: false, assignments: [at(GUL, 'FRONT_DESK'), at(DHA, 'FRONT_DESK')] })).toBe(false);
        expect(mayManage(manager, { oid: 'x', all_branches: false, assignments: [at(GUL, 'BRANCH_MANAGER')] })).toBe(false);
        expect(mayManage(actor('HQ_ADMIN', HQ), { oid: 'x', all_branches: false, assignments: [at(HQ, 'HQ_ADMIN')] })).toBe(false);
        expect(mayManage(actor('HQ_ADMIN', HQ), { oid: 'x', all_branches: false, assignments: [at(GUL, 'BRANCH_MANAGER'), at(DHA, 'TRAINER')] })).toBe(true);
    });

    it('only an owner at HQ manages an every-branch account', () => {
        const owner = { oid: 'o', all_branches: true, assignments: [at(HQ, 'OWNER')] };
        expect(mayManage(actor('OWNER', HQ), owner)).toBe(true);
        expect(mayManage(actor('OWNER', GUL), owner)).toBe(false);
        expect(mayManage(actor('HQ_ADMIN', HQ), { ...owner, assignments: [at(HQ, 'HQ_ADMIN')] })).toBe(false);
    });
});
