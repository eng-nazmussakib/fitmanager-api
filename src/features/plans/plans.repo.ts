import type { Queryable } from '#src/db/db.ts';
import { type Sql, sql } from '#src/db/sql.ts';

import type { PlanUpdate, PromoCreate, TemplateCreate, TemplateUpdate } from './plans.schema.ts';

/** A plan a branch sells, with what it takes from its template (D-044, migration 009). */
export interface Plan {
    oid: string;
    branch_oid: string;
    template_oid: string;
    code: string;
    /** "Single · 3 Months" */
    name: string;
    tier: string;
    tier_name: string;
    period: string;
    period_label: string;
    months: number;
    price: number;
    admission_fee: number;
    persons: number;
    features: string[];
    featured: boolean;
    /** From the template (D-063). */
    freezable: boolean;
    /** A membership, or a package of PT sessions (D-079). */
    kind: 'membership' | 'pt';
    /** PT sessions in the package; null for a membership. */
    sessions: number | null;
    /** The plan's own switch. */
    active: boolean;
    /** The template's switch: the desk sells a plan only when both are on (`sellable`). */
    template_active: boolean;
    sellable: boolean;
}

export interface PlanTemplate {
    oid: string;
    tier: string;
    tier_name: string;
    period: string;
    period_label: string;
    months: number;
    base_price: number;
    persons: number;
    features: string[];
    featured: boolean;
    freezable: boolean;
    kind: 'membership' | 'pt';
    sessions: number | null;
    sort_order: number;
    active: boolean;
    /** Branches with an active plan from this template. */
    branches_using: number;
}

export interface Promo {
    code: string;
    label: string;
    percent: number | null;
    amount: number | null;
    waive_admission: boolean;
    valid_from: string;
    valid_to: string;
    active: boolean;
}

const PLAN = sql.raw(`p.oid, p.branch_oid, p.template_oid, p.code, t.tier_name || ' · ' || t.period_label as name, t.tier, t.tier_name,
    t.period, t.period_label, t.months, p.price::float8 as price, p.admission_fee::float8 as admission_fee, t.persons, t.features,
    t.featured, t.freezable, t.kind, t.sessions, p.active, t.active as template_active, (p.active and t.active) as sellable
    from plan p join plan_template t on t.oid = p.template_oid`);
const ORDER = sql.raw('order by t.sort_order, t.months, t.tier');
const TEMPLATE = sql.raw(`t.oid, t.tier, t.tier_name, t.period, t.period_label, t.months, t.base_price::float8 as base_price, t.persons,
    t.features, t.featured, t.freezable, t.kind, t.sessions, t.sort_order, t.active,
    (select count(*)::int from plan p where p.template_oid = t.oid and p.active) as branches_using
    from plan_template t`);
const PROMO = sql.raw(`r.code, r.label, r.percent::float8 as percent, r.amount::float8 as amount, r.waive_admission,
    r.valid_from::text as valid_from, r.valid_to::text as valid_to, r.active from promo r`);

const array = (list: readonly string[]) => sql`array(select jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))`;

