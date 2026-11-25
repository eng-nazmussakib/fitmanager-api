import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
let owner: Record<string, string>;
let managerGul: Record<string, string>;
let managerUtt: Record<string, string>;
let deskGul: Record<string, string>;

const { HQ, GUL, DHA, UTT } = DEMO_BRANCHES;

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    managerGul = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    managerUtt = atBranch((await signIn(t.app, 'manager.uttara', 'Manager@123')).access_token, UTT.oid);
    deskGul = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
});
afterAll(() => t.close());

interface Staff {
    oid: string;
    username: string;
    name: string;
    email: string | null;
    status: string;
    all_branches: boolean;
    must_change_password: boolean;
    manageable: boolean;
    assignments: { branch_oid: string; branch_code: string; role: string }[];
}

const list = async (headers: Record<string, string>, query = '') =>
    (
        await request(t.app)
            .get(`/api/v1/${headers === owner ? 'hq' : 'branch'}/staff${query}`)
            .set(headers)
            .expect(200)
    ).body.data as {
        rows: Staff[];
        assignable_roles: { hq: string[]; branch: string[] };
    };
const oidOf = async (username: string) => {
    const row = (await list(owner)).rows.find(r => r.username === username);
    if (!row) throw new Error(`no ${username}`);
    return row.oid;
};

/** Creates an account at HQ as the owner and returns it. */
async function hqCreate(username: string, assignments: { branch_oid: string; role: string }[], extra: Record<string, unknown> = {}) {
    const res = await request(t.app)
        .post('/api/v1/hq/staff')
        .set(owner)
        .send({ username, name: `Test ${username}`, password: 'Temp1234', assignments, ...extra })
        .expect(201);
    return res.body.data as Staff;
}

