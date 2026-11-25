import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, systemContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimKindFile, viewUrl } from '#src/features/files/files.service.ts';
import { addDays, dhakaIso, dhakaNow } from '#src/lib/clock.ts';
import { AppError } from '#src/lib/http.ts';

import { overlaps, WEEKDAY_NAMES } from './hours.ts';
import { schedulingRepo, type TrainerRow } from './scheduling.repo.ts';
import type { TrainerCreate, TrainerUpdate } from './scheduling.schema.ts';

/**
 * Trainers: a profile on a staff account with the TRAINER role, owned by its home branch, with a
 * public page; weekly availability per branch (for PT), days off, and assigned clients. A trainer edits only their
 * own profile and availability (`self`); a branch manager or HQ edits any at the branch.
 */
export interface SchedulingDeps {
    db: Db;
    jwtSecret: string;
    apiPrefix: string;
}

/** Who is asking: `selfOnly` = a trainer without `manage Trainer`, limited to their own profile. */
export interface Caller {
    userOid: string;
    selfOnly: boolean;
}

export async function photoUrl(deps: Pick<SchedulingDeps, 'jwtSecret' | 'apiPrefix'>, t: Pick<TrainerRow, 'photo_file_oid' | 'photo_asset' | 'branch_oid'>) {
    if (t.photo_file_oid) return viewUrl(deps, { oid: t.photo_file_oid, branch_oid: t.branch_oid });
    return t.photo_asset;
}

/** The staff view of a trainer. */
export async function trainerWire(deps: Pick<SchedulingDeps, 'jwtSecret' | 'apiPrefix'>, t: TrainerRow) {
    return {
        oid: t.oid,
        branch_oid: t.branch_oid,
        branch_name: t.branch_name,
        user_oid: t.user_oid,
        username: t.username,
        name: t.name,
        slug: t.slug,
        gender: t.gender,
        phone: t.phone,
        headline: t.headline,
        bio: t.bio,
        specialties: t.specialties,
        certifications: t.certifications,
        photo_url: await photoUrl(deps, t),
        photo_file_oid: t.photo_file_oid,
        public: t.public,
        active: t.active,
        can_sign_in: t.can_sign_in,
        clients: t.clients
    };
}

/** What anyone may see: no phone, no account. */
export async function publicTrainerWire(deps: Pick<SchedulingDeps, 'jwtSecret' | 'apiPrefix'>, t: TrainerRow) {
    return {
        oid: t.oid,
        branch_oid: t.branch_oid,
        branch_name: t.branch_name,
        name: t.name,
        slug: t.slug,
        gender: t.gender,
        headline: t.headline,
        bio: t.bio,
        specialties: t.specialties,
        certifications: t.certifications,
        photo_url: await photoUrl(deps, t),
        phone: ''
    };
}

export async function listTrainers(deps: SchedulingDeps, ctx: BranchContext) {
    const rows = await withBranchTx(deps.db, ctx, tx => schedulingRepo.trainers(tx, [ctx.branchOid]));
    return Promise.all(rows.map(r => trainerWire(deps, r)));
}

async function trainerAt(tx: Queryable, ctx: BranchContext, oid: string, forUpdate = false) {
    const t = await schedulingRepo.trainer(tx, oid, [ctx.branchOid], forUpdate);
    if (!t) throw new AppError(404, 'Trainer not found');
    return t;
}

function own(t: TrainerRow, caller: Caller) {
    if (caller.selfOnly && t.user_oid !== caller.userOid) throw new AppError(403, 'Trainers change only their own profile');
}

function home(t: TrainerRow, ctx: BranchContext) {
    if (t.branch_oid !== ctx.branchOid) throw new AppError(409, `Change ${t.name}'s profile at their home branch, ${t.branch_name}.`);
}

