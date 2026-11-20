import type { Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { livePhoto, livePhotoExpr } from '#src/features/files/files.repo.ts';

/**
 * The scheduling tables (migration 018): one repository for the subsystem's four services (trainers, classes, PT,
 * facilities). Every query runs in a `withBranchTx` transaction and filters the branch itself; RLS backs it up.
 */
const ids = (oids: readonly string[]) => `{${oids.join(',')}}`;

export interface TrainerRow {
    oid: string;
    branch_oid: string;
    branch_name: string;
    user_oid: string;
    username: string;
    name: string;
    slug: string;
    gender: 'Male' | 'Female';
    phone: string | null;
    headline: string | null;
    bio: string | null;
    specialties: string[];
    certifications: { name: string; issuer: string | null; year: number | null }[];
    photo_file_oid: string | null;
    photo_asset: string | null;
    public: boolean;
    active: boolean;
    /** The staff account can sign in (status Active and a password set). */
    can_sign_in: boolean;
    clients: number;
}

const TRAINER = sql.raw(`t.oid, t.branch_oid, b.name as branch_name, t.user_oid, u.username, u.name, t.slug, t.gender, t.phone, t.headline, t.bio,
    t.specialties, t.certifications, ${livePhotoExpr('t.photo_file_oid')} as photo_file_oid, t.photo_asset, t.public,
    t.active and u.status = 'Active' as active, (u.status = 'Active' and u.password_hash <> '!') as can_sign_in,
    (select count(*)::int from member m where m.trainer_oid = t.oid and m.anonymised_at is null) as clients
    from trainer t join app_user u on u.oid = t.user_oid join branch b on b.oid = t.branch_oid`);

export interface ClassTypeRow {
    oid: string;
    name: string;
    description: string | null;
    color: string;
    minutes: number;
    sort_order: number;
    active: boolean;
}

export interface RoomRow {
    oid: string;
    branch_oid: string;
    name: string;
    capacity: number;
    active: boolean;
}

export interface ScheduleRow {
    oid: string;
    branch_oid: string;
    class_type_oid: string;
    type_name: string;
    color: string;
    trainer_oid: string;
    trainer_name: string;
    room_oid: string;
    room_name: string;
    weekdays: number[];
    start_time: string;
    minutes: number;
    capacity: number;
    ladies_only: boolean;
    valid_from: string;
    valid_to: string | null;
    active: boolean;
}

const SCHEDULE = sql.raw(`s.oid, s.branch_oid, s.class_type_oid, ct.name as type_name, ct.color, s.trainer_oid, u.name as trainer_name, s.room_oid,
    r.name as room_name, s.weekdays, to_char(s.start_time, 'HH24:MI') as start_time, s.minutes, s.capacity, s.ladies_only,
    s.valid_from::text as valid_from, s.valid_to::text as valid_to, s.active
    from class_schedule s join class_type ct on ct.oid = s.class_type_oid join trainer t on t.oid = s.trainer_oid
    join app_user u on u.oid = t.user_oid join room r on r.oid = s.room_oid`);

export interface SessionRow {
    oid: string;
    branch_oid: string;
    schedule_oid: string | null;
    session_date: string;
    class_type_oid: string;
    title: string;
    color: string;
    trainer_oid: string;
    trainer_name: string;
    room_oid: string;
    room_name: string;
    starts_at: Date;
    ends_at: Date;
    capacity: number;
    ladies_only: boolean;
    detached: boolean;
    cancelled_at: Date | null;
    cancel_reason: string | null;
    booked: number;
    waitlist: number;
    /** A maintenance block covers the room at the time (D-082). */
    blocked: boolean;
}

const SESSION = sql.raw(`c.oid, c.branch_oid, c.schedule_oid, c.session_date::text as session_date, c.class_type_oid, c.title, c.color, c.trainer_oid,
    c.trainer_name, c.room_oid, c.room_name, c.starts_at, c.ends_at, c.capacity, c.ladies_only, c.detached, c.cancelled_at, c.cancel_reason,
    (select count(*)::int from booking k where k.session_oid = c.oid and k.status in ('Booked', 'Attended', 'NoShow')) as booked,
    (select count(*)::int from booking k where k.session_oid = c.oid and k.status = 'Waitlist') as waitlist,
    exists (select from maintenance_block mb where mb.room_oid = c.room_oid and mb.removed_at is null
        and mb.starts_at < c.ends_at and c.starts_at < mb.ends_at) as blocked
    from class_session c`);

export interface BookingRow {
    oid: string;
    branch_oid: string;
    session_oid: string;
    member_oid: string;
    member_code: string;
    member_name: string;
    status: 'Booked' | 'Waitlist' | 'Attended' | 'NoShow' | 'Cancelled';
    late_cancel: boolean;
    source: 'portal' | 'desk';
    booked_at: Date;
}

const BOOKING = sql.raw(`k.oid, k.branch_oid, k.session_oid, k.member_oid, k.member_code, k.member_name, k.status, k.late_cancel, k.source, k.booked_at
    from booking k`);

export const schedulingRepo = {
    /* ---------- trainers ---------- */

    /** Trainers whose home is one of `branchOids`, or who hold the TRAINER role at one of them. */
    trainers: (tx: Queryable, branchOids: readonly string[]) =>
        tx.query<TrainerRow>(sql`
            select ${TRAINER}
            where t.branch_oid = any (${ids(branchOids)}::uuid[])
               or exists (select from staff_assignment sa where sa.user_oid = t.user_oid and sa.role_code = 'TRAINER' and sa.branch_oid = any (${ids(branchOids)}::uuid[]))
            order by u.name`),

    trainer: async (tx: Queryable, oid: string, branchOids: readonly string[], forUpdate = false) => {
        const [row] = await tx.query<TrainerRow>(sql`
            select ${TRAINER}
            where t.oid = ${oid} and (t.branch_oid = any (${ids(branchOids)}::uuid[])
               or exists (select from staff_assignment sa where sa.user_oid = t.user_oid and sa.role_code = 'TRAINER' and sa.branch_oid = any (${ids(branchOids)}::uuid[])))
            ${forUpdate ? sql.raw('for update of t') : sql.raw('')}`);
        return row;
    },

    trainerByUser: async (tx: Queryable, userOid: string) => {
        const [row] = await tx.query<TrainerRow>(sql`select ${TRAINER} where t.user_oid = ${userOid}`);
        return row;
    },

    /** A trainer may work at this branch: holds the TRAINER role here, active, account active. */
    worksAt: async (tx: Queryable, trainerOid: string, branchOid: string) => {
        const [row] = await tx.query<{ ok: boolean }>(sql`
            select exists (select from trainer t join app_user u on u.oid = t.user_oid
                join staff_assignment sa on sa.user_oid = t.user_oid and sa.role_code = 'TRAINER' and sa.branch_oid = ${branchOid}
                where t.oid = ${trainerOid} and t.active and u.status = 'Active') as ok`);
        return row?.ok ?? false;
    },

    /** TRAINER-role staff at the branch who have no profile yet. */
    candidates: (tx: Queryable, branchOid: string) =>
        tx.query<{ user_oid: string; username: string; name: string }>(sql`
            select u.oid as user_oid, u.username, u.name from app_user u
            join staff_assignment sa on sa.user_oid = u.oid and sa.role_code = 'TRAINER' and sa.branch_oid = ${branchOid}
            where u.kind = 'staff' and not exists (select from trainer t where t.user_oid = u.oid) order by u.name`),

    availability: (tx: Queryable, trainerOid: string, branchOid: string) =>
        tx.query<{ weekday: number; start_time: string; end_time: string }>(sql`
            select weekday, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time from trainer_availability
            where trainer_oid = ${trainerOid} and branch_oid = ${branchOid} order by weekday, start_time`),

    leave: (tx: Queryable, trainerOid: string, fromDate: string) =>
        tx.query<{ oid: string; from_date: string; to_date: string; reason: string | null }>(sql`
            select oid, from_date::text as from_date, to_date::text as to_date, reason from trainer_leave
            where trainer_oid = ${trainerOid} and removed_at is null and to_date >= ${fromDate}::date order by from_date`),

    onLeave: async (tx: Queryable, trainerOid: string, date: string) => {
        const [row] = await tx.query<{ ok: boolean }>(sql`
            select exists (select from trainer_leave where trainer_oid = ${trainerOid} and removed_at is null
                and from_date <= ${date}::date and ${date}::date <= to_date) as ok`);
        return row?.ok ?? false;
    },

    clients: (tx: Queryable, trainerOid: string, branchOid: string) =>
        tx.query<{ oid: string; code: string; name: string; photo_file_oid: string | null; branch_oid: string }>(sql`
            select m.oid, m.code, m.name, ${livePhoto('m.photo_file_oid')} as photo_file_oid, m.branch_oid from member m
            where m.trainer_oid = ${trainerOid} and m.branch_oid = ${branchOid} and m.anonymised_at is null order by m.name`),

    /* ---------- class types and rooms ---------- */

    classTypes: (tx: Queryable, activeOnly: boolean) =>
        tx.query<ClassTypeRow>(sql`
            select oid, name, description, color, minutes, sort_order, active from class_type
            ${activeOnly ? sql.raw('where active') : sql.raw('')} order by sort_order, name`),

    classType: async (tx: Queryable, oid: string) => {
        const [row] = await tx.query<ClassTypeRow>(sql`select oid, name, description, color, minutes, sort_order, active from class_type where oid = ${oid}`);
        return row;
    },

    rooms: (tx: Queryable, branchOid: string) =>
        tx.query<RoomRow>(sql`select oid, branch_oid, name, capacity, active from room where branch_oid = ${branchOid} order by name`),

    room: async (tx: Queryable, oid: string, branchOid: string) => {
        const [row] = await tx.query<RoomRow>(sql`select oid, branch_oid, name, capacity, active from room where oid = ${oid} and branch_oid = ${branchOid}`);
        return row;
    },

    /* ---------- class rules and sessions ---------- */

    schedules: (tx: Queryable, branchOid: string) =>
        tx.query<ScheduleRow>(sql`select ${SCHEDULE} where s.branch_oid = ${branchOid} order by s.active desc, s.start_time, ct.name`),

    schedule: async (tx: Queryable, oid: string, branchOid: string, forUpdate = false) => {
        const [row] = await tx.query<ScheduleRow>(sql`
            select ${SCHEDULE} where s.oid = ${oid} and s.branch_oid = ${branchOid} ${forUpdate ? sql.raw('for update of s') : sql.raw('')}`);
        return row;
    },

    /**
     * Makes the sessions of every active rule of the branch for the Dhaka days `from` to `to` (idempotent: one per rule
     * and day). The time-based rule of D-075: the timetable is filled in when it is read, never by a job.
     */
    materialise: (tx: Queryable, branchOid: string, from: string, to: string) =>
        tx.query(sql`
            insert into class_session (branch_oid, schedule_oid, session_date, class_type_oid, title, color, trainer_oid, trainer_name, room_oid, room_name,
                starts_at, ends_at, capacity, ladies_only)
            select s.branch_oid, s.oid, d::date, ct.oid, ct.name, ct.color, s.trainer_oid, u.name, s.room_oid, r.name,
                (d::date + s.start_time) at time zone 'Asia/Dhaka', (d::date + s.start_time + make_interval(mins => s.minutes)) at time zone 'Asia/Dhaka',
                s.capacity, s.ladies_only
            from class_schedule s
            join class_type ct on ct.oid = s.class_type_oid
            join trainer t on t.oid = s.trainer_oid
            join app_user u on u.oid = t.user_oid
            join room r on r.oid = s.room_oid
            cross join lateral generate_series(greatest(s.valid_from, ${from}::date), least(coalesce(s.valid_to, ${to}::date), ${to}::date), interval '1 day') d
            where s.branch_oid = ${branchOid} and s.active and extract(dow from d)::int = any (s.weekdays)
            on conflict (schedule_oid, session_date) do nothing`),

    sessions: (tx: Queryable, branchOid: string, from: string, to: string) =>
        tx.query<SessionRow>(sql`
            select ${SESSION} where c.branch_oid = ${branchOid} and c.session_date between ${from}::date and ${to}::date order by c.starts_at, c.title`),

    session: async (tx: Queryable, oid: string, branchOid: string, forUpdate = false) => {
        const [row] = await tx.query<SessionRow>(sql`
            select ${SESSION} where c.oid = ${oid} and c.branch_oid = ${branchOid} ${forUpdate ? sql.raw('for update of c') : sql.raw('')}`);
        return row;
    },

    /** A trainer's or a room's classes and the trainer's PT sessions that overlap [from, to), apart from `except`. */
    clashes: (tx: Queryable, branchOid: string, at: { from: Date; to: Date }, who: { trainer_oid: string; room_oid: string | null }, except: string | null) =>
        tx.query<{ kind: 'class' | 'pt'; title: string; starts_at: Date; trainer: boolean; room: boolean }>(sql`
            select 'class' as kind, c.title, c.starts_at, c.trainer_oid = ${who.trainer_oid} as trainer, c.room_oid = ${who.room_oid} as room
            from class_session c
            where c.branch_oid = ${branchOid} and c.cancelled_at is null and c.oid is distinct from ${except}::uuid
              and c.starts_at < ${at.to} and ${at.from} < c.ends_at and (c.trainer_oid = ${who.trainer_oid} or c.room_oid = ${who.room_oid})
            union all
            select 'pt', 'PT with ' || p.member_name, p.starts_at, p.trainer_oid = ${who.trainer_oid}, p.room_oid = ${who.room_oid}
            from pt_session p
            where p.branch_oid = ${branchOid} and p.status = 'Booked' and p.oid is distinct from ${except}::uuid
              and p.starts_at < ${at.to} and ${at.from} < p.ends_at and (p.trainer_oid = ${who.trainer_oid} or p.room_oid = ${who.room_oid})`),

    roomBlocked: async (tx: Queryable, roomOid: string, from: Date, to: Date) => {
        const [row] = await tx.query<{ reason: string | null }>(sql`
            select reason from maintenance_block where room_oid = ${roomOid} and removed_at is null and starts_at < ${to} and ${from} < ends_at limit 1`);
        return row?.reason ?? null;
    },

    /* ---------- bookings ---------- */

    bookings: (tx: Queryable, sessionOid: string) =>
        tx.query<BookingRow>(sql`select ${BOOKING} where k.session_oid = ${sessionOid} and k.status <> 'Cancelled' order by k.booked_at`),

    booking: async (tx: Queryable, oid: string, branchOid: string, forUpdate = false) => {
        const [row] = await tx.query<BookingRow>(sql`
            select ${BOOKING} where k.oid = ${oid} and k.branch_oid = ${branchOid} ${forUpdate ? sql.raw('for update of k') : sql.raw('')}`);
        return row;
    },

    /** Bookings left as Booked after their class ended become no-shows; a waitlist place lapses once the class starts. */
    settle: async (tx: Queryable, branchOid: string, now: Date) => {
        const noShows = await tx.query<{ oid: string }>(sql`
            update booking k set status = 'NoShow', updated_at = now(), updated_by = null
            from class_session c
            where c.oid = k.session_oid and k.branch_oid = ${branchOid} and k.status = 'Booked' and c.ends_at <= ${now}
            returning k.oid`);
        const lapsed = await tx.query<{ oid: string }>(sql`
            update booking k set status = 'Cancelled', updated_at = now(), updated_by = null
            from class_session c
            where c.oid = k.session_oid and k.branch_oid = ${branchOid} and k.status = 'Waitlist' and c.starts_at <= ${now}
            returning k.oid`);
        return { noShows: noShows.length, lapsed: lapsed.length };
    },

    /** A member's future Booked or Waitlist bookings. */
    activeCount: async (tx: Queryable, memberOid: string, now: Date) => {
        const [row] = await tx.query<{ n: number }>(sql`
            select count(*)::int as n from booking k join class_session c on c.oid = k.session_oid
            where k.member_oid = ${memberOid} and k.status in ('Booked', 'Waitlist') and c.starts_at > ${now} and c.cancelled_at is null`);
        return row?.n ?? 0;
    },

    /** No-shows and late cancels of classes that started in the last `days` days, newest first. */
    strikes: (tx: Queryable, memberOid: string, since: Date) =>
        tx.query<{ starts_at: Date }>(sql`
            select c.starts_at from booking k join class_session c on c.oid = k.session_oid
            where k.member_oid = ${memberOid} and c.starts_at >= ${since} and (k.status = 'NoShow' or k.late_cancel)
            order by c.starts_at desc`)
};
