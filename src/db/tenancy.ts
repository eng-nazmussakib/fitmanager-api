import type { Request } from 'express';

import { currentUser } from '#src/auth/middleware.ts';
import { AppError } from '#src/lib/http.ts';

import type { Db, Queryable } from './db.ts';
import { sql } from './sql.ts';

/**
 * Who a database transaction acts for, and which branches it may touch (D-004, D-023, D-034). Passed explicitly
 * to services: never read from the request body.
 *
 * - On a BRANCH: that branch only.
 * - At HQ: the HQ row plus every branch the user reaches (all of them with `all_branches`, the owner), so HQ
 *   screens and reports can read across branches.
 * - Jobs: `systemContext([...])`, naming the branches explicitly.
 */
export interface BranchContext {
    /** The branch the request acts at (the audit row's branch). */
    branchOid: string;
    /** Every branch the transaction may read or write: `app.branch_oids` for the RLS policies. */
    branchOids: readonly string[];
    actor: { oid: string; name: string } | null;
    requestId: string | null;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The context of a request behind `authenticate` + `requireBranch(...)`. */
export function branchContext(req: Request): BranchContext {
    const user = currentUser(req);
    const assignment = req.auth?.assignment;
    if (!assignment) throw new AppError(403, 'Choose a branch first');
    const branchOids = assignment.branch.kind === 'HQ' ? user.assignments.map(a => a.branch.oid) : [assignment.branch.oid];
    return {
        branchOid: assignment.branch.oid,
        branchOids,
        actor: { oid: user.oid, name: user.name },
        requestId: typeof req.id === 'string' ? req.id : null
    };
}

/** For jobs and scripts: no user, and the branches named explicitly (never "all" by default). */
export function systemContext(branchOid: string, branchOids: readonly string[] = [branchOid]): BranchContext {
    return { branchOid, branchOids, actor: null, requestId: null };
}

/**
 * Runs `fn` in one transaction whose RLS context is `ctx` (`set_config(..., true)`: transaction-local, so it is
 * safe behind Hyperdrive and Neon's transaction pooler, D-021). Every query on a branch-scoped table goes
 * through here; each statement still filters or inserts `branch_oid` itself (the app layer), and RLS catches a
 * statement that forgets (the database layer). An empty context throws instead of running unscoped.
 */
export async function withBranchTx<T>(db: Db, ctx: BranchContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (ctx.branchOids.length === 0 || !ctx.branchOids.includes(ctx.branchOid)) throw new Error('withBranchTx: empty or inconsistent branch context');
    for (const oid of ctx.branchOids) if (!UUID.test(oid)) throw new Error('withBranchTx: branch ids must be UUIDs');
    return db.transaction(async tx => {
        await tx.query(sql`select set_config('app.branch_oids', ${`{${ctx.branchOids.join(',')}}`}, true)`);
        return fn(tx);
    });
}
