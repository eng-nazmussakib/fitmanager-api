import { Router } from 'express';
import * as v from 'valibot';

import type { AppDeps } from '#src/container.ts';
import { pgErrorCode, sql } from '#src/db/sql.ts';
import { systemContext } from '#src/db/tenancy.ts';
import { bdMobile } from '#src/features/members/members.schema.ts';
import { createMember } from '#src/features/members/members.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';
import { createLimiter } from '#src/lib/rate-limit.ts';

/**
 * The public site's forms. Both create a `Pending` member at the chosen
 * branch (`source = 'web'`), which the desk turns into a membership with the first sale:
 * - `POST /v1/public/enquiries` `{ branch, name, phone, message }` (the /join page: "call me back");
 * - `POST /v1/public/join-requests` `{ fullName, phone, email?, branch, plan?, period? }` (sign-up).
 * Spam, with no outside service: a honeypot field `website` that people never fill and 5 requests per IP
 * per hour. A number that is already a member never says so on the enquiry form (no
 * lookup by phone for strangers); the sign-up form says "sign in instead", as the mock does.
 */
const slug = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Choose a branch'));
const honeypot = v.optional(v.string());

const enquirySchema = v.strictObject({
    branch: slug,
    name: v.pipe(v.string(), v.trim(), v.minLength(3, 'Enter your name'), v.maxLength(120)),
    phone: bdMobile(),
    message: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500)), ''),
    website: honeypot
});

const joinSchema = v.strictObject({
    fullName: v.pipe(v.string(), v.trim(), v.minLength(3, 'Enter your full name'), v.maxLength(120)),
    phone: bdMobile(),
    email: v.optional(
        v.pipe(
            v.string(),
            v.trim(),
            v.transform(s => s || undefined),
            v.optional(v.pipe(v.string(), v.email('Enter a valid email address')))
        )
    ),
    branch: slug,
    plan: v.optional(v.pipe(v.string(), v.maxLength(60))),
    period: v.optional(v.pipe(v.string(), v.maxLength(60))),
    /** Not stored: portal access is given at the desk with a temporary password. */
    password: v.optional(v.string()),
    website: honeypot
});

export function joinRouter(deps: AppDeps): Router {
    const router = Router();
    const limiter = createLimiter({ name: 'join', windowMs: 60 * 60_000, limit: 5, stores: deps.rateLimits });
    const memberDeps = { db: deps.db, files: deps.files, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };

    const branchOf = async (slugValue: string) => {
        const [b] = await deps.db.query<{ oid: string; name: string }>(
            sql`select oid, name from branch where slug = ${slugValue} and kind = 'BRANCH' and status = 'Active'`
        );
        if (!b) throw new AppError(400, 'Choose a branch', [{ path: 'branch', message: 'Unknown branch' }]);
        return b;
    };

    /** A Pending member at the branch, or `false` when the number is already a member's. */
    const pending = async (branchOid: string, input: { name: string; phone: string; email?: string | undefined; notes: string }) => {
        try {
            await createMember(
                memberDeps,
                systemContext(branchOid),
                dhakaNow(deps.clock()).date,
                {
                    name: input.name,
                    phone: input.phone,
                    gender: null,
                    email: input.email ?? null,
                    health_flags: [],
                    health_declared: false,
                    notes: input.notes
                },
                'web'
            );
            return true;
        } catch (err) {
            if (err instanceof AppError && err.status === 409) return false;
            if (pgErrorCode(err) === '23505') return false;
            throw err;
        }
    };

    // A filled honeypot: answer like a success so the bot learns nothing, and store nothing.
    const isPerson = (body: { website?: string | undefined }) => !body.website;

    router.post('/v1/public/enquiries', limiter, async (req, res) => {
        const body = parse(enquirySchema, req.body);
        const b = await branchOf(body.branch);
        if (isPerson(body)) {
            const created = await pending(b.oid, { name: body.name, phone: body.phone, notes: `Web enquiry${body.message ? `: ${body.message}` : ''}` });
            if (!created) log().info({ branch: b.oid }, 'Enquiry from an existing member’s number: nothing created');
        }
        ok(res, { received: true }, `Thanks, ${body.name.split(' ')[0] ?? body.name}. The ${b.name} team will call you within a day.`);
    });

    router.post('/v1/public/join-requests', limiter, async (req, res) => {
        const body = parse(joinSchema, req.body);
        const b = await branchOf(body.branch);
        if (isPerson(body)) {
            const interest = [body.plan, body.period].filter(Boolean).join(' · ');
            const created = await pending(b.oid, {
                name: body.fullName,
                phone: body.phone,
                email: body.email,
                notes: `Web sign-up${interest ? `: ${interest}` : ''}`
            });
            if (!created) throw new AppError(409, 'This mobile number already has an account. Sign in instead.');
        }
        ok(res, { status: 'pending' }, `Request received. Visit ${b.name} to pay and get your card; the desk gives you your portal sign-in.`, 201);
    });

    return router;
}