describe('HQ staff', () => {
    it('lists every staff account with its assignments; the owner may hand out every role', async () => {
        const { rows, assignable_roles } = await list(owner);
        expect(rows.map(r => r.username)).toEqual(expect.arrayContaining(['owner', 'manager.gulshan', 'desk.uttara']));
        expect(
            rows
                .find(r => r.username === 'desk.uttara')
                ?.assignments.map(a => a.branch_code)
                .sort()
        ).toEqual(['DHA', 'UTT']);
        expect(rows.find(r => r.username === 'owner')).toMatchObject({ all_branches: true, manageable: false }); // themselves
        expect(assignable_roles.hq).toEqual(['OWNER', 'HQ_ADMIN']);
        const { branches } = (await request(t.app).get('/api/v1/hq/staff').set(owner).expect(200)).body.data as { branches: { code: string }[] };
        expect(branches.map(b => b.code)).toEqual(['HQ', 'DHA', 'GUL', 'UTT']);
        // trainer.gulshan and the four trainer accounts of the scheduling seed (005_scheduling.sql), which cannot sign in until given a temporary password.
        expect((await list(owner, `?branch_oid=${GUL.oid}&role=TRAINER`)).rows.map(r => r.username).sort()).toEqual([
            'nabila.islam',
            'shakib.hasan',
            'tahmina.rahman',
            'tom.blake',
            'trainer.gulshan'
        ]);
        expect((await list(owner, '?q=lamia')).rows.map(r => r.username)).toEqual(['desk.gulshan']);
    });

    it('creates an account with a temporary password; it must be changed before anything else works', async () => {
        const created = await hqCreate('new.trainer', [{ branch_oid: DHA.oid, role: 'TRAINER' }], { email: 'trainer@example.com' });
        expect(created).toMatchObject({ username: 'new.trainer', must_change_password: true, email: 'trainer@example.com' });
        expect(created).not.toHaveProperty('password_hash');

        const login = await signIn(t.app, 'new.trainer', 'Temp1234');
        const me = await request(t.app)
            .get('/api/v1/auth/me')
            .set(...bearer(login.access_token))
            .expect(200);
        expect(me.body.data.must_change_password).toBe(true);
        const blocked = await request(t.app).get('/api/v1/branch/audit').set(atBranch(login.access_token, DHA.oid)).expect(403);
        expect(blocked.body.errors[0].path).toBe('PASSWORD_CHANGE_REQUIRED');

        await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...bearer(login.access_token))
            .send({ current_password: 'Temp1234', new_password: 'Temp1234' })
            .expect(400);
        const changed = await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...bearer(login.access_token))
            .send({ current_password: 'Temp1234', new_password: 'MyOwn5678' })
            .expect(200);
        const fresh = changed.body.data.access_token as string;
        expect(
            (
                await request(t.app)
                    .get('/api/v1/auth/me')
                    .set(...bearer(fresh))
                    .expect(200)
            ).body.data.must_change_password
        ).toBe(false);
        // The old session ended with the change.
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: login.refresh_token }).expect(401);
        await signIn(t.app, 'new.trainer', 'MyOwn5678');
    });

    it('refuses bad input: duplicate username, weak password, mismatched role and branch, two roles at one branch', async () => {
        const post = (body: Record<string, unknown>) =>
            request(t.app)
                .post('/api/v1/hq/staff')
                .set(owner)
                .send({ username: 'x.user', name: 'X', password: 'Temp1234', assignments: [{ branch_oid: GUL.oid, role: 'TRAINER' }], ...body });
        expect((await post({ username: 'Manager.Gulshan' }).expect(409)).body.errors[0].path).toBe('username');
        await post({ password: 'short1' }).expect(400);
        await post({ password: 'lettersonly' }).expect(400);
        await post({ assignments: [{ branch_oid: GUL.oid, role: 'OWNER' }] }).expect(400);
        await post({ assignments: [{ branch_oid: HQ.oid, role: 'TRAINER' }] }).expect(400);
        await post({ assignments: [] }).expect(400);
        await post({
            assignments: [
                { branch_oid: GUL.oid, role: 'TRAINER' },
                { branch_oid: GUL.oid, role: 'FRONT_DESK' }
            ]
        }).expect(400);
        await post({ assignments: [{ branch_oid: '00000000-0000-4000-8000-0000000000ff', role: 'TRAINER' }] }).expect(400);
        await post({ all_branches: true }).expect(400); // needs an HQ assignment
        await post({ email: 'not-an-email' }).expect(400);
    });

    it('an HQ admin manages branch staff only: never OWNER or HQ_ADMIN accounts', async () => {
        await hqCreate('hq.admin', [{ branch_oid: HQ.oid, role: 'HQ_ADMIN' }]);
        const first = await signIn(t.app, 'hq.admin', 'Temp1234');
        const changed = await request(t.app)
            .post('/api/v1/auth/change-password')
            .set(...bearer(first.access_token))
            .send({ current_password: 'Temp1234', new_password: 'Admin1234' })
            .expect(200);
        const admin = atBranch(changed.body.data.access_token as string, HQ.oid);

        const { rows, assignable_roles } = (await request(t.app).get('/api/v1/hq/staff').set(admin).expect(200)).body.data as {
            rows: Staff[];
            assignable_roles: { hq: string[]; branch: string[] };
        };
        expect(assignable_roles).toEqual({ hq: [], branch: ['BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER'] });
        expect(rows.find(r => r.username === 'owner')?.manageable).toBe(false);
        expect(rows.find(r => r.username === 'manager.dhanmondi')?.manageable).toBe(true);

        const body = { username: 'by.admin', name: 'By Admin', password: 'Temp1234' };
        await request(t.app)
            .post('/api/v1/hq/staff')
            .set(admin)
            .send({ ...body, assignments: [{ branch_oid: HQ.oid, role: 'HQ_ADMIN' }] })
            .expect(403);
        await request(t.app)
            .post('/api/v1/hq/staff')
            .set(admin)
            .send({ ...body, assignments: [{ branch_oid: UTT.oid, role: 'BRANCH_MANAGER' }] })
            .expect(201);
        await request(t.app)
            .post(`/api/v1/hq/staff/${await oidOf('owner')}/deactivate`)
            .set(admin)
            .expect(403);
        await request(t.app)
            .patch(`/api/v1/hq/staff/${await oidOf('owner')}`)
            .set(admin)
            .send({ name: 'Nope' })
            .expect(403);
    });

    it('assignments are replaced as a whole; the change applies at the next request', async () => {
        const m = await hqCreate('moves.around', [{ branch_oid: GUL.oid, role: 'FRONT_DESK' }]);
        const res = await request(t.app)
            .put(`/api/v1/hq/staff/${m.oid}/assignments`)
            .set(owner)
            .send({
                assignments: [
                    { branch_oid: DHA.oid, role: 'BRANCH_MANAGER' },
                    { branch_oid: UTT.oid, role: 'TRAINER' }
                ]
            })
            .expect(200);
        expect((res.body.data as Staff).assignments.map(a => `${a.branch_code}:${a.role}`)).toEqual(['DHA:BRANCH_MANAGER', 'UTT:TRAINER']);
        // A branch manager no longer sees someone who moved away.
        expect((await list(managerGul)).rows.map(r => r.username)).not.toContain('moves.around');
    });

    it('nobody deactivates themselves or changes their own assignments', async () => {
        const me = await oidOf('owner');
        await request(t.app).post(`/api/v1/hq/staff/${me}/deactivate`).set(owner).expect(403);
        await request(t.app)
            .put(`/api/v1/hq/staff/${me}/assignments`)
            .set(owner)
            .send({ assignments: [{ branch_oid: HQ.oid, role: 'HQ_ADMIN' }] })
            .expect(403);
    });

    it('branch staff cannot reach the HQ staff routes', async () => {
        await request(t.app).get('/api/v1/hq/staff').set(managerGul).expect(403);
        await request(t.app)
            .get('/api/v1/hq/staff')
            .set(atBranch(owner['Authorization']!.slice(7), GUL.oid))
            .expect(403);
    });
});

