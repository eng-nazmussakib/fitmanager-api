import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { addDays } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import type { ClauseInput, PolicyCreate, PolicyUpdate, VersionCreate } from './policies.schema.ts';

/**
 * Policies. HQ master data on the HQ row (no RLS, like class types): every branch reads them,
 * only HQ writes them. A version is published the day it is made and never edited; "accept again" versions must be
 * accepted by every member, "wording only" ones need no new acceptance. A member's acceptance names the version, in
 * the portal (a tick) or signed on paper at the desk. Access rule 6 (`member_access_facts`, migration 020) blocks a
 * member who has not accepted a required policy's current "accept again" version once the grace period is over:
 * `policy_grace_days` from the later of its publish date and the member's join date.
 */
export interface PolicyDeps {
    db: Db;
}

export interface ClauseRow {
    oid: string;
    number: string;
    heading: string;
    body: string;
}

export interface VersionRow {
    oid: string;
    policy_oid: string;
    version: number;
    mode: 'accept_again' | 'wording_only';
    change_note: string | null;
    published_on: string;
    published_by_name: string | null;
}

interface PolicyRow {
    oid: string;
    slug: string;
    title: string;
    summary: string | null;
    required: boolean;
    public: boolean;
    sort_order: number;
    active: boolean;
    updated_at: Date;
}

const POLICY = sql.raw(`p.oid, p.slug, p.title, p.summary, p.required, p.public, p.sort_order, p.active, p.updated_at from policy p`);
const VERSION = sql.raw(
    `v.oid, v.policy_oid, v.version, v.mode, v.change_note, v.published_on::text as published_on, v.published_by_name from policy_version v`
);

async function versionsOf(tx: Queryable, policyOids: string[]): Promise<VersionRow[]> {
    if (!policyOids.length) return [];
    return tx.query<VersionRow>(sql`select ${VERSION} where v.policy_oid = any (${policyOids}::uuid[]) order by v.policy_oid, v.version desc`);
}

async function clausesOf(tx: Queryable, versionOid: string): Promise<ClauseRow[]> {
    return tx.query<ClauseRow>(sql`select oid, number, heading, body from policy_clause where version_oid = ${versionOid} order by position`);
}

/** The newest version, and the newest "accept again" one: what a member must have accepted. */
function currentOf(versions: VersionRow[]) {
    const current = versions[0];
    const required = versions.find(x => x.mode === 'accept_again');
    if (!current || !required) throw new Error('A policy without a version');
    return { current, required };
}

async function policyWire(tx: Queryable, p: PolicyRow, versions: VersionRow[], withHistory: boolean) {
    const { current, required } = currentOf(versions);
    return {
        oid: p.oid,
        slug: p.slug,
        title: p.title,
        summary: p.summary,
        required: p.required,
        public: p.public,
        sort_order: p.sort_order,
        active: p.active,
        updated_at: p.updated_at.toISOString(),
        current: { ...current, clauses: await clausesOf(tx, current.oid) },
        required_version: required.version,
        versions: withHistory ? versions : undefined
    };
}

/** `GET /v1/policies` (every staff console; `all=1` for HQ: the inactive ones too). */
export async function listPolicies(deps: PolicyDeps, ctx: BranchContext, all: boolean) {
    return withBranchTx(deps.db, ctx, async tx => {
        const rows = await tx.query<PolicyRow>(sql`select ${POLICY} where ${all} or p.active order by p.sort_order, p.title`);
        const versions = await versionsOf(
            tx,
            rows.map(r => r.oid)
        );
        return Promise.all(
            rows.map(r =>
                policyWire(
                    tx,
                    r,
                    versions.filter(x => x.policy_oid === r.oid),
                    true
                )
            )
        );
    });
}

async function policyIn(tx: Queryable, oid: string) {
    const [p] = await tx.query<PolicyRow>(sql`select ${POLICY} where p.oid = ${oid}`);
    if (!p) throw new AppError(404, 'Policy not found');
    return policyWire(tx, p, await versionsOf(tx, [oid]), true);
}

