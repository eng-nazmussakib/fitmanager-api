import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { schedulingRepo } from '#src/features/scheduling/scheduling.repo.ts';
import { addDays, daysBetween, dhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { RatingCreate } from './feedback.schema.ts';

/**
 * NPS and ratings. Both are worked out when read:
 * - the portal's 0–10 card shows after 30 days of membership, at most once every 90 days (a dismissal counts);
 * - an attended class or a completed PT session can be rated 1–5 for 7 days after it, once.
 * A trainer sees their own averages only; managers and HQ see the scores, names and comments.
 */
export const NPS_AFTER_DAYS = 30;
export const NPS_EVERY_DAYS = 90;
export const RATE_WITHIN_DAYS = 7;

export interface FeedbackDeps {
    db: Db;
}

/** Promoters (9–10) minus detractors (0–6), as a share of the answers: −100 to 100. Null with no answers. */
export function npsScore(scores: number[]): number | null {
    if (!scores.length) return null;
    const promoters = scores.filter(s => s >= 9).length;
    const detractors = scores.filter(s => s <= 6).length;
    return Math.round(((promoters - detractors) / scores.length) * 100);
}

async function npsDue(tx: Queryable, memberOid: string, today: string) {
    const [m] = await tx.query<{ joined_on: string; pending: boolean; last: string | null }>(sql`
        select m.joined_on::text as joined_on, m.pending,
            (select max(to_char(r.created_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD')) from nps_response r where r.member_oid = m.oid) as last
        from member m where m.oid = ${memberOid}`);
    if (!m || m.pending) return false;
    if (daysBetween(m.joined_on, today) < NPS_AFTER_DAYS) return false;
    return m.last === null || daysBetween(m.last, today) >= NPS_EVERY_DAYS;
}

interface Rateable {
    kind: 'class' | 'pt';
    booking_oid: string | null;
    pt_session_oid: string | null;
    label: string;
    trainer_oid: string | null;
    trainer_name: string | null;
    at: Date;
}

async function rateable(tx: Queryable, memberOid: string, now: Date): Promise<Rateable[]> {
    const from = new Date(now.getTime() - RATE_WITHIN_DAYS * 86_400_000);
    const classes = await tx.query<Rateable>(sql`
        select 'class' as kind, k.oid as booking_oid, null::uuid as pt_session_oid, s.title as label, s.trainer_oid, s.trainer_name, s.starts_at as at
        from booking k join class_session s on s.oid = k.session_oid
        where k.member_oid = ${memberOid} and k.status = 'Attended' and s.starts_at >= ${from} and s.starts_at <= ${now}
          and not exists (select from rating r where r.booking_oid = k.oid)`);
    const pt = await tx.query<Rateable>(sql`
        select 'pt' as kind, null::uuid as booking_oid, p.oid as pt_session_oid, 'PT session' as label, p.trainer_oid, p.trainer_name, p.starts_at as at
        from pt_session p
        where p.member_oid = ${memberOid} and p.status = 'Completed' and p.starts_at >= ${from} and p.starts_at <= ${now}
          and not exists (select from rating r where r.pt_session_oid = p.oid)`);
    return [...classes, ...pt].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** `GET /v1/me/feedback`: whether the NPS card shows, what can be rated, and the member's recent ratings. */
export async function myFeedback(deps: FeedbackDeps, ctx: BranchContext, memberOid: string, now: Date) {
    return withBranchTx(deps.db, ctx, tx => feedbackIn(tx, memberOid, now));
}

async function feedbackIn(tx: Queryable, memberOid: string, now: Date) {
    const today = dhakaNow(now).date;
    const mine = await tx.query<{
        oid: string;
        kind: string;
        label: string;
        trainer_name: string | null;
        session_at: Date;
        score: number;
        comment: string | null;
    }>(sql`
        select oid, kind, label, trainer_name, session_at, score, comment from rating where member_oid = ${memberOid} order by session_at desc limit 20`);
    return {
        nps_due: await npsDue(tx, memberOid, today),
        rateable: (await rateable(tx, memberOid, now)).map(r => ({
            ...r,
            at: r.at.toISOString(),
            until: addDays(dhakaNow(r.at).date, RATE_WITHIN_DAYS)
        })),
        ratings: mine.map(r => ({ ...r, session_at: r.session_at.toISOString() }))
    };
}

/** `POST /v1/me/nps`: an answer, or a dismissal (score null). */
export async function answerNps(
    deps: FeedbackDeps,
    ctx: BranchContext,
    memberOid: string,
    input: { score: number | null; comment?: string | null | undefined },
    now: Date
) {
    return withBranchTx(deps.db, ctx, async tx => {
        if (!(await npsDue(tx, memberOid, dhakaNow(now).date))) throw new AppError(409, 'Thanks, we already have your answer.');
        await tx.query(sql`
            insert into nps_response (branch_oid, member_oid, score, comment, created_at)
            values (${ctx.branchOid}, ${memberOid}, ${input.score}, ${input.comment ?? null}, ${now})`);
        const [m] = await tx.query<{ code: string }>(sql`select code from member where oid = ${memberOid}`);
        await recordAudit(tx, ctx, {
            action: input.score === null ? 'dismiss' : 'answer',
            entity: 'nps_response',
            entityKey: m?.code ?? memberOid,
            before: null,
            after: { score: input.score }
        });
        return { nps_due: false };
    });
}

/** `POST /v1/me/ratings`: one class or PT session, within 7 days, once. */
export async function rate(deps: FeedbackDeps, ctx: BranchContext, memberOid: string, input: RatingCreate, now: Date) {
    return withBranchTx(deps.db, ctx, async tx => {
        const open = await rateable(tx, memberOid, now);
        const target = open.find(r => (input.booking_oid ? r.booking_oid === input.booking_oid : r.pt_session_oid === input.pt_session_oid));
        if (!target) throw new AppError(409, `You can rate a class you attended or a PT session you had, once, within ${RATE_WITHIN_DAYS} days.`);
        const [m] = await tx.query<{ code: string; name: string }>(sql`select code, name from member where oid = ${memberOid}`);
        await tx.query(sql`
            insert into rating (branch_oid, member_oid, member_name, kind, booking_oid, pt_session_oid, trainer_oid, trainer_name, label, session_at, score, comment, created_at)
            values (${ctx.branchOid}, ${memberOid}, ${m?.name ?? ''}, ${target.kind}, ${target.booking_oid}, ${target.pt_session_oid}, ${target.trainer_oid},
                ${target.trainer_name}, ${target.label}, ${target.at}, ${input.score}, ${input.comment ?? null}, ${now})`);
        await recordAudit(tx, ctx, {
            action: 'rate',
            entity: 'rating',
            entityKey: m?.code ?? memberOid,
            before: null,
            after: { kind: target.kind, label: target.label, score: input.score }
        });
        return feedbackIn(tx, memberOid, now);
    });
}

interface TrainerAverage {
    trainer_oid: string;
    trainer_name: string;
    class_avg: number | null;
    class_count: number;
    pt_avg: number | null;
    pt_count: number;
}

async function trainerAverages(tx: Queryable, from: Date, trainerOid: string | null): Promise<TrainerAverage[]> {
    return tx.query<TrainerAverage>(sql`
        select r.trainer_oid, max(r.trainer_name) as trainer_name,
            round(avg(r.score) filter (where r.kind = 'class'), 2)::float8 as class_avg, (count(*) filter (where r.kind = 'class'))::int as class_count,
            round(avg(r.score) filter (where r.kind = 'pt'), 2)::float8 as pt_avg, (count(*) filter (where r.kind = 'pt'))::int as pt_count
        from rating r
        where r.created_at >= ${from} and r.trainer_oid is not null and (${trainerOid}::uuid is null or r.trainer_oid = ${trainerOid}::uuid)
        group by r.trainer_oid order by max(r.trainer_name)`);
}

/**
 * `GET /v1/feedback` (`read Feedback`): managers and HQ get the NPS, the answers with names and comments, the ratings
 * and each trainer's averages; a trainer gets their own averages only.
 */
export async function feedbackReport(deps: FeedbackDeps, ctx: BranchContext, caller: { userOid: string; trainerOnly: boolean }, days: number, now: Date) {
    const from = new Date(now.getTime() - days * 86_400_000);
    return withBranchTx(deps.db, ctx, async tx => {
        if (caller.trainerOnly) {
            const me = await schedulingRepo.trainerByUser(tx, caller.userOid);
            const [mine] = me ? await trainerAverages(tx, from, me.oid) : [];
            return {
                days,
                trainer: mine ?? (me ? { trainer_oid: me.oid, trainer_name: '', class_avg: null, class_count: 0, pt_avg: null, pt_count: 0 } : null)
            };
        }
        const answers = await tx.query<{
            oid: string;
            branch_name: string;
            member_code: string;
            member_name: string;
            score: number | null;
            comment: string | null;
            created_at: Date;
        }>(sql`
            select r.oid, b.name as branch_name, m.code as member_code, m.name as member_name, r.score, r.comment, r.created_at
            from nps_response r join member m on m.oid = r.member_oid join branch b on b.oid = r.branch_oid
            where r.created_at >= ${from} order by r.created_at desc`);
        const scored = answers.flatMap(a => (a.score === null ? [] : [a.score]));
        const ratings = await tx.query<{
            oid: string;
            branch_name: string;
            member_name: string;
            kind: string;
            label: string;
            trainer_name: string | null;
            session_at: Date;
            score: number;
            comment: string | null;
        }>(sql`
            select r.oid, b.name as branch_name, r.member_name, r.kind, r.label, r.trainer_name, r.session_at, r.score, r.comment
            from rating r join branch b on b.oid = r.branch_oid where r.created_at >= ${from} order by r.session_at desc limit 200`);
        return {
            days,
            nps: {
                score: npsScore(scored),
                responses: scored.length,
                promoters: scored.filter(s => s >= 9).length,
                passives: scored.filter(s => s === 7 || s === 8).length,
                detractors: scored.filter(s => s <= 6).length,
                dismissed: answers.length - scored.length
            },
            answers: answers.filter(a => a.score !== null).map(a => ({ ...a, created_at: a.created_at.toISOString() })),
            ratings: ratings.map(r => ({ ...r, session_at: r.session_at.toISOString() })),
            trainers: await trainerAverages(tx, from, null)
        };
    });
}