/** Plans are branch-scoped (RLS): call with a `withBranchTx` transaction. Templates and promos are HQ data, no RLS. */
export const plansRepo = {
    /** `sellableOnly`: what the desk may sell. Each statement filters the branch itself; RLS backs it up. */
    plans: (tx: Queryable, branchOids: readonly string[], sellableOnly: boolean) =>
        tx.query<Plan>(sql`
            select ${PLAN}
            where p.branch_oid = any (${`{${branchOids.join(',')}}`}::uuid[]) ${sellableOnly ? sql`and p.active and t.active` : sql``}
            ${ORDER}`),

    /** One plan, if it belongs to one of `branchOids` (the app filter; RLS backs it up). */
    async plan(tx: Queryable, oid: string, branchOids: readonly string[], forUpdate = false): Promise<Plan | undefined> {
        const [row] = await tx.query<Plan>(sql`
            select ${PLAN}
            where p.oid = ${oid} and p.branch_oid = any (${`{${branchOids.join(',')}}`}::uuid[])
            ${forUpdate ? sql`for update of p` : sql``}`);
        return row;
    },

    async createPlan(tx: Queryable, input: { branch_oid: string; template_oid: string; code: string; price: number; admission_fee: number }, by: string) {
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into plan (branch_oid, template_oid, code, price, admission_fee, updated_by)
            values (${input.branch_oid}, ${input.template_oid}, ${input.code}, ${input.price}, ${input.admission_fee}, ${by})
            returning oid`);
        if (!row) throw new Error('insert returned no row');
        return row.oid;
    },

    async updatePlan(tx: Queryable, oid: string, p: PlanUpdate, by: string): Promise<void> {
        const sets: Sql[] = [];
        if (p.price !== undefined) sets.push(sql`price = ${p.price}::numeric`);
        if (p.admission_fee !== undefined) sets.push(sql`admission_fee = ${p.admission_fee}::numeric`);
        if (p.active !== undefined) sets.push(sql`active = ${p.active}::boolean`);
        await tx.query(sql`update plan set ${sql.join([...sets, sql`updated_at = now()`, sql`updated_by = ${by}`])} where oid = ${oid}`);
    },

    templates: (db: Queryable) => db.query<PlanTemplate>(sql`select ${TEMPLATE} order by t.sort_order, t.months, t.tier`),

    async template(db: Queryable, oid: string, forUpdate = false): Promise<PlanTemplate | undefined> {
        const [row] = await db.query<PlanTemplate>(sql`select ${TEMPLATE} where t.oid = ${oid} ${forUpdate ? sql`for update of t` : sql``}`);
        return row;
    },

    async createTemplate(db: Queryable, hqOid: string, t: TemplateCreate, by: string): Promise<string> {
        const [row] = await db.query<{ oid: string }>(sql`
            insert into plan_template (branch_oid, tier, tier_name, period, period_label, months, base_price, persons, features, featured, freezable,
                sort_order, kind, sessions, updated_by)
            values (${hqOid}, ${t.tier}, ${t.tier_name}, ${t.period}, ${t.period_label}, ${t.months}, ${t.base_price}, ${t.persons},
                ${array(t.features)}, ${t.featured}, ${t.kind === 'pt' ? false : t.freezable}, ${t.sort_order}, ${t.kind}, ${t.kind === 'pt' ? t.sessions : null}, ${by})
            returning oid`);
        if (!row) throw new Error('insert returned no row');
        return row.oid;
    },

    async updateTemplate(db: Queryable, oid: string, t: TemplateUpdate, by: string): Promise<void> {
        const sets: Sql[] = [];
        const simple = {
            tier_name: [t.tier_name, 'text'],
            period_label: [t.period_label, 'text'],
            months: [t.months, 'int'],
            base_price: [t.base_price, 'numeric'],
            persons: [t.persons, 'int'],
            featured: [t.featured, 'boolean'],
            freezable: [t.freezable, 'boolean'],
            sort_order: [t.sort_order, 'int'],
            active: [t.active, 'boolean']
        } as const;
        for (const [column, [value, cast]] of Object.entries(simple))
            if (value !== undefined) sets.push(sql`${sql.raw(column)} = ${value}${sql.raw(`::${cast}`)}`);
        if (t.features !== undefined) sets.push(sql`features = ${array(t.features)}`);
        await db.query(sql`update plan_template set ${sql.join([...sets, sql`updated_at = now()`, sql`updated_by = ${by}`])} where oid = ${oid}`);
    },

    promos: (db: Queryable) => db.query<Promo>(sql`select ${PROMO} order by r.valid_to desc, r.code`),

    async promo(db: Queryable, code: string, forUpdate = false): Promise<Promo | undefined> {
        const [row] = await db.query<Promo>(sql`select ${PROMO} where r.code = ${code} ${forUpdate ? sql`for update` : sql``}`);
        return row;
    },

    async createPromo(db: Queryable, hqOid: string, p: PromoCreate, by: string): Promise<void> {
        await db.query(sql`
            insert into promo (code, branch_oid, label, percent, amount, waive_admission, valid_from, valid_to, updated_by)
            values (${p.code}, ${hqOid}, ${p.label}, ${p.percent ?? null}, ${p.amount ?? null}, ${p.waive_admission ?? false},
                ${p.valid_from}::date, ${p.valid_to}::date, ${by})`);
    },

    async updatePromo(db: Queryable, code: string, merged: Omit<Promo, 'code'>, by: string): Promise<void> {
        await db.query(sql`
            update promo set label = ${merged.label}, percent = ${merged.percent}, amount = ${merged.amount}, waive_admission = ${merged.waive_admission},
                valid_from = ${merged.valid_from}::date, valid_to = ${merged.valid_to}::date, active = ${merged.active},
                updated_at = now(), updated_by = ${by}
            where code = ${code}`);
    }
};
