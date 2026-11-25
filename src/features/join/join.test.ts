import request from 'supertest';

import { DEMO_BRANCHES } from '#src/testing/demo.ts';
import { atBranch, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
let desk: Record<string, string>;

beforeAll(async () => {
    t = await createTestApp();
    desk = atBranch((await signIn(t.app, 'desk.gulshan', 'Desk@123')).access_token, DEMO_BRANCHES.GUL.oid);
});
afterAll(() => t.close());

const pendingAtGulshan = async () =>
    ((await request(t.app).get('/api/v1/members?status=Pending&size=100').set(desk).expect(200)).body.data as { rows: { name: string; phone: string }[] }).rows;

describe('public join and enquiry forms', () => {
    it('an enquiry creates a Pending web member at the branch, with the message in the notes', async () => {
        const res = await request(t.app)
            .post('/api/v1/public/enquiries')
            .send({ branch: 'gulshan', name: 'Web Visitor', phone: '01555555555', message: 'Evening slots?' })
            .expect(200);
        expect(res.body.message).toBe('Thanks, Web. The Gulshan team will call you within a day.');
        const row = (await pendingAtGulshan()).find(r => r.phone === '+8801555555555');
        expect(row).toMatchObject({ name: 'Web Visitor' });
        // The same number again: the same answer, nothing new, and no hint that it exists.
        await request(t.app).post('/api/v1/public/enquiries').send({ branch: 'gulshan', name: 'Someone Else', phone: '01555555555' }).expect(200);
        expect((await pendingAtGulshan()).filter(r => r.phone === '+8801555555555')).toHaveLength(1);
    });

    it('sign-up: a Pending member; an existing number is told to sign in; the password is not stored', async () => {
        const res = await request(t.app)
            .post('/api/v1/public/join-requests')
            .send({ fullName: 'Sign Upper', phone: '01566666666', branch: 'gulshan', plan: 'single', period: 'monthly', password: 'Ignored123' })
            .expect(201);
        expect(res.body.data).toEqual({ status: 'pending' });
        const m = (await pendingAtGulshan()).find(r => r.phone === '+8801566666666') as { name: string; oid?: string } | undefined;
        expect(m?.name).toBe('Sign Upper');
        await request(t.app).post('/api/v1/public/join-requests').send({ fullName: 'Sign Upper', phone: '01566666666', branch: 'gulshan' }).expect(409);
        await request(t.app).post('/api/v1/auth/login').send({ username: '+8801566666666', password: 'Ignored123' }).expect(400);
    });

    it('refuses bad input and an unknown branch; a filled honeypot stores nothing', async () => {
        // Its own app: the 5-an-hour limit counts per app.
        const own = await createTestApp();
        const app = own.app;
        const ownDesk = atBranch((await signIn(app, 'desk.gulshan', 'Desk@123')).access_token, DEMO_BRANCHES.GUL.oid);
        await request(app).post('/api/v1/public/enquiries').send({ branch: 'gulshan', name: 'Al', phone: '01577777777' }).expect(400);
        await request(app).post('/api/v1/public/enquiries').send({ branch: 'nowhere', name: 'Real Name', phone: '01577777777' }).expect(400);
        await request(app).post('/api/v1/public/enquiries').send({ branch: 'hq', name: 'Real Name', phone: '01577777777' }).expect(400);
        await request(app)
            .post('/api/v1/public/enquiries')
            .send({ branch: 'gulshan', name: 'Bot Name', phone: '01588888888', website: 'http://spam' })
            .expect(200);
        const rows = ((await request(app).get('/api/v1/members?status=Pending&size=100').set(ownDesk).expect(200)).body.data as { rows: { phone: string }[] })
            .rows;
        expect(rows.some(r => r.phone === '+8801588888888')).toBe(false);
        await own.close();
    });

    it('5 forms per IP per hour', async () => {
        const fresh = await createTestApp();
        for (let i = 0; i < 5; i++)
            await request(fresh.app).post('/api/v1/public/enquiries').send({ branch: 'nowhere', name: 'Real Name', phone: '01577777777' }).expect(400);
        await request(fresh.app).post('/api/v1/public/enquiries').send({ branch: 'gulshan', name: 'Real Name', phone: '01577777777' }).expect(429);
        await fresh.close();
    });
});
