import * as v from 'valibot';

import { bdMobile } from '#src/features/members/members.schema.ts';
import { queryInt } from '#src/lib/query.ts';

/** Request schemas of the scheduling subsystem (phase 3): trainers, classes, PT, facilities. */
const uuid = (message: string) => v.pipe(v.string(), v.uuid(message));
const text = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(text(max)),
            v.transform(s => (s === '' ? null : s))
        )
    );
const date = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));
const time = (step: number) =>
    v.pipe(
        v.string(),
        v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:mm'),
        v.check(
            t => Number(t.slice(3)) % step === 0,
            `On the ${step === 30 ? 'half' : step === 60 ? 'whole' : `${step}-minute`} ${step === 30 ? 'hour' : 'mark'}`
        )
    );
const whole = (min: number, max: number) =>
    v.pipe(v.number(), v.integer('A whole number'), v.minValue(min, `At least ${min}`), v.maxValue(max, `At most ${max}`));
const reason = v.pipe(text(300), v.minLength(3, 'Give a reason (at least 3 characters)'));
const nonEmpty = (b: object): boolean => Object.keys(b).length > 0;
const weekdays = v.pipe(
    v.array(whole(0, 6)),
    v.minLength(1, 'Pick at least one day'),
    v.transform(days => [...new Set(days)].sort())
);

export const oidParams = v.object({ oid: uuid('Not found') });
export const twoOidParams = v.object({ oid: uuid('Not found'), sub: uuid('Not found') });
export const slugParams = v.object({ slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'Not found')) });
export const weekQuery = v.object({
    week: v.optional(date),
    trainer: v.optional(uuid('Unknown trainer'))
});
export const publicWeekQuery = v.object({ branch: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,40}$/, 'Unknown branch')), week: v.optional(date) });
export const publicTrainersQuery = v.object({ branch: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,40}$/, 'Unknown branch'))) });

/* ---------- trainers ---------- */

