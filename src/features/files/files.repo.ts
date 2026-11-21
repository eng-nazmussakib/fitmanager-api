import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';

export type FileKind =
    | 'member_photo'
    | 'member_document'
    | 'trainer_photo'
    | 'exercise_photo'
    | 'exercise_video'
    | 'measurement_photo'
    | 'incident_evidence'
    | 'complaint_photo'
    | 'product_photo'
    | 'equipment_photo'
    | 'ticket_photo';
export type FileStatus = 'pending' | 'ready' | 'rejected' | 'deleted';

/** A stored file as the API shows it. `storage_key` stays on the server. */
export interface FileRow {
    oid: string;
    branch_oid: string;
    member_oid: string | null;
    kind: FileKind;
    name: string;
    content_type: string;
    size_bytes: number | null;
    status: FileStatus;
    created_at: string;
    created_by_name: string | null;
}

/**
 * Guest uploads on the hosted demo (D-077) are stored under this prefix, and the bucket's lifecycle rule deletes them
 * after `GUEST_FILE_DAYS` (rule `expire-guest-uploads`, fitmanager-infra/cloudflare/demo-deploy.md). The rest are kept.
 */
export const GUEST_KEY_PREFIX = 'guest/';
export const GUEST_FILE_DAYS = 7;

/** A guest upload past its lifetime (time rule on read): its object is gone or about to go, so it reads as deleted. */
const expired = (alias: string) => `(${alias}.storage_key like '${GUEST_KEY_PREFIX}%' and ${alias}.created_at < now() - interval '${GUEST_FILE_DAYS} days')`;

/** A member photo pointer (`column` holds a file oid), or null once it points at an expired guest upload. */
export const livePhotoExpr = (column: string) =>
    `case when exists (select 1 from file gf where gf.oid = ${column} and ${expired('gf')}) then null else ${column} end`;
export const livePhoto = (column: string) => sql.raw(livePhotoExpr(column));

const COLUMNS = sql.raw(`f.oid, f.branch_oid, f.member_oid, f.kind, f.name, f.content_type, f.size_bytes,
    case when f.status in ('pending', 'ready') and ${expired('f')} then 'deleted' else f.status end as status, f.created_at,
    u.name as created_by_name from file f left join app_user u on u.oid = f.created_by`);

/** Branch data under RLS: call inside `withBranchTx`; each statement filters the branch itself too. */
export const filesRepo = {
    create: async (
        tx: Queryable,
        row: {
            oid: string;
            branch_oid: string;
            member_oid: string | null;
            kind: FileKind;
            storage_key: string;
            name: string;
            content_type: string;
            /** The size the browser declared: it reserves that much of the storage limit until `complete`. */
            size_bytes: number;
        },
        actor: string
    ) => {
        await tx.query(sql`
            insert into file (oid, branch_oid, member_oid, kind, storage_key, name, content_type, size_bytes, created_by)
            values (${row.oid}, ${row.branch_oid}, ${row.member_oid}, ${row.kind}, ${row.storage_key}, ${row.name}, ${row.content_type},
                    ${row.size_bytes}, ${actor})`);
    },

    /**
     * Bytes the file store holds or has been promised, across EVERY branch: the bucket and R2's free allowance are
     * shared, so the limit is too (D-074). Counts ready files, plus pending ones from the last day (an upload that
     * may still complete). Rejected and deleted files are removed from the store, so they do not count.
     * Takes the transaction-wide lock first, so two uploads cannot both squeeze under the limit. It widens the RLS
     * context to every branch for one aggregate and then puts the caller's context back: only a total leaves.
     */
    storageUsed: async (tx: Queryable, restoreOids: readonly string[], exceptOid: string | null = null) => {
        await tx.query(sql`select pg_advisory_xact_lock(hashtext('fitmanager:file-storage'))`);
        await tx.query(sql`select set_config('app.branch_oids', (select coalesce('{' || string_agg(oid::text, ',') || '}', '{}') from branch), true)`);
        const [row] = await tx.query<{ used: string }>(sql`
            select coalesce(sum(size_bytes), 0)::text as used from file
            where (status = 'ready' or (status = 'pending' and created_at > now() - interval '1 day'))
              and not ${sql.raw(expired('file'))}
              and oid is distinct from ${exceptOid}::uuid`);
        await tx.query(sql`select set_config('app.branch_oids', ${`{${restoreOids.join(',')}}`}, true)`);
        return Number(row?.used ?? 0);
    },

    get: async (tx: Queryable, oid: string, branchOids: readonly string[], forUpdate = false) => {
        const [found] = await tx.query<FileRow & { storage_key: string }>(sql`
            select f.storage_key, ${COLUMNS}
            where f.oid = ${oid} and f.branch_oid = any (${branchOids}::uuid[])
            ${forUpdate ? sql.raw('for update of f') : sql.raw('')}`);
        return found;
    },

    setStatus: async (
        tx: Queryable,
        oid: string,
        status: FileStatus,
        extra: { size_bytes?: number; content_type?: string; actor?: string | undefined } = {}
    ) => {
        await tx.query(sql`
            update file set status = ${status},
                size_bytes = coalesce(${extra.size_bytes ?? null}::int, size_bytes),
                content_type = coalesce(${extra.content_type ?? null}::text, content_type),
                ready_at = case when ${status} = 'ready' then now() else ready_at end,
                deleted_at = case when ${status} = 'deleted' then now() else deleted_at end,
                deleted_by = case when ${status} = 'deleted' then ${extra.actor ?? null}::uuid else deleted_by end
            where oid = ${oid}`);
    },

    /** Ready documents of one member (the D-069 count). */
    countReady: async (tx: Queryable, memberOid: string, kind: FileKind) => {
        const [row] = await tx.query<{ n: number }>(
            sql`select count(*)::int as n from file where member_oid = ${memberOid} and kind = ${kind} and status = 'ready' and not ${sql.raw(expired('file'))}`
        );
        return row?.n ?? 0;
    },

    forMember: (tx: Queryable, memberOid: string, branchOids: readonly string[]) =>
        tx.query<FileRow>(sql`
            select ${COLUMNS}
            where f.member_oid = ${memberOid} and f.branch_oid = any (${branchOids}::uuid[]) and f.status = 'ready' and not ${sql.raw(expired('f'))}
            order by f.created_at desc`),

    setMember: async (tx: Queryable, oid: string, memberOid: string) => {
        await tx.query(sql`update file set member_oid = ${memberOid} where oid = ${oid}`);
    },

    moveMember: async (tx: Queryable, memberOid: string, toBranchOid: string) => {
        await tx.query(sql`update file set branch_oid = ${toBranchOid} where member_oid = ${memberOid}`);
    },

    deleteMember: async (tx: Queryable, memberOid: string, actor: string) => {
        const rows = await tx.query<{ storage_key: string }>(sql`
            update file set status = 'deleted', deleted_at = now(), deleted_by = ${actor}
            where member_oid = ${memberOid} and status <> 'deleted'
            returning storage_key`);
        return rows.map(r => r.storage_key);
    }
};
