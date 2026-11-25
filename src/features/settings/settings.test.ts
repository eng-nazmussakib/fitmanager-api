import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

import { readOrgRules } from './settings.routes.ts';

let t: TestApp;
let owner: Record<string, string>;
let manager: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, DEMO_BRANCHES.HQ.oid);
    manager = atBranch((await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token, DEMO_BRANCHES.GUL.oid);
});
afterAll(() => t.close());

const settings = async () => (await request(t.app).get('/api/v1/hq/settings').set(owner).expect(200)).body.data as Record<string, unknown>;

describe('HQ settings', () => {
    it('starts at 15 %, no BIN, VAT added on top, freezes of 7 to 60 days', async () => {
        expect(await settings()).toMatchObject({
            vat_rate: 0.15,
            vat_bin: null,
            vat_inclusive: false,
            freeze_min_days: 7,
            freeze_max_days: 60,
            freeze_max_count: 2,
            updated_at: null,
            updated_by: null
        });
    });

    it('the freeze range changes on its own or together, but the shortest never passes the longest', async () => {
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_min_days: 14, freeze_max_days: 90 }).expect(200);
        expect(await settings()).toMatchObject({ freeze_min_days: 14, freeze_max_days: 90 });
        const res = await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_max_days: 10 }).expect(400);
        expect(res.body).toMatchObject({
            message: 'The shortest freeze (14 days) is longer than the longest (10 days)',
            errors: [{ path: 'freeze_max_days' }]
        });
        expect((await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_min_days: 91 }).expect(400)).body.errors).toEqual([
            { path: 'freeze_min_days', message: 'The shortest freeze must not be longer than the longest' }
        ]);
        for (const body of [{ freeze_min_days: 0 }, { freeze_max_days: 366 }, { freeze_min_days: 7.5 }, { freeze_max_days: '30' }]) {
            await request(t.app).patch('/api/v1/hq/settings').set(owner).send(body).expect(400);
        }
        await expect(t.deps.db.query(sql`update org_settings set freeze_min_days = 100, freeze_max_days = 50`)).rejects.toThrow(/org_settings_freeze_range/);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_min_days: 7, freeze_max_days: 60 }).expect(200);
        expect(await settings()).toMatchObject({ freeze_min_days: 7, freeze_max_days: 60 });
    });

    it('how many freezes one plan may have: 0 to 12', async () => {
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_max_count: 3 }).expect(200);
        expect(await settings()).toMatchObject({ freeze_max_count: 3, freeze_min_days: 7 });
        for (const freeze_max_count of [-1, 13, 1.5]) await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_max_count }).expect(400);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ freeze_max_count: 2 }).expect(200);
        // The booking rules: whole numbers in range.
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ booking_cancel_hours: 4, noshow_limit: 5 }).expect(200);
        expect(await settings()).toMatchObject({ booking_cancel_hours: 4, noshow_limit: 5, booking_open_days: 7 });
        for (const body of [
            { booking_open_days: 0 },
            { booking_cancel_hours: 73 },
            { noshow_block_days: 1.5 },
            { policy_grace_days: 91 },
            { complaint_response_hours: 0 }
        ])
            await request(t.app).patch('/api/v1/hq/settings').set(owner).send(body).expect(400);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ booking_cancel_hours: 2, noshow_limit: 3 }).expect(200);
    });

    it('changes only the fields sent; the rate is kept to basis points', async () => {
        const res = await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_rate: 0.07512, vat_inclusive: true }).expect(200);
        expect(res.body).toMatchObject({
            message: 'Settings saved',
            data: { vat_rate: 0.0751, vat_bin: null, vat_inclusive: true, updated_by: 'Kamrul Chowdhury' }
        });
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_bin: ' 000123456-0101 ' }).expect(200);
        expect(await settings()).toMatchObject({ vat_rate: 0.0751, vat_bin: '000123456-0101', vat_inclusive: true });
        expect(await readOrgRules(t.deps.db)).toEqual({
            vat_rate: 0.0751,
            vat_bin: '000123456-0101',
            vat_inclusive: true,
            freeze_min_days: 7,
            freeze_max_days: 60,
            freeze_max_count: 2,
            booking_open_days: 7,
            booking_max_active: 4,
            booking_cancel_hours: 2,
            noshow_limit: 3,
            noshow_window_days: 30,
            noshow_block_days: 7,
            policy_grace_days: 14,
            complaint_response_hours: 48
        });
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_rate: 0.15, vat_bin: '', vat_inclusive: false }).expect(200);
        expect(await settings()).toMatchObject({ vat_rate: 0.15, vat_bin: null, vat_inclusive: false });
    });

    it('refuses bad values and empty bodies', async () => {
        for (const body of [{}, { vat_rate: 0.6 }, { vat_rate: -0.01 }, { vat_rate: '15' }, { vat_bin: '12ab' }, { vat_inclusive: 'yes' }, { other: 1 }]) {
            await request(t.app).patch('/api/v1/hq/settings').set(owner).send(body).expect(400);
        }
        await expect(t.deps.db.query(sql`update org_settings set vat_rate = 0.9`)).rejects.toThrow(/check/);
        await expect(t.deps.db.query(sql`insert into org_settings (id) values (false)`)).rejects.toThrow(/check/);
    });

    it('GET /v1/rules: any signed-in user reads VAT and the freeze rule, nothing else', async () => {
        const rules = (await request(t.app).get('/api/v1/rules').set(manager).expect(200)).body.data as Record<string, unknown>;
        expect(rules).toEqual({
            vat_rate: 0.15,
            vat_bin: null,
            vat_inclusive: false,
            freeze_min_days: 7,
            freeze_max_days: 60,
            freeze_max_count: 2,
            booking_open_days: 7,
            booking_max_active: 4,
            booking_cancel_hours: 2,
            noshow_limit: 3,
            noshow_window_days: 30,
            noshow_block_days: 7,
            policy_grace_days: 14,
            complaint_response_hours: 48
        });
        await request(t.app).get('/api/v1/rules').expect(401);
    });

    it('is HQ only: a branch manager can neither read nor change it', async () => {
        await request(t.app).get('/api/v1/hq/settings').set(manager).expect(403);
        await request(t.app).patch('/api/v1/hq/settings').set(manager).send({ vat_rate: 0 }).expect(403);
        await request(t.app).get('/api/v1/hq/settings').expect(401);
    });
});

describe('settings: audit log', () => {
    it('a change writes one audit row at HQ with before and after', async () => {
        const audit = () =>
            withBranchTx(t.deps.db, systemContext(DEMO_BRANCHES.HQ.oid), tx =>
                tx.query<{ branch_oid: string; actor_name: string; before: unknown; after: unknown }>(
                    sql`select branch_oid, actor_name, before, after from audit_log where entity = 'org_settings' order by created_at`
                )
            );
        const n = (await audit()).length;
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: true }).expect(200);
        const rows = await audit();
        expect(rows).toHaveLength(n + 1);
        expect(rows.at(-1)).toMatchObject({
            branch_oid: DEMO_BRANCHES.HQ.oid,
            actor_name: 'Kamrul Chowdhury',
            before: { vat_inclusive: false, freeze_max_days: 60 },
            after: { vat_inclusive: true, freeze_max_days: 60 }
        });
        await request(t.app).patch('/api/v1/hq/settings').set(manager).send({ vat_inclusive: false }).expect(403);
        expect(await audit()).toHaveLength(n + 1);
        await request(t.app).patch('/api/v1/hq/settings').set(owner).send({ vat_inclusive: false }).expect(200);
    });
});