const certification = v.strictObject({
    name: v.pipe(text(120), v.minLength(2, 'Name the certificate')),
    issuer: optionalText(120),
    year: v.optional(v.nullable(whole(1970, 2100)))
});
const trainerFields = {
    slug: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'Lower case letters, digits and dashes')),
    gender: v.picklist(['Male', 'Female'], 'Male or Female'),
    phone: v.optional(v.nullable(bdMobile())),
    headline: optionalText(120),
    bio: optionalText(2000),
    specialties: v.optional(v.pipe(v.array(v.pipe(text(40), v.minLength(1))), v.maxLength(12))),
    certifications: v.optional(v.pipe(v.array(certification), v.maxLength(10))),
    photo_file_oid: v.optional(v.nullable(uuid('Upload the photo first'))),
    public: v.optional(v.boolean())
};
export const trainerCreate = v.strictObject({ user_oid: uuid('Choose a staff member'), ...trainerFields });
export type TrainerCreate = v.InferOutput<typeof trainerCreate>;
export const trainerUpdate = v.pipe(
    v.strictObject({
        slug: v.optional(trainerFields.slug),
        gender: v.optional(trainerFields.gender),
        phone: trainerFields.phone,
        headline: trainerFields.headline,
        bio: trainerFields.bio,
        specialties: trainerFields.specialties,
        certifications: trainerFields.certifications,
        photo_file_oid: trainerFields.photo_file_oid,
        public: trainerFields.public,
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type TrainerUpdate = v.InferOutput<typeof trainerUpdate>;

export const availabilitySchema = v.strictObject({
    slots: v.pipe(
        v.array(
            v.pipe(
                v.strictObject({ weekday: whole(0, 6), start_time: time(30), end_time: time(30) }),
                v.forward(
                    v.check(s => s.end_time > s.start_time, 'Ends after it starts'),
                    ['end_time']
                )
            )
        ),
        v.maxLength(42)
    )
});
export const leaveSchema = v.pipe(
    v.strictObject({ from_date: date, to_date: date, reason: optionalText(300) }),
    v.forward(
        v.check(l => l.to_date >= l.from_date, 'Ends on or after the first day'),
        ['to_date']
    )
);
export const assignSchema = v.strictObject({ trainer_oid: v.nullable(uuid('Unknown trainer')) });

/* ---------- class types, rooms ---------- */

const COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'] as const;
export const classTypeCreate = v.strictObject({
    name: v.pipe(text(60), v.minLength(2, 'Name the class')),
    description: optionalText(500),
    color: v.picklist(COLORS, 'One of the timetable colours'),
    minutes: whole(15, 180),
    sort_order: v.optional(v.pipe(v.number(), v.integer()), 0)
});
export const classTypeUpdate = v.pipe(
    v.strictObject({
        name: v.optional(classTypeCreate.entries.name),
        description: classTypeCreate.entries.description,
        color: v.optional(classTypeCreate.entries.color),
        minutes: v.optional(classTypeCreate.entries.minutes),
        sort_order: v.optional(v.pipe(v.number(), v.integer())),
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export const roomCreate = v.strictObject({ name: v.pipe(text(60), v.minLength(2, 'Name the room')), capacity: whole(1, 500) });
export const roomUpdate = v.pipe(
    v.strictObject({ name: v.optional(roomCreate.entries.name), capacity: v.optional(roomCreate.entries.capacity), active: v.optional(v.boolean()) }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);

/* ---------- class rules, sessions, bookings ---------- */

export const scheduleCreate = v.strictObject({
    class_type_oid: uuid('Choose a class type'),
    trainer_oid: uuid('Choose a trainer'),
    room_oid: uuid('Choose a room'),
    weekdays,
    start_time: time(5),
    /** Defaults to the class type's length. */
    minutes: v.optional(whole(15, 180)),
    capacity: whole(1, 200),
    ladies_only: v.optional(v.boolean(), false),
    valid_from: v.optional(date),
    valid_to: v.optional(v.nullable(date))
});
export type ScheduleCreate = v.InferOutput<typeof scheduleCreate>;
export const scheduleUpdate = v.pipe(
    v.strictObject({
        trainer_oid: v.optional(scheduleCreate.entries.trainer_oid),
        room_oid: v.optional(scheduleCreate.entries.room_oid),
        weekdays: v.optional(weekdays),
        start_time: v.optional(time(5)),
        minutes: v.optional(whole(15, 180)),
        capacity: v.optional(whole(1, 200)),
        ladies_only: v.optional(v.boolean()),
        valid_to: v.optional(v.nullable(date)),
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type ScheduleUpdate = v.InferOutput<typeof scheduleUpdate>;

export const oneOffCreate = v.strictObject({
    class_type_oid: uuid('Choose a class type'),
    trainer_oid: uuid('Choose a trainer'),
    room_oid: uuid('Choose a room'),
    date,
    start_time: time(5),
    minutes: v.optional(whole(15, 180)),
    capacity: whole(1, 200),
    ladies_only: v.optional(v.boolean(), false)
});
export type OneOffCreate = v.InferOutput<typeof oneOffCreate>;
export const sessionUpdate = v.pipe(
    v.strictObject({
        trainer_oid: v.optional(uuid('Choose a trainer')),
        room_oid: v.optional(uuid('Choose a room')),
        start_time: v.optional(time(5)),
        minutes: v.optional(whole(15, 180)),
        capacity: v.optional(whole(1, 200))
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export type SessionUpdate = v.InferOutput<typeof sessionUpdate>;
export const cancelSchema = v.strictObject({ reason });
export const bookSchema = v.strictObject({ member_oid: uuid('Choose a member') });
export const bookingStatusSchema = v.strictObject({ status: v.picklist(['Booked', 'Attended', 'NoShow', 'Cancelled'], 'Unknown booking status') });
export const portalBookSchema = v.strictObject({ session_oid: uuid('Choose a class') });

/* ---------- PT ---------- */

export const slotsQuery = v.object({ trainer_oid: v.optional(uuid('Unknown trainer')), date, minutes: v.optional(queryInt(30, 120), 60) });
export const ptCreate = v.strictObject({
    member_oid: uuid('Choose a member'),
    trainer_oid: uuid('Choose a trainer'),
    date,
    start_time: time(30),
    minutes: v.optional(v.picklist([30, 45, 60, 90], '30, 45, 60 or 90 minutes'), 60),
    room_oid: v.optional(v.nullable(uuid('Unknown room')))
});
export type PtCreate = v.InferOutput<typeof ptCreate>;
export const portalPtCreate = v.strictObject({ date, start_time: time(30) });
export const ptCancelSchema = v.strictObject({ by: v.picklist(['member', 'trainer', 'staff'], 'Who cancelled'), reason });
export const ptNoteSchema = v.strictObject({ notes: optionalText(1000) });
export const portalCancelSchema = v.strictObject({ reason: v.optional(reason, 'Cancelled in the member portal') });

/* ---------- facilities ---------- */

export const lockerCreate = v.strictObject({
    number: v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^[A-Z0-9-]{1,10}$/, 'Letters, digits and dashes, at most 10')),
    size: v.picklist(['S', 'M', 'L'], 'S, M or L'),
    monthly_fee: v.pipe(v.number(), v.minValue(0), v.maxValue(100_000), v.transform(Math.round))
});
export const lockerUpdate = v.pipe(
    v.strictObject({
        size: v.optional(lockerCreate.entries.size),
        monthly_fee: v.optional(lockerCreate.entries.monthly_fee),
        active: v.optional(v.boolean())
    }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
const method = v.picklist(['cash', 'card', 'bkash', 'nagad', 'bank'], 'Unknown payment method');
export const rentSchema = v.strictObject({
    member_oid: uuid('Choose a member'),
    months: whole(1, 12),
    start_date: v.optional(date),
    payment: v.optional(
        v.strictObject({
            method: v.optional(method, 'cash'),
            amount: v.pipe(v.number(), v.minValue(0), v.transform(Math.round)),
            reference: optionalText(100)
        }),
        { method: 'cash', amount: 0, reference: null }
    )
});
export type RentInput = v.InferOutput<typeof rentSchema>;
export const blockCreate = v.pipe(
    v.strictObject({
        room_oid: v.optional(uuid('Unknown room')),
        locker_oid: v.optional(uuid('Unknown locker')),
        starts_at: v.pipe(v.string(), v.isoTimestamp('A date and time')),
        ends_at: v.pipe(v.string(), v.isoTimestamp('A date and time')),
        reason
    }),
    v.check(b => (b.room_oid === undefined) !== (b.locker_oid === undefined), 'Block a room or a locker'),
    v.forward(
        v.check(b => Date.parse(b.ends_at) > Date.parse(b.starts_at), 'Ends after it starts'),
        ['ends_at']
    )
);
