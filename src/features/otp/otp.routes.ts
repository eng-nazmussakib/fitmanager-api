import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { sql } from '#src/db/sql.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';
import { createLimiter } from '#src/lib/rate-limit.ts';
import { render } from '#src/lib/templates.ts';

/**
 * One-time codes (email). What the OMS/CU-Pay "TOTP" did instead: `authenticator.generateSecret()` + a 24-hour
 * TOTP step, a 4-digit number from `Math.random()` (predictable), and the DIFFERENCE between them stored next to
 * the TOTP secret, so anyone who could read the table could compute every code. Codes also never ran out of tries.
 *
 * Here: 6 digits from `crypto.randomInt`, only an HMAC of the code is stored (keyed with OTP_SECRET, so a table
 * dump is useless), 3 minutes to live, 5 attempts, single use, and sending is rate-limited per user.
 * otplib stays the right tool for authenticator-app TOTP (RFC 6238); for codes sent by email/SMS it is not needed.
 */
export const OTP_TTL_SECONDS = 180;
export const OTP_MAX_ATTEMPTS = 5;
const RESEND_AFTER_SECONDS = 60;

const sendSchema = v.strictObject({ email: v.pipe(v.string(), v.email()) });
const verifySchema = v.strictObject({ otp_id: v.pipe(v.string(), v.uuid()), code: v.pipe(v.string(), v.regex(/^\d{6}$/, 'Enter the 6-digit code')) });

export function otpRouter(deps: AppDeps): Router {
    const { db, config, mailer } = deps;
    const router = Router();
    const digest = (id: string, code: string) => createHmac('sha256', config.otpSecret).update(`${id}:${code}`).digest();
    const sendLimiter = createLimiter({ name: 'otp', windowMs: 10 * 60_000, limit: 5, redis: deps.redis, key: req => req.auth?.user.oid ?? 'anonymous' });

    router.use('/v1/otp', authenticate(deps));

    router.post('/v1/otp/send', sendLimiter, async (req, res) => {
        const { email } = parse(sendSchema, req.body);
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const id = randomUUID();
        await db.query(sql`
            insert into otp (id, purpose, recipient, code_hash, expires_at, created_by)
            values (${id}, 'demo', ${email}, ${digest(id, code).toString('hex')}, now() + make_interval(secs => ${OTP_TTL_SECONDS}), ${currentUser(req).oid})`);
        await mailer.send({
            to: [email],
            subject: 'Your verification code',
            html: render('mail/otp', { code, minutes: OTP_TTL_SECONDS / 60 }),
            text: `Your verification code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes.`
        });
        ok(res, { otp_id: id, expires_in: OTP_TTL_SECONDS, resend_after: RESEND_AFTER_SECONDS }, 'Code sent');
    });

    router.post('/v1/otp/verify', async (req, res) => {
        const { otp_id, code } = parse(verifySchema, req.body);
        // The attempt counter must survive a wrong guess, so the transaction returns an outcome and the error is
        // thrown after COMMIT (throwing inside would roll the increment back and allow unlimited guesses).
        const outcome = await db.transaction(async tx => {
            const [row] = await tx.query<{ code_hash: string; attempts: number; expired: boolean; consumed: boolean }>(sql`
                select code_hash, attempts, expires_at <= now() as expired, consumed_at is not null as consumed
                from otp where id = ${otp_id} and created_by = ${currentUser(req).oid} for update`);
            if (!row || row.consumed) return 'invalid' as const;
            if (row.expired) return 'expired' as const;
            if (row.attempts >= OTP_MAX_ATTEMPTS) return 'locked' as const;
            const matches = timingSafeEqual(Buffer.from(row.code_hash, 'hex'), digest(otp_id, code));
            await tx.query(
                matches ? sql`update otp set consumed_at = now() where id = ${otp_id}` : sql`update otp set attempts = attempts + 1 where id = ${otp_id}`
            );
            return matches ? ('ok' as const) : { wrong: OTP_MAX_ATTEMPTS - row.attempts - 1 };
        });

        if (outcome === 'ok') {
            ok(res, { verified: true }, 'Code verified');
            return;
        }
        if (outcome === 'invalid') throw new AppError(400, 'This code is not valid. Request a new one.');
        if (outcome === 'expired') throw new AppError(400, 'This code has expired. Request a new one.');
        if (outcome === 'locked' || outcome.wrong <= 0) throw new AppError(429, 'Too many wrong attempts. Request a new code.');
        throw new AppError(400, `Incorrect code. ${outcome.wrong} attempt(s) left.`, [{ path: 'code', message: 'Incorrect code' }]);
    });

    return router;
}
