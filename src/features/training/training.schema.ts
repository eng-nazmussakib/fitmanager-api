import * as v from 'valibot';

/** Request schemas of the training subsystem: exercises, routines, workouts, measurements. */
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
const whole = (min: number, max: number) =>
    v.pipe(v.number(), v.integer('A whole number'), v.minValue(min, `At least ${min}`), v.maxValue(max, `At most ${max}`));
/** A number with at most one decimal (kg, cm, %), or two for weights on a set. */
const decimal = (min: number, max: number, places = 1) =>
    v.pipe(
        v.number(),
        v.minValue(min, `At least ${min}`),
        v.maxValue(max, `At most ${max}`),
        v.check(n => Math.abs(Math.round(n * 10 ** places) - n * 10 ** places) < 1e-6, `At most ${places} decimal${places > 1 ? 's' : ''}`)
    );
const nullable = <S extends v.GenericSchema>(schema: S) => v.optional(v.nullable(schema));
const nonEmpty = (b: object): boolean => Object.keys(b).length > 0;

export const CATEGORIES = ['strength', 'cardio', 'mobility', 'core', 'plyometric'] as const;
export const MEASURES = ['weight_reps', 'reps', 'time', 'distance_time'] as const;
export const MUSCLES = [
    'chest',
    'back',
    'shoulders',
    'biceps',
    'triceps',
    'forearms',
    'core',
    'glutes',
    'quads',
    'hamstrings',
    'calves',
    'full_body',
    'cardio'
] as const;
export const EQUIPMENT = ['barbell', 'dumbbell', 'kettlebell', 'machine', 'cable', 'bodyweight', 'band', 'cardio_machine', 'other'] as const;
export const GOALS = ['strength', 'muscle', 'fat_loss', 'endurance', 'general'] as const;
export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type Measure = (typeof MEASURES)[number];

export const oidParams = v.object({ oid: uuid('Not found') });

/* ---------- exercises ---------- */

