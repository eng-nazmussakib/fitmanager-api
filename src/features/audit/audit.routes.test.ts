import request from 'supertest';

import { type AppRule, createAbility } from '#src/auth/ability.ts';
import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { recordAudit } from './audit.service.ts';

const { HQ, GUL, DHA } = DEMO_BRANCHES;

interface Row {
    branch_oid: string;
    branch_code: string;
    actor_name: string | null;
    action: string;
    entity: string;
    entity_key: string;
    before: unknown;
    after: unknown;
    created_at: string;
}
interface Page {
    rows: Row[];
    next: string | null;
}

let t: TestApp;
let owner: Record<string, string>;
let managerGul: Record<string, string>;
let deskGul: Record<string, string>;

/** Seed rows straight into the log, as a write in that branch would. */
const seed = (branchOid: string, entity: string, key: string) =>
    withBranchTx(t.deps.db, systemContext(branchOid), tx =>
        recordAudit(tx, systemContext(branchOid), { action: 'create', entity, entityKey: key, after: { key } })
    );

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    managerGul = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, GUL.oid);
    deskGul = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, GUL.oid);
    for (let i = 1; i <= 3; i++) await seed(GUL.oid, 'probe_member', `gul-${i}`);
    await seed(DHA.oid, 'probe_member', 'dha-1');
    await seed(HQ.oid, 'probe_plan', 'hq-1');
});
afterAll(() => t.close());

const get = async (url: string, headers: Record<string, string>, status = 200): Promise<{ data: unknown; message: string }> =>
    (await request(t.app).get(`/api${url}`).set(headers).expect(status)).body as { data: unknown; message: string };
const keys = (page: Page) => page.rows.map(r => r.entity_key);

describe('audit log: who may read it (migration 006)', () => {
    it('HQ admin and branch manager read it; front desk and trainer do not', async () => {
        const roles = await t.deps.db.query<{ code: string; rules: AppRule[] }>(sql`select code, rules from app_role`);
        const can = Object.fromEntries(roles.map(r => [r.code, createAbility(r.rules).can('read', 'AuditLog')]));
        expect(can).toEqual({ OWNER: true, HQ_ADMIN: true, BRANCH_MANAGER: true, FRONT_DESK: false, TRAINER: false });
        const write = roles.filter(r => ['create', 'update', 'delete'].some(a => r.code !== 'OWNER' && createAbility(r.rules).can(a as 'create', 'AuditLog')));
        expect(write).toEqual([]);
    });

    it('front desk gets 403; the branch route refuses HQ and the HQ route refuses a branch', async () => {
        await get('/v1/branch/audit', deskGul, 403);
        await get('/v1/hq/audit', managerGul, 403);
        await get('/v1/branch/audit', owner, 400);
        await request(t.app).get('/api/v1/hq/audit').expect(401);
    });
});

describe('GET /v1/branch/audit', () => {
    it("a branch manager sees their branch's rows only, newest first", async () => {
        const page = (await get('/v1/branch/audit?entity=probe_member', managerGul)).data as Page;
        expect(keys(page).sort()).toEqual(['gul-1', 'gul-2', 'gul-3']);
        // Newest first. Rows written in the same clock tick (PGlite) can tie, so compare times, not the keys' order.
        const times = page.rows.map(r => Date.parse(r.created_at));
        expect(times).toEqual([...times].sort((a, b) => b - a));
        expect(page.rows.every(r => r.branch_oid === GUL.oid && r.branch_code === 'GUL')).toBe(true);
        expect(page.next).toBeNull();
    });

    it('pages with a cursor without repeating or skipping rows', async () => {
        const first = (await get('/v1/branch/audit?entity=probe_member&limit=2', managerGul)).data as Page;
        const all = keys((await get('/v1/branch/audit?entity=probe_member', managerGul)).data as Page);
        expect(keys(first)).toEqual(all.slice(0, 2));
        expect(first.next).toEqual(expect.any(String));
        const second = (await get(`/v1/branch/audit?entity=probe_member&limit=2&before=${first.next}`, managerGul)).data as Page;
        expect(keys(second)).toEqual(all.slice(2));
        expect(second.next).toBeNull();
    });

    it('refuses a branch_oid parameter, a bad cursor and bad filters', async () => {
        await get(`/v1/branch/audit?branch_oid=${DHA.oid}`, managerGul, 400);
        expect((await get('/v1/branch/audit?before=bm9wZQ', managerGul, 400)).message).toMatch(/cursor/);
        await get('/v1/branch/audit?entity=Member', managerGul, 400);
        await get('/v1/branch/audit?from=2026-02-30', managerGul, 400);
        await get('/v1/branch/audit?from=2026-11-20&to=2026-11-01', managerGul, 400);
        await get('/v1/branch/audit?limit=0', managerGul, 400);
    });
});

describe('GET /v1/hq/audit', () => {
    it('the owner at HQ reads across HQ and every branch', async () => {
        const page = (await get('/v1/hq/audit?action=create', owner)).data as Page;
        expect(new Set(page.rows.filter(r => r.entity.startsWith('probe_')).map(r => r.entity_key))).toEqual(
            new Set(['gul-1', 'gul-2', 'gul-3', 'dha-1', 'hq-1'])
        );
    });

    it('narrows to one branch, an entity, an entity key and a date range', async () => {
        expect(keys((await get(`/v1/hq/audit?branch_oid=${DHA.oid}&entity=probe_member`, owner)).data as Page)).toEqual(['dha-1']);
        expect(keys((await get('/v1/hq/audit?entity=probe_plan', owner)).data as Page)).toEqual(['hq-1']);
        expect(keys((await get('/v1/hq/audit?entity=probe_member&entity_key=gul-2', owner)).data as Page)).toEqual(['gul-2']);
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }); // YYYY-MM-DD in Dhaka
        expect(((await get(`/v1/hq/audit?entity=probe_member&from=${today}&to=${today}`, owner)).data as Page).rows).toHaveLength(4);
        expect(((await get('/v1/hq/audit?entity=probe_member&to=2020-01-01', owner)).data as Page).rows).toEqual([]);
    });

    it('filters by actor: a real write shows its author', async () => {
        await request(t.app).patch('/api/v1/hq/site-groups/faq').set(owner).send({ section: true }).expect(200);
        const actor = ((await get('/v1/auth/me', owner)).data as { user_id: string }).user_id;
        const page = (await get(`/v1/hq/audit?actor_oid=${actor}&entity=site_group`, owner)).data as Page;
        expect(page.rows[0]).toMatchObject({ actor_name: 'Kamrul Chowdhury', entity_key: 'faq', branch_code: 'HQ' });
    });

    it('a branch the user does not reach is refused, not silently empty', async () => {
        await get('/v1/hq/audit?branch_oid=00000000-0000-4000-8000-000000000000', owner, 403);
    });
});