describe('branch staff', () => {
    it('a manager sees only their branch, and may hand out front desk and trainer roles', async () => {
        const { rows, assignable_roles } = await list(managerGul);
        expect(rows.map(r => r.username).sort()).toEqual([
            'desk.gulshan',
            'manager.gulshan',
            'nabila.islam',
            'shakib.hasan',
            'tahmina.rahman',
            'tom.blake',
            'trainer.gulshan'
        ]);
        expect(assignable_roles.branch).toEqual(['FRONT_DESK', 'TRAINER']);
        expect(rows.find(r => r.username === 'manager.gulshan')?.manageable).toBe(false);
        expect(rows.find(r => r.username === 'desk.gulshan')?.manageable).toBe(true);
        await request(t.app)
            .get(`/api/v1/branch/staff/${await oidOf('desk.dhanmondi')}`)
            .set(managerGul)
            .expect(404);
    });

    it('a manager adds front desk staff at their branch, but never a manager', async () => {
        const body = { username: 'desk.two', name: 'Desk Two', password: 'Temp1234' };
        await request(t.app)
            .post('/api/v1/branch/staff')
            .set(managerGul)
            .send({ ...body, role: 'BRANCH_MANAGER' })
            .expect(403);
        const res = await request(t.app)
            .post('/api/v1/branch/staff')
            .set(managerGul)
            .send({ ...body, role: 'FRONT_DESK' })
            .expect(201);
        expect((res.body.data as Staff).assignments).toMatchObject([{ branch_oid: GUL.oid, role: 'FRONT_DESK' }]);
    });

    it('a manager changes roles, edits, resets passwords, deactivates and removes staff of their branch', async () => {
        const oid = await oidOf('desk.two');
        expect(
            (await request(t.app).put(`/api/v1/branch/staff/${oid}/role`).set(managerGul).send({ role: 'TRAINER' }).expect(200)).body.data.assignments[0].role
        ).toBe('TRAINER');
        await request(t.app).put(`/api/v1/branch/staff/${oid}/role`).set(managerGul).send({ role: 'BRANCH_MANAGER' }).expect(403);
        expect((await request(t.app).patch(`/api/v1/branch/staff/${oid}`).set(managerGul).send({ email: '' }).expect(200)).body.data.email).toBeNull();
        await request(t.app).post(`/api/v1/branch/staff/${oid}/reset-password`).set(managerGul).send({ password: 'Reset1234' }).expect(200);
        await signIn(t.app, 'desk.two', 'Reset1234');
        await request(t.app).post(`/api/v1/branch/staff/${oid}/deactivate`).set(managerGul).expect(200);
        await request(t.app).post('/api/v1/auth/login').send({ username: 'desk.two', password: 'Reset1234' }).expect(403);
        await request(t.app).post(`/api/v1/branch/staff/${oid}/activate`).set(managerGul).expect(200);
        await request(t.app).delete(`/api/v1/branch/staff/${oid}`).set(managerGul).expect(200);
        await request(t.app).get(`/api/v1/branch/staff/${oid}`).set(managerGul).expect(404);
    });

    it('a manager cannot touch another manager, or someone who also works at another branch', async () => {
        await request(t.app)
            .post(`/api/v1/branch/staff/${await oidOf('manager.gulshan')}/sign-out`)
            .set(managerGul)
            .expect(403);
        // desk.uttara is front desk at Uttara AND Dhanmondi: only HQ may manage them.
        const deskUtt = await oidOf('desk.uttara');
        expect((await list(managerUtt)).rows.find(r => r.oid === deskUtt)?.manageable).toBe(false);
        await request(t.app).post(`/api/v1/branch/staff/${deskUtt}/deactivate`).set(managerUtt).expect(403);
        await request(t.app).post(`/api/v1/branch/staff/${deskUtt}/reset-password`).set(managerUtt).send({ password: 'Reset1234' }).expect(403);
    });

    it('front desk staff cannot read or manage staff', async () => {
        await request(t.app).get('/api/v1/branch/staff').set(deskGul).expect(403);
        await request(t.app).post('/api/v1/branch/staff').set(deskGul).send({}).expect(403);
    });
});