const exerciseFields = {
    name: v.pipe(text(80), v.minLength(2, 'At least 2 characters')),
    category: v.picklist(CATEGORIES, 'Choose a category'),
    measure: v.picklist(MEASURES, 'Choose how it is measured'),
    muscles: v.pipe(
        v.array(v.picklist(MUSCLES, 'Unknown muscle')),
        v.minLength(1, 'Pick at least one muscle'),
        v.maxLength(5, 'At most 5 muscles'),
        v.check(m => new Set(m).size === m.length, 'Each muscle once')
    ),
    equipment: v.picklist(EQUIPMENT, 'Choose the equipment'),
    instructions: optionalText(2000),
    photo_file_oids: v.optional(
        v.pipe(
            v.array(uuid('Not an uploaded file')),
            v.maxLength(3, 'At most 3 photos'),
            v.check(m => new Set(m).size === m.length, 'Each photo once')
        )
    ),
    video_file_oid: nullable(uuid('Not an uploaded file'))
};
export const exerciseCreate = v.strictObject(exerciseFields);
export const exerciseUpdate = v.pipe(
    v.strictObject({ ...v.partial(v.strictObject(exerciseFields)).entries, active: v.optional(v.boolean()) }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export const exerciseQuery = v.object({
    q: v.optional(text(60)),
    category: v.optional(v.picklist(CATEGORIES, 'Unknown category')),
    muscle: v.optional(v.picklist(MUSCLES, 'Unknown muscle')),
    equipment: v.optional(v.picklist(EQUIPMENT, 'Unknown equipment')),
    /** `1` lists inactive exercises too (the library page). */
    all: v.optional(v.picklist(['0', '1']))
});
export type ExerciseCreate = v.InferOutput<typeof exerciseCreate>;
export type ExerciseUpdate = v.InferOutput<typeof exerciseUpdate>;
export type ExerciseQuery = v.InferOutput<typeof exerciseQuery>;

/* ---------- routines ---------- */

const routineExercise = v.strictObject({
    exercise_oid: uuid('Unknown exercise'),
    sets: whole(1, 10),
    reps: nullable(whole(1, 100)),
    weight_kg: nullable(decimal(0, 500, 2)),
    seconds: nullable(whole(1, 7200)),
    distance_m: nullable(whole(1, 50_000)),
    rest_seconds: v.optional(whole(0, 600), 90),
    notes: optionalText(200)
});
const routineDay = v.strictObject({
    name: v.pipe(text(30), v.minLength(1, 'Name the day')),
    exercises: v.pipe(v.array(routineExercise), v.minLength(1, 'Add an exercise'), v.maxLength(12, 'At most 12 exercises a day'))
});
const routineFields = {
    name: v.pipe(text(80), v.minLength(2, 'At least 2 characters')),
    goal: v.picklist(GOALS, 'Choose a goal'),
    level: v.picklist(LEVELS, 'Choose a level'),
    description: optionalText(1000),
    days: v.pipe(v.array(routineDay), v.minLength(1, 'Add a day'), v.maxLength(7, 'At most 7 days'))
};
export const routineCreate = v.strictObject(routineFields);
export const routineUpdate = v.pipe(
    v.strictObject({ ...v.partial(v.strictObject(routineFields)).entries, active: v.optional(v.boolean()) }),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
/** A member's routine: a copy of a template, or one built for them. */
export const assignSchema = v.union(
    [v.strictObject({ template_oid: uuid('Unknown routine') }), v.strictObject({ routine: routineCreate })],
    'Choose a template or build a routine'
);
export const portalStartSchema = v.strictObject({ template_oid: uuid('Unknown routine') });
export type RoutineCreate = v.InferOutput<typeof routineCreate>;
export type RoutineUpdate = v.InferOutput<typeof routineUpdate>;
export type RoutineExerciseInput = v.InferOutput<typeof routineExercise>;
export type AssignInput = v.InferOutput<typeof assignSchema>;

/* ---------- workouts ---------- */

const setInput = v.strictObject({
    weight_kg: nullable(decimal(0, 1000, 2)),
    reps: nullable(whole(1, 500)),
    seconds: nullable(whole(1, 36_000)),
    distance_m: nullable(decimal(1, 200_000))
});
const workoutExercise = v.strictObject({
    exercise_oid: uuid('Unknown exercise'),
    sets: v.pipe(v.array(setInput), v.minLength(1, 'Log at least one set'), v.maxLength(20, 'At most 20 sets'))
});
const workoutFields = {
    performed_on: date,
    minutes: nullable(whole(1, 600)),
    notes: optionalText(1000),
    /** The day of the member's running routine this followed (its index), or none. */
    day_index: nullable(whole(0, 6)),
    exercises: v.pipe(v.array(workoutExercise), v.minLength(1, 'Log at least one exercise'), v.maxLength(30, 'At most 30 exercises'))
};
export const workoutCreate = v.strictObject(workoutFields);
export const workoutUpdate = v.pipe(
    v.strictObject(v.partial(v.strictObject(workoutFields)).entries),
    v.check(b => nonEmpty(b), 'Nothing to change')
);
export const workoutQuery = v.object({ limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.minValue(1), v.maxValue(100))) });
export type WorkoutCreate = v.InferOutput<typeof workoutCreate>;
export type WorkoutUpdate = v.InferOutput<typeof workoutUpdate>;
export type SetInput = v.InferOutput<typeof setInput>;

/* ---------- measurements ---------- */

export const measurementCreate = v.pipe(
    v.strictObject({
        measured_on: date,
        /** Also saved on the member (BMI). */
        height_cm: nullable(decimal(80, 250)),
        weight_kg: nullable(decimal(20, 400)),
        body_fat_pct: nullable(decimal(2, 70)),
        waist_cm: nullable(decimal(30, 250)),
        chest_cm: nullable(decimal(30, 250)),
        hips_cm: nullable(decimal(30, 250)),
        arm_cm: nullable(decimal(10, 100)),
        thigh_cm: nullable(decimal(20, 150)),
        photo_front_oid: nullable(uuid('Not an uploaded file')),
        photo_side_oid: nullable(uuid('Not an uploaded file')),
        photo_back_oid: nullable(uuid('Not an uploaded file')),
        notes: optionalText(500)
    }),
    v.check(
        b =>
            [b.weight_kg, b.body_fat_pct, b.waist_cm, b.chest_cm, b.hips_cm, b.arm_cm, b.thigh_cm, b.photo_front_oid, b.photo_side_oid, b.photo_back_oid].some(
                x => x !== null && x !== undefined
            ),
        'Enter at least one measurement or photo'
    )
);
export type MeasurementCreate = v.InferOutput<typeof measurementCreate>;

/** `POST /v1/me/files`: a member's own progress photo (the staff route is `/v1/files`). */
export const portalFileStart = v.strictObject({
    // Progress photos and a complaint's photo.
    kind: v.picklist(['measurement_photo', 'complaint_photo'], 'Only progress or complaint photos'),
    name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Required'), v.maxLength(200)),
    content_type: v.pipe(v.string(), v.toLowerCase(), v.maxLength(100)),
    size: v.pipe(v.number(), v.integer('Bytes'), v.minValue(1, 'The file is empty'))
});