/** The profile, this branch's availability, days off ahead, clients here, and the next two weeks' classes and PT. */
export async function trainerDetail(deps: SchedulingDeps, ctx: BranchContext, oid: string, now: { date: string; at: Date }) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await trainerAt(tx, ctx, oid);
        const [availability, leave, clients, upcoming] = await Promise.all([
            schedulingRepo.availability(tx, t.oid, ctx.branchOid),
            schedulingRepo.leave(tx, t.oid, now.date),
            schedulingRepo.clients(tx, t.oid, ctx.branchOid),
            tx.query<{ kind: string; oid: string; title: string; starts_at: Date; ends_at: Date; room_name: string | null }>(sql`
                select 'class' as kind, c.oid, c.title, c.starts_at, c.ends_at, c.room_name from class_session c
                where c.trainer_oid = ${t.oid} and c.branch_oid = ${ctx.branchOid} and c.cancelled_at is null
                  and c.starts_at >= ${now.at} and c.starts_at < ${now.at}::timestamptz + interval '14 days'
                union all
                select 'pt', p.oid, 'PT with ' || p.member_name, p.starts_at, p.ends_at, p.room_name from pt_session p
                where p.trainer_oid = ${t.oid} and p.branch_oid = ${ctx.branchOid} and p.status = 'Booked'
                  and p.starts_at >= ${now.at} and p.starts_at < ${now.at}::timestamptz + interval '14 days'
                order by 4 limit 40`)
        ]);
        return {
            ...(await trainerWire(deps, t)),
            availability,
            leave,
            client_list: await Promise.all(
                clients.map(async c => ({
                    oid: c.oid,
                    code: c.code,
                    name: c.name,
                    photo_url: c.photo_file_oid ? await viewUrl(deps, { oid: c.photo_file_oid, branch_oid: c.branch_oid }) : null
                }))
            ),
            upcoming: upcoming.map(u => ({ ...u, starts_at: dhakaIso(u.starts_at), ends_at: dhakaIso(u.ends_at) }))
        };
    });
}

export async function trainerCandidates(deps: SchedulingDeps, ctx: BranchContext) {
    return withBranchTx(deps.db, ctx, tx => schedulingRepo.candidates(tx, ctx.branchOid));
}

async function slugFree(tx: Queryable, slug: string, except: string | null) {
    const [row] = await tx.query<{ taken: boolean }>(
        sql`select exists (select from trainer where slug = ${slug} and oid is distinct from ${except}::uuid) as taken`
    );
    if (row?.taken) throw new AppError(409, 'Another trainer has this web address', [{ path: 'slug', message: 'Taken' }]);
}