/** `GET /v1/policies/:oid`: with every version; `?version=` gives that version's clauses. */
export async function getPolicy(deps: PolicyDeps, ctx: BranchContext, oid: string, version: number | null) {
    return withBranchTx(deps.db, ctx, async tx => {
        const p = await policyIn(tx, oid);
        if (version === null) return { ...p, shown: p.current };
        const v = p.versions?.find(x => x.version === version);
        if (!v) throw new AppError(404, 'No such version');
        return { ...p, shown: { ...v, clauses: await clausesOf(tx, v.oid) } };
    });
}

const numbered = (list: ClauseInput[]) => list.map((c, i) => ({ number: c.number ?? String(i + 1), heading: c.heading, body: c.body, position: i + 1 }));

async function insertVersion(
    tx: Queryable,
    ctx: BranchContext,
    policyOid: string,
    version: number,
    input: { mode: 'accept_again' | 'wording_only'; change_note?: string | null | undefined; clauses: ClauseInput[] },
    today: string
) {
    const [row] = await tx.query<{ oid: string }>(sql`
        insert into policy_version (policy_oid, version, mode, change_note, published_on, published_by, published_by_name)
        values (${policyOid}, ${version}, ${input.mode}, ${input.change_note ?? null}, ${today}, ${ctx.actor?.oid ?? null}, ${ctx.actor?.name ?? null})
        returning oid`);
    if (!row) throw new Error('policy_version insert returned nothing');
    for (const c of numbered(input.clauses)) {
        await tx.query(sql`
            insert into policy_clause (version_oid, number, heading, body, position)
            values (${row.oid}, ${c.number}, ${c.heading}, ${c.body}, ${c.position})`);
    }
    return row.oid;
}

