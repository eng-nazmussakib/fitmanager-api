import type { Db, Queryable } from '#src/db/db.ts';
import { pgErrorCode, sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { filesRepo } from '#src/features/files/files.repo.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { readOrgRules } from '#src/features/settings/settings.routes.ts';
import type { FileStore } from '#src/lib/file-store.ts';
import { AppError } from '#src/lib/http.ts';

import type { ProductCreate, ProductQuery, ProductUpdate, SupplierCreate, SupplierUpdate } from './catalogue.schema.ts';

/**
 * The catalogue and suppliers (phase 6, D-099): HQ master data on the HQ row (no RLS, like class types and policies):
 * every branch reads them, only HQ writes them (CASL, at HQ). Prices are HQ's; branches never override them. A
 * product's VAT rate is its own, or the HQ rate in force when it has none. Up to 3 photos (`product_photo`, uploaded at
 * HQ). Products and suppliers are switched off, never deleted, so old invoices and orders keep naming them.
 */
export interface CatalogueDeps {
    db: Db;
    files: FileStore;
    jwtSecret: string;
    apiPrefix: string;
}

type Links = Pick<CatalogueDeps, 'jwtSecret' | 'apiPrefix'>;

export interface ProductRow {
    oid: string;
    branch_oid: string;
    code: string;
    name: string;
    category: string;
    unit: string;
    description: string | null;
    price: number;
    vat_rate: number | null;
    photo_file_oids: string[];
    supplier_oid: string | null;
    supplier_name: string | null;
    reorder_level: number;
    active: boolean;
    updated_at: Date;
}

export interface SupplierRow {
    oid: string;
    name: string;
    contact_name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    active: boolean;
    products: number;
    updated_at: Date;
}

export const PRODUCT = sql.raw(`p.oid, p.branch_oid, p.code, p.name, p.category, p.unit, p.description, p.price::float8 as price,
    p.vat_rate::float8 as vat_rate, p.photo_file_oids, p.supplier_oid, s.name as supplier_name, p.reorder_level, p.active, p.updated_at
    from product p left join supplier s on s.oid = p.supplier_oid`);

const SUPPLIER = sql.raw(`s.oid, s.name, s.contact_name, s.phone, s.email, s.address, s.notes, s.active, s.updated_at,
    (select count(*)::int from product p where p.supplier_oid = s.oid and p.active) as products
    from supplier s`);

export const catalogueRepo = {
    products: (tx: Queryable, all: boolean) => tx.query<ProductRow>(sql`select ${PRODUCT} ${all ? sql`` : sql`where p.active`} order by p.name`),
    product: async (tx: Queryable, oid: string) => (await tx.query<ProductRow>(sql`select ${PRODUCT} where p.oid = ${oid}`))[0],
    productsByOid: (tx: Queryable, oids: readonly string[]) =>
        oids.length ? tx.query<ProductRow>(sql`select ${PRODUCT} where p.oid = any (${oids}::uuid[])`) : Promise.resolve([] as ProductRow[]),
    suppliers: (tx: Queryable, all: boolean) => tx.query<SupplierRow>(sql`select ${SUPPLIER} ${all ? sql`` : sql`where s.active`} order by s.name`),
    supplier: async (tx: Queryable, oid: string) => (await tx.query<SupplierRow>(sql`select ${SUPPLIER} where s.oid = ${oid}`))[0]
};

/** The VAT rate a product is sold at: its own, or HQ's. */
export const effectiveVat = (p: Pick<ProductRow, 'vat_rate'>, hqRate: number): number => p.vat_rate ?? hqRate;

export async function photoLinks(deps: Links, p: Pick<ProductRow, 'photo_file_oids' | 'branch_oid'>) {
    return Promise.all(p.photo_file_oids.map(async oid => ({ file_oid: oid, url: await viewUrl(deps, { oid, branch_oid: p.branch_oid }) })));
}

export async function productWire(deps: Links, p: ProductRow, hqRate: number) {
    return {
        oid: p.oid,
        code: p.code,
        name: p.name,
        category: p.category,
        unit: p.unit,
        description: p.description,
        price: p.price,
        vat_rate: p.vat_rate,
        vat_rate_applied: effectiveVat(p, hqRate),
        photos: await photoLinks(deps, p),
        supplier_oid: p.supplier_oid,
        supplier_name: p.supplier_name,
        reorder_level: p.reorder_level,
        active: p.active,
        updated_at: p.updated_at.toISOString()
    };
}

const supplierWire = (s: SupplierRow) => ({ ...s, updated_at: s.updated_at.toISOString() });

const matches = (p: ProductRow, q: ProductQuery): boolean =>
    (!q.q || p.name.toLowerCase().includes(q.q.toLowerCase()) || p.code.toLowerCase().includes(q.q.toLowerCase())) &&
    (!q.category || p.category === q.category);

/** `GET /v1/products`: the active catalogue (`all=1`: switched-off ones too, for HQ). */
export async function listProducts(deps: CatalogueDeps, ctx: BranchContext, q: ProductQuery) {
    const { rows, rate } = await withBranchTx(deps.db, ctx, async tx => ({
        rows: await catalogueRepo.products(tx, q.all === '1'),
        rate: (await readOrgRules(tx)).vat_rate
    }));
    return Promise.all(rows.filter(p => matches(p, q)).map(p => productWire(deps, p, rate)));
}

export async function getProduct(deps: CatalogueDeps, ctx: BranchContext, oid: string) {
    const { row, rate } = await withBranchTx(deps.db, ctx, async tx => ({
        row: await catalogueRepo.product(tx, oid),
        rate: (await readOrgRules(tx)).vat_rate
    }));
    if (!row) throw new AppError(404, 'Product not found');
    return productWire(deps, row, rate);
}

const duplicate =
    (what: string) =>
    (err: unknown): never => {
        if (pgErrorCode(err) === '23505') throw new AppError(409, `A ${what} with this name exists`, [{ path: 'name', message: 'Already in the list' }]);
        throw err;
    };

async function checkSupplier(tx: Queryable, oid: string | null | undefined): Promise<void> {
    if (!oid) return;
    const s = await catalogueRepo.supplier(tx, oid);
    if (!s?.active) throw new AppError(400, 'Choose an active supplier', [{ path: 'supplier_oid', message: 'Unknown supplier' }]);
}

/** Marks photos no longer used deleted, and returns their storage keys (removed from the store after the commit). */
async function dropFiles(tx: Queryable, ctx: BranchContext, oids: readonly string[]): Promise<string[]> {
    const keys: string[] = [];
    for (const oid of oids) {
        const row = await filesRepo.get(tx, oid, [ctx.branchOid], true);
        if (!row || row.status === 'deleted') continue;
        await filesRepo.setStatus(tx, oid, 'deleted', { actor: ctx.actor?.oid });
        await recordAudit(tx, ctx, { action: 'delete', entity: 'file', entityKey: oid, before: { kind: row.kind, name: row.name }, after: null });
        keys.push(row.storage_key);
    }
    return keys;
}

export async function createProduct(deps: CatalogueDeps, ctx: BranchContext, input: ProductCreate) {
    const { row, rate } = await withBranchTx(deps.db, ctx, async tx => {
        await checkSupplier(tx, input.supplier_oid);
        for (const f of input.photo_file_oids ?? []) await claimKindFile(tx, ctx.branchOid, f, 'product_photo');
        const [seq] = await tx.query<{ value: number }>(sql`
            insert into branch_counter (branch_oid, name, value) values (${ctx.branchOid}, 'product', 1)
            on conflict (branch_oid, name) do update set value = branch_counter.value + 1 returning value`);
        const code = `PRD-${String(seq?.value ?? 0).padStart(6, '0')}`;
        const [created] = await tx
            .query<{ oid: string }>(
                sql`
                insert into product (branch_oid, code, name, category, unit, description, price, vat_rate, photo_file_oids, supplier_oid, reorder_level,
                    active, updated_by)
                values (${ctx.branchOid}, ${code}, ${input.name}, ${input.category}, ${input.unit}, ${input.description ?? null}, ${input.price},
                    ${input.vat_rate ?? null}, ${input.photo_file_oids ?? []}::uuid[], ${input.supplier_oid ?? null}, ${input.reorder_level ?? 5},
                    ${input.active ?? true}, ${ctx.actor?.oid ?? null})
                returning oid`
            )
            .catch(duplicate('product'));
        const saved = created && (await catalogueRepo.product(tx, created.oid));
        if (!saved) throw new Error('Product missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'create', entity: 'product', entityKey: saved.code, before: null, after: saved });
        return { row: saved, rate: (await readOrgRules(tx)).vat_rate };
    });
    return productWire(deps, row, rate);
}

export async function updateProduct(deps: CatalogueDeps, ctx: BranchContext, oid: string, input: ProductUpdate) {
    const { row, rate, keys } = await withBranchTx(deps.db, ctx, async tx => {
        const before = await catalogueRepo.product(tx, oid);
        if (!before) throw new AppError(404, 'Product not found');
        if (input.supplier_oid !== undefined && input.supplier_oid !== before.supplier_oid) await checkSupplier(tx, input.supplier_oid);
        const photos = input.photo_file_oids ?? before.photo_file_oids;
        for (const f of photos.filter(x => !before.photo_file_oids.includes(x))) await claimKindFile(tx, ctx.branchOid, f, 'product_photo');
        await tx
            .query(
                sql`
                update product set
                    name = ${input.name ?? before.name},
                    category = ${input.category ?? before.category},
                    unit = ${input.unit ?? before.unit},
                    description = ${input.description === undefined ? before.description : input.description},
                    price = ${input.price ?? before.price},
                    vat_rate = ${input.vat_rate === undefined ? before.vat_rate : input.vat_rate},
                    photo_file_oids = ${photos}::uuid[],
                    supplier_oid = ${input.supplier_oid === undefined ? before.supplier_oid : input.supplier_oid},
                    reorder_level = ${input.reorder_level ?? before.reorder_level},
                    active = ${input.active ?? before.active},
                    updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid}`
            )
            .catch(duplicate('product'));
        const after = await catalogueRepo.product(tx, oid);
        if (!after) throw new Error('Product missing inside its own transaction');
        const action = input.active === false && before.active ? 'deactivate' : input.active === true && !before.active ? 'activate' : 'update';
        await recordAudit(tx, ctx, { action, entity: 'product', entityKey: before.code, before, after });
        const dropped = await dropFiles(
            tx,
            ctx,
            before.photo_file_oids.filter(f => !photos.includes(f))
        );
        return { row: after, rate: (await readOrgRules(tx)).vat_rate, keys: dropped };
    });
    for (const k of keys) await deps.files.delete(k).catch(() => undefined);
    return productWire(deps, row, rate);
}

/* ---------- suppliers ---------- */

export async function listSuppliers(deps: Pick<CatalogueDeps, 'db'>, ctx: BranchContext, all: boolean) {
    return (await withBranchTx(deps.db, ctx, tx => catalogueRepo.suppliers(tx, all))).map(supplierWire);
}

export async function createSupplier(deps: Pick<CatalogueDeps, 'db'>, ctx: BranchContext, input: SupplierCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [created] = await tx
            .query<{ oid: string }>(
                sql`
                insert into supplier (branch_oid, name, contact_name, phone, email, address, notes, active, updated_by)
                values (${ctx.branchOid}, ${input.name}, ${input.contact_name ?? null}, ${input.phone ?? null}, ${input.email ?? null},
                    ${input.address ?? null}, ${input.notes ?? null}, ${input.active ?? true}, ${ctx.actor?.oid ?? null})
                returning oid`
            )
            .catch(duplicate('supplier'));
        const saved = created && (await catalogueRepo.supplier(tx, created.oid));
        if (!saved) throw new Error('Supplier missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'create', entity: 'supplier', entityKey: saved.name, before: null, after: saved });
        return supplierWire(saved);
    });
}

export async function updateSupplier(deps: Pick<CatalogueDeps, 'db'>, ctx: BranchContext, oid: string, input: SupplierUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await catalogueRepo.supplier(tx, oid);
        if (!before) throw new AppError(404, 'Supplier not found');
        const pick = <K extends keyof SupplierUpdate & keyof SupplierRow>(k: K) => (input[k] === undefined ? before[k] : input[k]);
        await tx
            .query(
                sql`
                update supplier set name = ${pick('name')}, contact_name = ${pick('contact_name')}, phone = ${pick('phone')}, email = ${pick('email')},
                    address = ${pick('address')}, notes = ${pick('notes')}, active = ${pick('active')}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
                where oid = ${oid}`
            )
            .catch(duplicate('supplier'));
        const after = await catalogueRepo.supplier(tx, oid);
        if (!after) throw new Error('Supplier missing inside its own transaction');
        await recordAudit(tx, ctx, { action: 'update', entity: 'supplier', entityKey: before.name, before, after });
        return supplierWire(after);
    });
}