describe('sessions', () => {
    it('lists the own sessions, marks the current one, and ends one by id', async () => {
        const a = await signIn(t.app, 'trainer.gulshan', 'Trainer@123');
        const b = await signIn(t.app, 'trainer.gulshan', 'Trainer@123');
        const sessions = (
            await request(t.app)
                .get('/api/v1/auth/sessions')
                .set(...bearer(a.access_token))
                .expect(200)
        ).body.data as {
            id: string;
            current: boolean;
        }[];
        expect(sessions.length).toBeGreaterThanOrEqual(2);
        expect(sessions.filter(s => s.current)).toHaveLength(1);
        const other = sessions.find(s => !s.current);
        await request(t.app)
            .delete(`/api/v1/auth/sessions/${other?.id}`)
            .set(...bearer(a.access_token))
            .expect(200);
        await request(t.app)
            .delete(`/api/v1/auth/sessions/${other?.id}`)
            .set(...bearer(a.access_token))
            .expect(404);
        // One of the two sign-ins is gone; the current one still refreshes.
        const refreshed = await Promise.all([a, b].map(s => request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: s.refresh_token })));
        expect(refreshed.map(r => r.status).sort()).toEqual([200, 401]);
    });

    it('an admin signs a person out everywhere', async () => {
        const s = await signIn(t.app, 'trainer.gulshan', 'Trainer@123');
        await request(t.app)
            .post(`/api/v1/hq/staff/${await oidOf('trainer.gulshan')}/sign-out`)
            .set(owner)
            .expect(200);
        await request(t.app).post('/api/v1/auth/refresh').send({ refresh_token: s.refresh_token }).expect(401);
    });
});