export async function createTrainer(deps: SchedulingDeps, ctx: BranchContext, input: TrainerCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const candidate = (await schedulingRepo.candidates(tx, ctx.branchOid)).find(c => c.user_oid === input.user_oid);
        if (!candidate) throw new AppError(409, 'Give the staff member the Trainer role at this branch first; each trainer has one profile.');
        await slugFree(tx, input.slug, null);
        if (input.photo_file_oid) await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'trainer_photo');
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into trainer (branch_oid, user_oid, slug, gender, phone, headline, bio, specialties, certifications, photo_file_oid, public, updated_by)
            values (${ctx.branchOid}, ${input.user_oid}, ${input.slug}, ${input.gender}, ${input.phone ?? null}, ${input.headline ?? null}, ${input.bio ?? null},
                array(select jsonb_array_elements_text(${JSON.stringify(input.specialties ?? [])}::jsonb)), ${JSON.stringify(input.certifications ?? [])}::jsonb,
                ${input.photo_file_oid ?? null}, ${input.public ?? true}, ${ctx.actor?.oid ?? null})
            returning oid`);
        if (!row) throw new Error('trainer insert returned no row');
        const t = await trainerAt(tx, ctx, row.oid);
        const after = await trainerWire(deps, t);
        await recordAudit(tx, ctx, { action: 'create', entity: 'trainer', entityKey: t.slug, before: null, after: { ...after, photo_url: undefined } });
        return after;
    });
}

export async function updateTrainer(deps: SchedulingDeps, ctx: BranchContext, oid: string, input: TrainerUpdate, caller: Caller) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await trainerAt(tx, ctx, oid, true);
        own(t, caller);
        home(t, ctx);
        if (caller.selfOnly && (input.active !== undefined || input.slug !== undefined))
            throw new AppError(403, 'A manager changes the web address and whether the profile is active');
        if (input.slug) await slugFree(tx, input.slug, t.oid);
        if (input.photo_file_oid) await claimKindFile(tx, ctx.branchOid, input.photo_file_oid, 'trainer_photo');
        const set = (key: keyof TrainerUpdate) => input[key] !== undefined;
        await tx.query(sql`
            update trainer set
                slug = case when ${set('slug')} then ${input.slug ?? null}::text else slug end,
                gender = case when ${set('gender')} then ${input.gender ?? null}::text else gender end,
                phone = case when ${set('phone')} then ${input.phone ?? null}::text else phone end,
                headline = case when ${set('headline')} then ${input.headline ?? null}::text else headline end,
                bio = case when ${set('bio')} then ${input.bio ?? null}::text else bio end,
                specialties = case when ${set('specialties')} then array(select jsonb_array_elements_text(${JSON.stringify(input.specialties ?? [])}::jsonb)) else specialties end,
                certifications = case when ${set('certifications')} then ${JSON.stringify(input.certifications ?? [])}::jsonb else certifications end,
                photo_file_oid = case when ${set('photo_file_oid')} then ${input.photo_file_oid ?? null}::uuid else photo_file_oid end,
                public = coalesce(${input.public ?? null}::boolean, public),
                active = coalesce(${input.active ?? null}::boolean, active),
                updated_at = now(), updated_by = ${ctx.actor?.oid ?? null}
            where oid = ${t.oid} and branch_oid = ${ctx.branchOid}`);
        const after = await trainerAt(tx, ctx, t.oid);
        const strip = (r: TrainerRow) => ({ ...r, clients: undefined, can_sign_in: undefined });
        await recordAudit(tx, ctx, { action: 'update', entity: 'trainer', entityKey: after.slug, before: strip(t), after: strip(after) });
        return trainerWire(deps, after);
    });
}

/** Replaces the trainer's weekly slots at THIS branch. Slots on one day may not overlap. */
export async function setAvailability(
    deps: SchedulingDeps,
    ctx: BranchContext,
    oid: string,
    slots: { weekday: number; start_time: string; end_time: string }[],
    caller: Caller
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await trainerAt(tx, ctx, oid, true);
        own(t, caller);
        if (!(await schedulingRepo.worksAt(tx, t.oid, ctx.branchOid))) throw new AppError(409, `${t.name} does not work at this branch.`);
        slots.forEach((a, i) => {
            const clash = slots.findIndex((b, j) => j !== i && a.weekday === b.weekday && overlaps(a.start_time, a.end_time, b.start_time, b.end_time));
            if (clash >= 0)
                throw new AppError(400, `Two slots overlap on ${WEEKDAY_NAMES[a.weekday] ?? 'a day'}`, [
                    { path: `slots.${i}.start_time`, message: 'Overlaps' }
                ]);
        });
        const before = await schedulingRepo.availability(tx, t.oid, ctx.branchOid);
        await tx.query(sql`delete from trainer_availability where trainer_oid = ${t.oid} and branch_oid = ${ctx.branchOid}`);
        for (const s of slots)
            await tx.query(sql`
                insert into trainer_availability (branch_oid, trainer_oid, weekday, start_time, end_time)
                values (${ctx.branchOid}, ${t.oid}, ${s.weekday}, ${s.start_time}::time, ${s.end_time}::time)`);
        const after = await schedulingRepo.availability(tx, t.oid, ctx.branchOid);
        await recordAudit(tx, ctx, { action: 'set_availability', entity: 'trainer', entityKey: t.slug, before, after });
        return after;
    });
}

export async function addLeave(
    deps: SchedulingDeps,
    ctx: BranchContext,
    oid: string,
    input: { from_date: string; to_date: string; reason?: string | null | undefined },
    caller: Caller
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await trainerAt(tx, ctx, oid, true);
        own(t, caller);
        home(t, ctx);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into trainer_leave (branch_oid, trainer_oid, from_date, to_date, reason, created_by)
            values (${ctx.branchOid}, ${t.oid}, ${input.from_date}::date, ${input.to_date}::date, ${input.reason ?? null}, ${ctx.actor?.oid ?? null})
            returning oid`);
        const booked = await tx.query<{ n: number }>(sql`
            select count(*)::int as n from pt_session where trainer_oid = ${t.oid} and status = 'Booked'
              and (starts_at at time zone 'Asia/Dhaka')::date between ${input.from_date}::date and ${input.to_date}::date`);
        await recordAudit(tx, ctx, { action: 'add_leave', entity: 'trainer', entityKey: t.slug, before: null, after: { ...input, oid: row?.oid } });
        return { oid: row?.oid ?? null, ...input, reason: input.reason ?? null, pt_sessions_to_move: booked[0]?.n ?? 0 };
    });
}

export async function removeLeave(deps: SchedulingDeps, ctx: BranchContext, oid: string, leaveOid: string, caller: Caller) {
    return withBranchTx(deps.db, ctx, async tx => {
        const t = await trainerAt(tx, ctx, oid, true);
        own(t, caller);
        home(t, ctx);
        const rows = await tx.query<{ from_date: string; to_date: string }>(sql`
            update trainer_leave set removed_at = now() where oid = ${leaveOid} and trainer_oid = ${t.oid} and branch_oid = ${ctx.branchOid} and removed_at is null
            returning from_date::text as from_date, to_date::text as to_date`);
        if (!rows.length) throw new AppError(404, 'Day off not found');
        await recordAudit(tx, ctx, { action: 'remove_leave', entity: 'trainer', entityKey: t.slug, before: rows[0], after: null });
    });
}

