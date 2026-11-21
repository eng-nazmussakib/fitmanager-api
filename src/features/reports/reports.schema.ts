import * as v from 'valibot';

import { REPORT_KEYS } from './reports.defs.ts';

const day = v.pipe(v.string(), v.isoDate('A date as YYYY-MM-DD'));

/** `?from&to&compare` (Dhaka days, inclusive; at most 366 days, D-106); HQ adds `branch_oid`. */
export const reportQuery = v.object({
    from: v.optional(day),
    to: v.optional(day),
    compare: v.optional(v.picklist(['', '0', '1', 'true', 'false'])),
    branch_oid: v.optional(v.pipe(v.string(), v.uuid('A branch id')))
});

export const reportParams = v.object({ key: v.picklist(REPORT_KEYS, 'Unknown report') });

export const trainerParams = v.object({ oid: v.pipe(v.string(), v.uuid('A trainer id')) });
