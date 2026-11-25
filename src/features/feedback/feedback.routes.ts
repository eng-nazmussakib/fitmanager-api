import { type Request, Router } from 'express';

import { authenticate, currentUser, requireAbility, requireAnyBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { memberContext } from '#src/features/portal/portal.service.ts';
import { ok, parse } from '#src/lib/http.ts';

import {
    type ComplaintDeps,
    createComplaint,
    escalateComplaint,
    fileMyComplaint,
    getComplaint,
    listComplaints,
    memberAction,
    myComplaints,
    portalStaff,
    replyComplaint,
    type StaffCaller
} from './complaints.service.ts';
import {
    complaintCreate,
    complaintQuery,
    complaintReply,
    escalateSchema,
    feedbackQuery,
    memberReply,
    npsCreate,
    oidParams,
    portalComplaintCreate,
    ratingCreate
} from './feedback.schema.ts';
import { answerNps, type FeedbackDeps, feedbackReport, myFeedback, rate } from './feedback.service.ts';

/**
 * Complaints, NPS and ratings.
 * - Staff, at a branch or HQ: `GET /v1/complaints[?status=&overdue=1&escalated=1]`, `GET /v1/complaints/:oid` (`read Complaint`),
 *   `POST /v1/complaints` (`create Complaint`, the desk on someone's behalf), `POST /v1/complaints/:oid/updates`
 *   (`update Complaint`), `POST /v1/complaints/:oid/escalate` (`manage Complaint`, to HQ); `GET /v1/feedback[?days=]`
 *   (`read Feedback`: a trainer their own averages).
 * - Portal: `GET|POST /v1/me/complaints`, `GET /v1/me/complaints/staff`, `POST /v1/me/complaints/:oid/reply|accept|escalate`;
 *   `GET /v1/me/feedback`, `POST /v1/me/nps`, `POST /v1/me/ratings`.
 */
export function feedbackRouter(deps: AppDeps): Router {
    const router = Router();
    const c: ComplaintDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const f: FeedbackDeps = { db: deps.db };
    const staff = [authenticate(deps), requireAnyBranch()];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    const oid = (req: Request) => parse(oidParams, req.params).oid;
    const caller = (req: Request): StaffCaller => {
        const a = req.auth?.assignment;
        return { userOid: currentUser(req).oid, hq: a?.branch.kind === 'HQ' };
    };
    const portal = (req: Request) => memberContext(deps, currentUser(req));

    router.get('/v1/complaints', ...staff, requireAbility('read', 'Complaint'), async (req, res) => {
        ok(res, await listComplaints(c, branchContext(req), caller(req), parse(complaintQuery, req.query), deps.clock()));
    });
    router.get('/v1/complaints/:oid', ...staff, requireAbility('read', 'Complaint'), async (req, res) => {
        ok(res, await getComplaint(c, branchContext(req), caller(req), oid(req), deps.clock()));
    });
    router.post('/v1/complaints', ...staff, requireAbility('create', 'Complaint'), async (req, res) => {
        const out = await createComplaint(c, branchContext(req), caller(req), parse(complaintCreate, req.body), deps.clock());
        ok(res, out, 'sent_to_hq' in out ? 'Complaint filed and sent to HQ' : 'Complaint filed', 201);
    });
    router.post('/v1/complaints/:oid/updates', ...staff, requireAbility('update', 'Complaint'), async (req, res) => {
        const body = parse(complaintReply, req.body);
        ok(
            res,
            await replyComplaint(c, branchContext(req), caller(req), oid(req), body, deps.clock()),
            body.status === 'resolved' ? 'Marked resolved' : 'Reply sent'
        );
    });
    router.post('/v1/complaints/:oid/escalate', ...staff, requireAbility('manage', 'Complaint'), async (req, res) => {
        ok(res, await escalateComplaint(c, branchContext(req), caller(req), oid(req), parse(escalateSchema, req.body).reason, deps.clock()), 'Sent to HQ');
    });

    router.get('/v1/feedback', ...staff, requireAbility('read', 'Feedback'), async (req, res) => {
        const trainerOnly = req.auth?.assignment?.role === 'TRAINER';
        ok(
            res,
            await feedbackReport(
                f,
                branchContext(req),
                { userOid: currentUser(req).oid, trainerOnly },
                parse(feedbackQuery, req.query).days ?? 90,
                deps.clock()
            )
        );
    });

    router.get('/v1/me/complaints', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await myComplaints(c, ctx, memberOid, deps.clock()));
    });
    router.get('/v1/me/complaints/staff', ...member, async (req, res) => {
        const { ctx } = await portal(req);
        ok(res, await portalStaff(c, ctx));
    });
    router.post('/v1/me/complaints', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await fileMyComplaint(c, ctx, memberOid, parse(portalComplaintCreate, req.body), deps.clock()), 'Complaint sent', 201);
    });
    router.post('/v1/me/complaints/:oid/reply', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await memberAction(c, ctx, memberOid, oid(req), { kind: 'reply', body: parse(memberReply, req.body).body }, deps.clock()), 'Reply sent');
    });
    router.post('/v1/me/complaints/:oid/accept', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await memberAction(c, ctx, memberOid, oid(req), { kind: 'accept' }, deps.clock()), 'Thanks: the complaint is closed');
    });
    router.post('/v1/me/complaints/:oid/escalate', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(
            res,
            await memberAction(c, ctx, memberOid, oid(req), { kind: 'escalate', reason: parse(escalateSchema, req.body).reason }, deps.clock()),
            'Sent to HQ'
        );
    });

    router.get('/v1/me/feedback', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await myFeedback(f, ctx, memberOid, deps.clock()));
    });
    router.post('/v1/me/nps', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const body = parse(npsCreate, req.body);
        ok(res, await answerNps(f, ctx, memberOid, body, deps.clock()), body.score === null ? 'Maybe later' : 'Thanks for your answer', 201);
    });
    router.post('/v1/me/ratings', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await rate(f, ctx, memberOid, parse(ratingCreate, req.body), deps.clock()), 'Thanks for rating', 201);
    });

    return router;
}
