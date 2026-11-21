import type { Db, Queryable } from '#src/db/db.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { daysBetween } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { previousRange, type Range, type Report, toDayRows, toGroupRows } from './reports.build.ts';
import * as defs from './reports.defs.ts';
import * as repo from './reports.repo.ts';

/**
 * The eight fixed reports (D-106), computed in SQL when read: this file loads the rows, `reports.defs.ts` shapes
 * them (the same definitions run in the web mock). Each takes the branches in scope (one at a branch, the user's
 * branches at HQ), a range of Dhaka days and whether to compare with the previous period.
 */

export { REPORT_KEYS, REPORT_TITLES, type ReportKey } from './reports.defs.ts';

type Load = (tx: Queryable, b: string[], s: defs.Scope) => Promise<defs.Built>;

const LOADERS: Record<defs.ReportKey, Load> = {
    async revenue(tx, b, s) {
        return defs.revenue(s, {
            days: toDayRows(await repo.revenueDays(tx, b, s.range)),
            previous: s.previous ? toDayRows(await repo.revenueDays(tx, b, s.previous)) : null,
            bySource: toGroupRows(await repo.revenueBySource(tx, b, s.range)),
            byMethod: toGroupRows(await repo.revenueByMethod(tx, b, s.range))
        });
    },
    async dues(tx, b, s) {
        return defs.dues(s, {
            totals: defs.byBranch(await repo.duesTotals(tx, b, s.range.to)),
            previous: s.previous ? defs.byBranch(await repo.duesTotals(tx, b, s.previous.to)) : null,
            byAge: toGroupRows(await repo.duesByAge(tx, b, s.range.to)),
            largest: await repo.duesLargest(tx, b, s.range.to, 25)
        });
    },
    async members(tx, b, s) {
        return defs.members(s, {
            days: toDayRows(await repo.memberDays(tx, b, s.range)),
            state: defs.byBranch(await repo.memberState(tx, b, s.range)),
            previousDays: s.previous ? toDayRows(await repo.memberDays(tx, b, s.previous)) : null,
            previousState: s.previous ? defs.byBranch(await repo.memberState(tx, b, s.previous)) : null,
            plans: toGroupRows(await repo.plansSold(tx, b, s.range)),
            expiring: await repo.expiringSoon(tx, b, s.range, 50)
        });
    },
    async attendance(tx, b, s) {
        return defs.attendance(
            s,
            {
                days: toDayRows(await repo.visitDays(tx, b, s.range)),
                unique: defs.byBranch(await repo.uniqueVisitors(tx, b, s.range)),
                previousDays: s.previous ? toDayRows(await repo.visitDays(tx, b, s.previous)) : null,
                previousUnique: s.previous ? defs.byBranch(await repo.uniqueVisitors(tx, b, s.previous)) : null,
                hours: await repo.visitHours(tx, b, s.range)
            },
            daysBetween(s.range.from, s.range.to) + 1
        );
    },
    async classes(tx, b, s) {
        return defs.classes(s, {
            days: toDayRows(await repo.classDays(tx, b, s.range)),
            previous: s.previous ? toDayRows(await repo.classDays(tx, b, s.previous)) : null,
            byType: toGroupRows(await repo.classByType(tx, b, s.range))
        });
    },
    async trainers(tx, b, s) {
        return defs.trainers(s, {
            rows: await repo.trainerNumbers(tx, b, s.range),
            previous: s.previous ? await repo.trainerNumbers(tx, b, s.previous) : null,
            days: toDayRows(await repo.ptDays(tx, b, s.range))
        });
    },
    async shop(tx, b, s) {
        return defs.shop(s, {
            days: toDayRows(await repo.shopDays(tx, b, s.range)),
            previous: s.previous ? toDayRows(await repo.shopDays(tx, b, s.previous)) : null,
            byProduct: toGroupRows(await repo.shopByProduct(tx, b, s.range, 'product')),
            byCategory: toGroupRows(await repo.shopByProduct(tx, b, s.range, 'category'))
        });
    },
    async operations(tx, b, s) {
        return defs.operations(s, {
            stock: toGroupRows(await repo.stockValue(tx, b)),
            spend: toGroupRows(await repo.equipmentSpend(tx, b, s.range)),
            complaints: toGroupRows(await repo.complaintsByCategory(tx, b, s.range)),
            feedback: toDayRows(await repo.feedbackDays(tx, b, s.range)),
            tickets: defs.byBranch(await repo.openTickets(tx, b)),
            previous: s.previous
                ? {
                      spend: toGroupRows(await repo.equipmentSpend(tx, b, s.previous)),
                      complaints: toGroupRows(await repo.complaintsByCategory(tx, b, s.previous)),
                      feedback: toDayRows(await repo.feedbackDays(tx, b, s.previous))
                  }
                : null
        });
    }
};

/** One report over `branchOids` (already checked against the caller's branches). */
export async function buildReport(
    db: Db,
    ctx: BranchContext,
    key: defs.ReportKey,
    branchOids: readonly string[],
    range: Range,
    compare: boolean
): Promise<Report> {
    return withBranchTx(db, ctx, async tx => {
        const branches = await repo.branchesOf(tx, branchOids);
        if (!branches.length) throw new AppError(400, 'Choose a branch to report on.');
        const scope: defs.Scope = { branches, range, previous: compare ? previousRange(range) : null };
        return defs.frame(
            key,
            scope,
            await LOADERS[key](
                tx,
                branches.map(b => b.oid),
                scope
            )
        );
    });
}

/** One trainer's numbers (`GET /v1/trainers/:oid/numbers`): the trainers report narrowed to them, at one branch. */
export async function trainerReport(db: Db, ctx: BranchContext, trainerOid: string, range: Range): Promise<Report> {
    return withBranchTx(db, ctx, async tx => {
        const branches = await repo.branchesOf(tx, [ctx.branchOid]);
        return defs.trainerNumbers(
            { branches, range, previous: null },
            {
                rows: await repo.trainerNumbers(tx, [ctx.branchOid], range, trainerOid),
                days: toDayRows(await repo.ptDays(tx, [ctx.branchOid], range, trainerOid))
            }
        );
    });
}