describe('staff: audit log', () => {
    interface AuditRow {
        branch_oid: string;
        actor_name: string | null;
        action: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
    }
    const auditFor = (oid: string) =>
        withBranchTx(t.deps.db, systemContext(HQ.oid, [HQ.oid, GUL.oid, DHA.oid, UTT.oid]), tx =>
            tx.query<AuditRow>(sql`select * from audit_log where entity = 'staff' and entity_key = ${oid} order by created_at, oid`)
        );

    it('every staff change at HQ writes one row at HQ, with no password hash', async () => {
        const m = await hqCreate('audited.hq', [{ branch_oid: GUL.oid, role: 'TRAINER' }]);
        const steps: [string, () => Promise<unknown>][] = [
            ['update', () => request(t.app).patch(`/api/v1/hq/staff/${m.oid}`).set(owner).send({ name: 'Renamed' }).expect(200)],
            [
                'assign',
                () =>
                    request(t.app)
                        .put(`/api/v1/hq/staff/${m.oid}/assignments`)
                        .set(owner)
                        .send({ assignments: [{ branch_oid: DHA.oid, role: 'TRAINER' }] })
                        .expect(200)
            ],
            ['reset_password', () => request(t.app).post(`/api/v1/hq/staff/${m.oid}/reset-password`).set(owner).send({ password: 'Again1234' }).expect(200)],
            ['sign_out', () => request(t.app).post(`/api/v1/hq/staff/${m.oid}/sign-out`).set(owner).expect(200)],
            ['deactivate', () => request(t.app).post(`/api/v1/hq/staff/${m.oid}/deactivate`).set(owner).expect(200)],
            ['activate', () => request(t.app).post(`/api/v1/hq/staff/${m.oid}/activate`).set(owner).expect(200)]
        ];
        for (const [, step] of steps) await step();
        const rows = await auditFor(m.oid);
        expect(rows.map(r => r.action)).toEqual(['create', ...steps.map(([action]) => action)]);
        expect(rows.every(r => r.branch_oid === HQ.oid && r.actor_name === 'Kamrul Chowdhury')).toBe(true);
        expect(rows[1]).toMatchObject({ before: { name: 'Test audited.hq' }, after: { name: 'Renamed' } });
        expect(JSON.stringify(rows)).not.toMatch(/scrypt|password_hash|Again1234/);
    });

    it('branch changes are logged at the branch; a refused change logs nothing', async () => {
        const res = await request(t.app)
            .post('/api/v1/branch/staff')
            .set(managerGul)
            .send({ username: 'audited.branch', name: 'Audited', password: 'Temp1234', role: 'TRAINER' })
            .expect(201);
        const oid = (res.body.data as Staff).oid;
        await request(t.app).put(`/api/v1/branch/staff/${oid}/role`).set(managerGul).send({ role: 'FRONT_DESK' }).expect(200);
        await request(t.app).put(`/api/v1/branch/staff/${oid}/role`).set(managerGul).send({ role: 'BRANCH_MANAGER' }).expect(403);
        await request(t.app).patch(`/api/v1/branch/staff/${oid}`).set(managerGul).send({ name: 'Audited Two' }).expect(200);
        await request(t.app).post(`/api/v1/branch/staff/${oid}/reset-password`).set(managerGul).send({ password: 'Again1234' }).expect(200);
        await request(t.app).post(`/api/v1/branch/staff/${oid}/sign-out`).set(managerGul).expect(200);
        await request(t.app).post(`/api/v1/branch/staff/${oid}/deactivate`).set(managerGul).expect(200);
        await request(t.app).post(`/api/v1/branch/staff/${oid}/activate`).set(managerGul).expect(200);
        await request(t.app).delete(`/api/v1/branch/staff/${oid}`).set(managerGul).expect(200);
        const rows = await auditFor(oid);
        expect(rows.map(r => r.action)).toEqual(['create', 'assign', 'update', 'reset_password', 'sign_out', 'deactivate', 'activate', 'unassign']);
        expect(rows.every(r => r.branch_oid === GUL.oid && r.actor_name === 'Ashraf Siddique')).toBe(true);
        // The manager reads them in their branch's log.
        const log = (await request(t.app).get(`/api/v1/branch/audit?entity=staff&entity_key=${oid}`).set(managerGul).expect(200)).body.data as {
            rows: unknown[];
        };
        expect(log.rows).toHaveLength(rows.length);
    });
});