/** A member's assigned trainer (set or cleared at the member's home branch. */
export async function assignTrainer(deps: SchedulingDeps, ctx: BranchContext, memberOid: string, trainerOid: string | null) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [m] = await tx.query<{ code: string; name: string; trainer_oid: string | null; anonymised: boolean }>(sql`
            select code, name, trainer_oid, anonymised_at is not null as anonymised from member where oid = ${memberOid} and branch_oid = ${ctx.branchOid} for update`);
        if (!m) throw new AppError(404, 'Member not found');
        if (m.anonymised) throw new AppError(409, 'This member was anonymised');
        let name: string | null = null;
        if (trainerOid) {
            const t = await trainerAt(tx, ctx, trainerOid);
            if (!(await schedulingRepo.worksAt(tx, t.oid, ctx.branchOid))) throw new AppError(409, `${t.name} does not work at this branch.`);
            name = t.name;
        }
        await tx.query(sql`update member set trainer_oid = ${trainerOid}, updated_at = now(), updated_by = ${ctx.actor?.oid ?? null} where oid = ${memberOid}`);
        await recordAudit(tx, ctx, {
            action: 'assign_trainer',
            entity: 'member',
            entityKey: m.code,
            before: { trainer_oid: m.trainer_oid },
            after: { trainer_oid: trainerOid, trainer_name: name }
        });
        return { trainer_oid: trainerOid, trainer_name: name };
    });
}

/* ---------- public ---------- */

async function everyBranch(db: Db) {
    const rows = await db.query<{ oid: string; slug: string }>(sql`select oid, slug from branch where kind = 'BRANCH' and status = 'Active' order by name`);
    return rows;
}

/** Public trainers (public and active), of one branch by slug or of all. */
export async function publicTrainers(deps: SchedulingDeps, branchSlug: string | undefined) {
    const branches = await everyBranch(deps.db);
    const chosen = branchSlug ? branches.filter(b => b.slug === branchSlug) : branches;
    if (branchSlug && !chosen.length) throw new AppError(404, 'Branch not found');
    const [first] = branches;
    if (!first) return [];
    const oids = chosen.map(b => b.oid);
    const rows = await withBranchTx(
        deps.db,
        systemContext(
            first.oid,
            branches.map(b => b.oid)
        ),
        tx => schedulingRepo.trainers(tx, oids)
    );
    return Promise.all(rows.filter(t => t.public && t.active && oids.includes(t.branch_oid)).map(t => publicTrainerWire(deps, t)));
}

/** One public trainer with their classes in the next 7 days, at any branch. */
export async function publicTrainer(deps: SchedulingDeps, slug: string, now: Date) {
    const branches = await everyBranch(deps.db);
    const [first] = branches;
    if (!first) throw new AppError(404, 'Trainer not found');
    const all = branches.map(b => b.oid);
    return withBranchTx(deps.db, systemContext(first.oid, all), async tx => {
        const [t] = (await schedulingRepo.trainers(tx, all)).filter(x => x.slug === slug && x.public && x.active);
        if (!t) throw new AppError(404, 'Trainer not found');
        const today = dhakaNow(now).date;
        for (const b of all) await schedulingRepo.materialise(tx, b, today, addDays(today, 7));
        const classes = await tx.query<{ title: string; starts_at: Date; ends_at: Date; branch_name: string; branch_slug: string; ladies_only: boolean }>(sql`
            select c.title, c.starts_at, c.ends_at, b.name as branch_name, b.slug as branch_slug, c.ladies_only from class_session c join branch b on b.oid = c.branch_oid
            where c.trainer_oid = ${t.oid} and c.cancelled_at is null and c.starts_at >= ${now} and c.starts_at < ${now}::timestamptz + interval '7 days'
            order by c.starts_at`);
        return {
            ...(await publicTrainerWire(deps, t)),
            branch_slug: branches.find(b => b.oid === t.branch_oid)?.slug ?? null,
            classes: classes.map(c => ({ ...c, starts_at: dhakaIso(c.starts_at), ends_at: dhakaIso(c.ends_at) }))
        };
    });
}
