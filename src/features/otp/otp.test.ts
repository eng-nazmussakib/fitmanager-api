import request from 'supertest';

import { sql } from '#src/db/sql.ts';
import { bearer, createTestApp, signIn, type TestApp } from '#src/testing/test-app.ts';

let t: TestApp;
let auth: [string, string];

beforeAll(async () => {
    t = await createTestApp();
    auth = bearer((await signIn(t.app)).access_token);
});
afterAll(() => t.close());

async function send(): Promise<{ otp_id: string; code: string }> {
    const res = await request(t.app)
        .post('/api/v1/otp/send')
        .set(...auth)
        .send({ email: 'someone@example.com' })
        .expect(200);
    const code = /(\d{6})/.exec(t.mailer.sent.at(-1)!.text!)![1]!;
    return { otp_id: res.body.data.otp_id as string, code };
}

const verify = (otp_id: string, code: string) =>
    request(t.app)
        .post('/api/v1/otp/verify')
        .set(...auth)
        .send({ otp_id, code });

describe('one-time codes', () => {
    it('mails a 6-digit code, stores only its HMAC, verifies it once', async () => {
        const { otp_id, code } = await send();
        expect(t.mailer.sent.at(-1)!.to).toEqual(['someone@example.com']);
        const [row] = await t.deps.db.query<{ code_hash: string }>(sql`select code_hash from otp where id = ${otp_id}`);
        expect(row!.code_hash).not.toContain(code);

        expect((await verify(otp_id, code)).status).toBe(200);
        expect((await verify(otp_id, code)).status).toBe(400); // single use
    });

    it('counts wrong attempts and locks after five', async () => {
        const { otp_id, code } = await send();
        const wrong = code === '000000' ? '111111' : '000000';
        const first = await verify(otp_id, wrong);
        expect(first.status).toBe(400);
        expect(first.body.message).toMatch(/4 attempt/);
        for (let i = 0; i < 3; i++) await verify(otp_id, wrong);
        expect((await verify(otp_id, wrong)).status).toBe(429);
        expect((await verify(otp_id, code)).status).toBe(429); // even the right code, once locked
    });

    it('refuses an expired code', async () => {
        const { otp_id, code } = await send();
        await t.deps.db.query(sql`update otp set expires_at = now() - interval '1 second' where id = ${otp_id}`);
        const res = await verify(otp_id, code);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/expired/);
    });
});
