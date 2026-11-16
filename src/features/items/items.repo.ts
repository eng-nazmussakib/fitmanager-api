import type { Queryable } from '#src/db/db.ts';
import { containsPattern, pgErrorCode, sql } from '#src/db/sql.ts';
import { AppError } from '#src/lib/http.ts';

import { type ItemFilter, type ItemListQuery, type ItemPayload, SORT_COLUMNS } from './items.schema.ts';

export interface Item {
    oid: string;
    code: string;
    name_en: string;
    category_oid: string;
    category_en: string;
    contact_mobile: string;
    effective_date: string;
    amount: number;
    status: 'Active' | 'Inactive';
    attachment: string | null;
    lines: { label: string; value: string }[];
    created_at: string;
    updated_at: string;
}

/**
 * Two classic pg pitfalls handled in the SELECT:
 * - `date` columns: node-postgres turns them into a JS Date at LOCAL midnight, so a server in UTC sends the
 *   previous day to Dhaka. `::text` keeps it as 'YYYY-MM-DD'.
 * - `numeric` comes back as a string (it can exceed a double). `::float8` is fine for amounts of this size.
 */
const SELECT = sql.raw(`
    select i.oid, i.code, i.name_en, i.category_oid, c.name_en as category_en,
           i.contact_mobile, i.effective_date::text as effective_date, i.amount::float8 as amount, i.status,
           i.attachment, i.lines, i.created_at, i.updated_at
    from item i join category c on c.oid = i.category_oid`);

function where(f: ItemFilter) {
    const pattern = f.search_text ? containsPattern(f.search_text) : undefined;
    return sql.where([
        pattern !== undefined && sql`(i.name_en ilike ${pattern} or i.code ilike ${pattern})`,
        f.status !== undefined && sql`i.status = ${f.status}`,
        f.category_oid !== undefined && sql`i.category_oid = ${f.category_oid}`
    ]);
}

/** Unique-name and unknown-category violations become 409 / 400 instead of a 500. */
function translate(err: unknown): never {
    const code = pgErrorCode(err);
    if (code === '23505') throw new AppError(409, 'An item with this name already exists');
    if (code === '23503') throw new AppError(400, 'Unknown category', [{ path: 'category_oid', message: 'Unknown category' }]);
    throw err;
}

export const itemsRepo = {
    async list(db: Queryable, q: ItemListQuery): Promise<{ rows: Item[]; count: number }> {
        const order = q.sort_by ? sql.raw(`${SORT_COLUMNS[q.sort_by]} ${q.sort_order}, i.oid`) : sql.raw('i.created_at desc, i.oid');
        const filter = where(q);
        const rows = await db.query<Item>(sql`${SELECT} where ${filter} order by ${order} limit ${q.limit} offset ${q.offset}`);
        const [total] = await db.query<{ count: number }>(sql`select count(*)::int as count from item i where ${filter}`);
        return { rows, count: total?.count ?? 0 };
    },

    /** For exports: every matching row, capped. Stream with a cursor (pg-query-stream) if you need more. */
    async all(db: Queryable, f: ItemFilter, cap = 50_000): Promise<Item[]> {
        return db.query<Item>(sql`${SELECT} where ${where(f)} order by i.code limit ${cap}`);
    },

    async find(db: Queryable, oid: string): Promise<Item | undefined> {
        const [row] = await db.query<Item>(sql`${SELECT} where i.oid = ${oid}`);
        return row;
    },

    async create(db: Queryable, p: ItemPayload, userOid: string): Promise<string> {
        const [row] = await db
            .query<{ oid: string }>(
                sql`insert into item (name_en, category_oid, contact_mobile, effective_date, amount, status, attachment, lines, created_by, updated_by)
                    values (${p.name_en}, ${p.category_oid}, ${p.contact_mobile}, ${p.effective_date}, ${p.amount}, ${p.status},
                            ${p.attachment}, ${JSON.stringify(p.lines)}, ${userOid}, ${userOid})
                    returning oid`
            )
            .catch(translate);
        if (!row) throw new Error('insert returned no row');
        return row.oid;
    },

    async update(db: Queryable, oid: string, p: ItemPayload, userOid: string): Promise<boolean> {
        const rows = await db
            .query(
                sql`update item set name_en = ${p.name_en}, category_oid = ${p.category_oid}, contact_mobile = ${p.contact_mobile},
                        effective_date = ${p.effective_date}, amount = ${p.amount}, status = ${p.status}, attachment = ${p.attachment},
                        lines = ${JSON.stringify(p.lines)}, updated_by = ${userOid}, updated_at = now()
                    where oid = ${oid} returning oid`
            )
            .catch(translate);
        return rows.length > 0;
    },

    async remove(db: Queryable, oid: string): Promise<boolean> {
        return (await db.query(sql`delete from item where oid = ${oid} returning oid`)).length > 0;
    }
};
