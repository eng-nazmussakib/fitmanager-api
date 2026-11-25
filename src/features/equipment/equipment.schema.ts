import * as v from 'valibot';

/** Request schemas of the equipment register and maintenance tickets. */
const text = (min: number, max: number, label = 'Required') =>
    v.pipe(v.string(), v.trim(), v.minLength(min, label), v.maxLength(max, `At most ${max} characters`));
const optionalText = (max: number) =>
    v.optional(
        v.pipe(
            v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max, `At most ${max} characters`))),
            v.transform(s => (s === '' ? null : s))
        )
    );
const isoDate = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, 'A date'));
const optionalDate = v.optional(v.nullable(isoDate));
const money = v.optional(
    v.nullable(
        v.pipe(
            v.number(),
            v.minValue(0, 'Not below ৳0'),
            v.maxValue(100_000_000),
            v.transform(n => Math.round(n))
        )
    )
);

export const oidParams = v.object({ oid: v.pipe(v.string(), v.uuid('Not found')) });

export const CATEGORIES = ['cardio', 'strength', 'free_weights', 'benches_racks', 'functional', 'other'] as const;
export const PRIORITIES = ['low', 'normal', 'urgent'] as const;

export const equipmentCreate = v.strictObject({
    name: text(2, 80),
    category: v.picklist(CATEGORIES, 'Choose a category'),
    brand: optionalText(60),
    model: optionalText(60),
    serial: optionalText(60),
    purchased_on: optionalDate,
    cost: money,
    warranty_until: optionalDate,
    room_oid: v.optional(v.nullable(v.pipe(v.string(), v.uuid('Unknown room')))),
    photo_file_oid: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    service_every_days: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(7, 'At least 7 days'), v.maxValue(730, 'At most 2 years')))),
    last_serviced_on: optionalDate,
    notes: optionalText(1000)
});
export type EquipmentCreate = v.InferOutput<typeof equipmentCreate>;
export const equipmentUpdate = v.partial(equipmentCreate);
export type EquipmentUpdate = v.InferOutput<typeof equipmentUpdate>;

export const equipmentQuery = v.object({
    status: v.optional(v.picklist(['in_use', 'out_of_order', 'retired', 'all'])),
    due: v.optional(v.picklist(['0', '1'])),
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)))
});
export type EquipmentQuery = v.InferOutput<typeof equipmentQuery>;

export const retireSchema = v.strictObject({ reason: text(3, 300) });

export const serviceSchema = v.strictObject({
    on: v.optional(isoDate),
    technician: text(2, 120),
    cost: money,
    note: optionalText(1000)
});
export type ServiceInput = v.InferOutput<typeof serviceSchema>;

export const ticketCreate = v.strictObject({
    description: text(3, 1000),
    priority: v.optional(v.picklist(PRIORITIES, 'Choose a priority')),
    /** Put the equipment out of order until the ticket is closed. */
    out_of_order: v.optional(v.boolean()),
    photo_file_oid: v.optional(v.nullable(v.pipe(v.string(), v.uuid())))
});
export type TicketCreate = v.InferOutput<typeof ticketCreate>;

export const ticketUpdate = v.strictObject({
    status: v.optional(v.picklist(['open', 'in_progress', 'fixed', 'cannot_fix'], 'Choose a status')),
    priority: v.optional(v.picklist(PRIORITIES)),
    technician: optionalText(120),
    cost: money,
    resolution: optionalText(1000)
});
export type TicketUpdate = v.InferOutput<typeof ticketUpdate>;

export const ticketQuery = v.object({ status: v.optional(v.picklist(['open', 'closed', 'all'])) });
