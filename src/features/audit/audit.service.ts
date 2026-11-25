import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import type { BranchContext } from '#src/db/tenancy.ts';

/**
 * The audit log: every write records who did what, to which row, with the row before and after. Call it
 * with the SAME transaction as the write (from `withBranchTx`), so either both are saved or neither is. The table
 * is append-only (migration 005): a trigger refuses UPDATE, DELETE and TRUNCATE, and RLS limits rows to the
 * transaction's branches.
 */
export interface AuditEntry {
    /** Lower snake case: `update`, `create`, `deactivate`, `transfer`… */
    action: string;
    /** Lower snake case table-like name: `site_group`, `member`… */
    entity: string;
    /** The row's key (oid, or a natural key such as a site group's `key`). */
    entityKey: string;
    before?: unknown;
    after?: unknown;
}

export async function recordAudit(tx: Queryable, ctx: BranchContext, entry: AuditEntry): Promise<void> {
    const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));
    await tx.query(sql`
        insert into audit_log (branch_oid, actor_oid, actor_name, action, entity, entity_key, before, after, request_id)
        values (${ctx.branchOid}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? null}, ${entry.action}, ${entry.entity}, ${entry.entityKey},
                ${json(entry.before)}::jsonb, ${json(entry.after)}::jsonb, ${ctx.requestId})`);
}