/** `POST /v1/hq/policies`: a new policy and its first version ("accept again", as every first version is). */
export async function createPolicy(deps: PolicyDeps, ctx: BranchContext, input: PolicyCreate, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [taken] = await tx.query(sql`select 1 from policy where slug = ${input.slug}`);
        if (taken) throw new AppError(409, 'Another policy has this web address', [{ path: 'slug', message: 'Taken' }]);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into policy (branch_oid, slug, title, summary, required, public, sort_order, updated_by)
            values (${ctx.branchOid}, ${input.slug}, ${input.title}, ${input.summary ?? null}, ${input.required}, ${input.public},
                ${input.sort_order ?? 0}, ${ctx.actor?.oid ?? null})
            returning oid`);
        if (!row) throw new Error('policy insert returned nothing');
        await insertVersion(tx, ctx, row.oid, 1, { mode: 'accept_again', change_note: null, clauses: input.clauses }, today);
        const after = await policyIn(tx, row.oid);
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'policy',
            entityKey: input.slug,
            before: null,
            after: { title: after.title, required: after.required, public: after.public, version: 1, clauses: input.clauses.length }
        });
        return after;
    });
}

/** `PATCH /v1/hq/policies/:oid`: the policy's own fields; the wording changes only by a new version. */
export async function updatePolicy(deps: PolicyDeps, ctx: BranchContext, oid: string, input: PolicyUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await policyIn(tx, oid);
        await tx.query(sql`
            update policy set
                title = coalesce(${input.title ?? null}, title),
                summary = case when ${input.summary !== undefined} then ${input.summary ?? null}::text else summary end,
                required = coalesce(${input.required ?? null}::boolean, required),
                public = coalesce(${input.public ?? null}::boolean, public),
                sort_order = coalesce(${input.sort_order ?? null}::int, sort_order),
                active = coalesce(${input.active ?? null}::boolean, active),
                updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
            where oid = ${oid}`);
        const after = await policyIn(tx, oid);
        const pick = (p: typeof before) => ({
            title: p.title,
            summary: p.summary,
            required: p.required,
            public: p.public,
            sort_order: p.sort_order,
            active: p.active
        });
        await recordAudit(tx, ctx, { action: 'update', entity: 'policy', entityKey: before.slug, before: pick(before), after: pick(after) });
        return after;
    });
}

/** `POST /v1/hq/policies/:oid/versions`: publishes the next version today. */
export async function publishVersion(deps: PolicyDeps, ctx: BranchContext, oid: string, input: VersionCreate, today: string) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await policyIn(tx, oid);
        const next = before.current.version + 1;
        await insertVersion(tx, ctx, oid, next, input, today);
        await tx.query(sql`update policy set updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${oid}`);
        const after = await policyIn(tx, oid);
        await recordAudit(tx, ctx, {
            action: 'publish',
            entity: 'policy_version',
            entityKey: `${before.slug}/v${next}`,
            before: { version: before.current.version },
            after: { version: next, mode: input.mode, change_note: input.change_note ?? null, clauses: input.clauses.length }
        });
        return after;
    });
}

/** Every clause of the current versions, for citing on an incident. */
export async function currentClauses(deps: PolicyDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, tx =>
        tx.query<{ oid: string; policy_title: string; version: number; number: string; heading: string; label: string }>(sql`
            select c.oid, p.title as policy_title, v.version, c.number, c.heading,
                p.title || ' v' || v.version || ' §' || c.number || ': ' || c.heading as label
            from policy p
            join lateral (select oid, version from policy_version where policy_oid = p.oid order by version desc limit 1) v on true
            join policy_clause c on c.version_oid = v.oid
            where p.active
            order by p.sort_order, c.position`)
    );
}

/* ---------- the public site ---------- */

/** `GET /v1/public/policies`: the public ones, for the footer and the index. */
export async function publicPolicies(db: Db) {
    return db.query<{ slug: string; title: string; summary: string | null; version: number; published_on: string }>(sql`
        select p.slug, p.title, p.summary, v.version, v.published_on::text as published_on
        from policy p
        join lateral (select version, published_on from policy_version where policy_oid = p.oid order by version desc limit 1) v on true
        where p.public and p.active order by p.sort_order, p.title`);
}

/** `GET /v1/public/policies/:slug`: the current wording and the version history (no names). */
export async function publicPolicy(db: Db, slug: string) {
    const [p] = await db.query<PolicyRow>(sql`select ${POLICY} where p.slug = ${slug} and p.public and p.active`);
    if (!p) throw new AppError(404, 'Policy not found');
    const versions = await versionsOf(db, [p.oid]);
    const { current } = currentOf(versions);
    return {
        slug: p.slug,
        title: p.title,
        summary: p.summary,
        version: current.version,
        published_on: current.published_on,
        clauses: (await clausesOf(db, current.oid)).map(({ number, heading, body }) => ({ number, heading, body })),
        history: versions.map(x => ({ version: x.version, mode: x.mode, change_note: x.change_note, published_on: x.published_on }))
    };
}

/* ---------- a member's acceptances ---------- */

export type PolicyState = 'accepted' | 'due' | 'overdue' | 'optional';

export interface MemberPolicy {
    policy_oid: string;
    slug: string;
    title: string;
    summary: string | null;
    required: boolean;
    current_version: number;
    current_version_oid: string;
    required_version: number;
    /** What changed in the version to accept, when it is not the first. */
    change_note: string | null;
    accepted_version: number | null;
    accepted_at: string | null;
    method: 'portal' | 'paper' | null;
    recorded_by_name: string | null;
    state: PolicyState;
    /** The first day check-in is blocked without it, while it is due or overdue. */
    blocks_on: string | null;
}

/** Each active policy and where the member stands with it, at their home branch (the caller's transaction). */
export async function memberPolicies(tx: Queryable, member: { oid: string; joined_on: string }, today: string): Promise<MemberPolicy[]> {
    const [settings] = await tx.query<{ grace: number }>(sql`select policy_grace_days as grace from org_settings`);
    const grace = settings?.grace ?? 14;
    const policies = await tx.query<PolicyRow>(sql`select ${POLICY} where p.active order by p.sort_order, p.title`);
    const versions = await versionsOf(
        tx,
        policies.map(p => p.oid)
    );
    const accepted = await tx.query<{
        policy_oid: string;
        version: number;
        accepted_at: Date;
        method: 'portal' | 'paper';
        recorded_by_name: string | null;
    }>(sql`
        select distinct on (policy_oid) policy_oid, version, accepted_at, method, recorded_by_name
        from policy_acceptance where member_oid = ${member.oid} order by policy_oid, version desc`);
    return policies.map(p => {
        const { current, required } = currentOf(versions.filter(x => x.policy_oid === p.oid));
        const a = accepted.find(x => x.policy_oid === p.oid) ?? null;
        const ok = a !== null && a.version >= required.version;
        const blocksOn = addDays(required.published_on > member.joined_on ? required.published_on : member.joined_on, grace);
        const state: PolicyState = ok ? 'accepted' : !p.required ? 'optional' : blocksOn <= today ? 'overdue' : 'due';
        return {
            policy_oid: p.oid,
            slug: p.slug,
            title: p.title,
            summary: p.summary,
            required: p.required,
            current_version: current.version,
            current_version_oid: current.oid,
            required_version: required.version,
            change_note: a && required.version > 1 ? required.change_note : null,
            accepted_version: a?.version ?? null,
            accepted_at: a?.accepted_at.toISOString() ?? null,
            method: a?.method ?? null,
            recorded_by_name: a?.recorded_by_name ?? null,
            state,
            blocks_on: state === 'due' || state === 'overdue' ? blocksOn : null
        };
    });
}

/**
 * Records the member's acceptance of the CURRENT version of each policy named (or of each not yet accepted), in the
 * caller's transaction, with an audit row. Returns how many were recorded.
 */
export async function acceptPolicies(
    tx: Queryable,
    ctx: BranchContext,
    member: { oid: string; code: string; joined_on: string },
    method: 'portal' | 'paper',
    today: string,
    only: { policyOids?: string[] | undefined; versionOid?: string | undefined } = {}
): Promise<number> {
    const list = await memberPolicies(tx, member, today);
    let chosen = list.filter(p => p.accepted_version !== p.current_version);
    if (only.policyOids) {
        const unknown = only.policyOids.filter(oid => !list.some(p => p.policy_oid === oid));
        if (unknown.length) throw new AppError(404, 'Policy not found');
        chosen = chosen.filter(p => only.policyOids?.includes(p.policy_oid));
    }
    if (only.versionOid) {
        const p = list.find(x => x.current_version_oid === only.versionOid);
        if (!p) throw new AppError(409, 'This is not the current version. Reload the page to read the new one.');
        chosen = chosen.filter(x => x.policy_oid === p.policy_oid);
    }
    for (const p of chosen) {
        await tx.query(sql`
            insert into policy_acceptance (branch_oid, member_oid, policy_oid, version_oid, version, method, recorded_by, recorded_by_name)
            values (${ctx.branchOid}, ${member.oid}, ${p.policy_oid}, ${p.current_version_oid}, ${p.current_version}, ${method},
                ${method === 'paper' ? (ctx.actor?.oid ?? null) : null}, ${method === 'paper' ? (ctx.actor?.name ?? null) : null})
            on conflict (member_oid, version_oid) do nothing`);
    }
    if (chosen.length) {
        await recordAudit(tx, ctx, {
            action: 'accept',
            entity: 'policy_acceptance',
            entityKey: member.code,
            before: null,
            after: { method, policies: chosen.map(p => `${p.slug} v${p.current_version}`) }
        });
    }
    return chosen.length;
}

/** The member at this branch (home): the policies they work by. */
export async function memberFor(tx: Queryable, ctx: BranchContext, memberOid: string) {
    const [m] = await tx.query<{ oid: string; code: string; joined_on: string; anonymised: boolean }>(sql`
        select oid, code, joined_on::text as joined_on, anonymised_at is not null as anonymised
        from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid}`);
    if (!m || m.anonymised) throw new AppError(404, 'Member not found');
    return m;
}
