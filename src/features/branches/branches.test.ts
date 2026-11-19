import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

const { HQ, GUL, DHA } = DEMO_BRANCHES;
let t: TestApp;
let owner: Record<string, string>;
let manager: Record<string, string>;
let managerToken: string;

beforeAll(async () => {
    t = await createTestApp();
    owner = atBranch((await signIn(t.app)).access_token, HQ.oid);
    managerToken = (await signIn(t.app, 'manager.gulshan', 'Manager@123')).access_token;
    manager = atBranch(managerToken, GUL.oid);
});
afterAll(() => t.close());

const SAT_THU = [6, 0, 1, 2, 3, 4];

describe('branch profiles (migration 008)', () => {
    it('public list: the three selling branches with hours as weekday numbers, never the dues limit', async () => {
        const rows = (await request(t.app).get('/api/v1/public/branches').expect(200)).body.data as Record<string, unknown>[];
        expect(rows.map(r => r['code'])).toEqual(['DHA', 'GUL', 'UTT']);
        const gul = rows.find(r => r['code'] === 'GUL')!;
        expect(gul).toMatchObject({
            slug: 'gulshan',
            capacity: 120,
            opened_on: '2019-03-01',
            hours: [
                { days: SAT_THU, open: '07:00', close: '23:00' },
                { days: [5], open: '16:00', close: '21:00' }
            ],
            ladies_hours: [{ days: SAT_THU, open: '12:00', close: '15:00' }]
        });
        expect(gul['facilities']).toContain('Sauna');
        expect(gul).not.toHaveProperty('dues_limit');
        expect((await request(t.app).get('/api/v1/public/branches/uttara').expect(200)).body.data).toMatchObject({ code: 'UTT', capacity: 80 });
        await request(t.app).get('/api/v1/public/branches/hq').expect(404);
        await request(t.app).get('/api/v1/public/branches/nowhere').expect(404);
    });

    it('signed in: only the branches you are assigned to, with the dues limit', async () => {
        const mine = (
            await request(t.app)
                .get('/api/v1/branches')
                .set(...bearer(managerToken))
                .expect(200)
        ).body.data as { code: string; dues_limit: number }[];
        expect(mine).toEqual([expect.objectContaining({ code: 'GUL', dues_limit: 1000 })]);
        await request(t.app)
            .get(`/api/v1/branches/${GUL.oid}`)
            .set(...bearer(managerToken))
            .expect(200);
        await request(t.app)
            .get(`/api/v1/branches/${DHA.oid}`)
            .set(...bearer(managerToken))
            .expect(404);
        const all = (await request(t.app).get('/api/v1/branches').set(owner).expect(200)).body.data as { code: string }[];
        expect(all.map(b => b.code)).toEqual(['HQ', 'DHA', 'GUL', 'UTT']);
        await request(t.app).get('/api/v1/branches').expect(401);
    });

    it('HQ changes a profile; only the fields sent change; the public list shows it at once', async () => {
        const res = await request(t.app)
            .patch(`/api/v1/hq/branches/${DHA.oid}`)
            .set(owner)
            .send({
                capacity: 95,
                dues_limit: 1200.4,
                facilities: ['Strength floor', 'Sauna'],
                hours: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '06:00', close: '22:00' }],
                email: null
            })
            .expect(200);
        expect(res.body).toMatchObject({
            message: 'Dhanmondi: profile saved',
            data: { capacity: 95, dues_limit: 1200, facilities: ['Strength floor', 'Sauna'], email: null, area: 'Dhanmondi', ladies_hours: [{ days: SAT_THU }] }
        });
        const pub = (await request(t.app).get('/api/v1/public/branches/dhanmondi').expect(200)).body.data as { hours: unknown[] };
        expect(pub.hours).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], open: '06:00', close: '22:00' }]);
        const list = (await request(t.app).get('/api/v1/public/branches').expect(200)).body.data as { code: string; capacity: number }[];
        expect(list.find(b => b.code === 'DHA')?.capacity).toBe(95);
    });

    it('refuses bad profiles', async () => {
        const bad = [
            {},
            { capacity: -1 },
            { capacity: 1.5 },
            { hours: [{ days: [], open: '07:00', close: '09:00' }] },
            { hours: [{ days: [7], open: '07:00', close: '09:00' }] },
            { hours: [{ days: [1, 1], open: '07:00', close: '09:00' }] },
            { hours: [{ days: [1], open: '22:00', close: '02:00' }] },
            { hours: [{ days: [1], open: '7:00', close: '09:00' }] },
            { phone: '01711000101' },
            { map_url: 'http://maps.example.com' },
            { name: 'Renamed' }
        ];
        for (const body of bad) await request(t.app).patch(`/api/v1/hq/branches/${GUL.oid}`).set(owner).send(body).expect(400);
        await request(t.app).patch('/api/v1/hq/branches/00000000-0000-4000-8000-0000000000ff').set(owner).send({ capacity: 1 }).expect(404);
    });

    it('a branch manager cannot change a profile, not even their own', async () => {
        await request(t.app).patch(`/api/v1/hq/branches/${GUL.oid}`).set(manager).send({ capacity: 1 }).expect(403);
    });
});

describe('branches: audit log', () => {
    it('a profile change writes one audit row at HQ with before and after', async () => {
        const audit = () =>
            withBranchTx(t.deps.db, systemContext(HQ.oid), tx =>
                tx.query<{ entity_key: string; before: { capacity: number }; after: { capacity: number } }>(
                    sql`select entity_key, before, after from audit_log where entity = 'branch' order by created_at`
                )
            );
        const n = (await audit()).length;
        await request(t.app).patch(`/api/v1/hq/branches/${GUL.oid}`).set(owner).send({ capacity: 125 }).expect(200);
        const rows = await audit();
        expect(rows).toHaveLength(n + 1);
        expect(rows.at(-1)).toMatchObject({ entity_key: 'GUL', before: { capacity: 120 }, after: { capacity: 125 } });
        await request(t.app).patch(`/api/v1/hq/branches/${GUL.oid}`).set(owner).send({ capacity: -5 }).expect(400);
        expect(await audit()).toHaveLength(n + 1);
    });
});
