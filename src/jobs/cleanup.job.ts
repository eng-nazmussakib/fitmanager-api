import { sql } from '#src/db/sql.ts';
import type { Job } from '#src/lib/scheduler.ts';

/**
 * Nightly housekeeping (IMS's CleanupScheduler, which ran it with setInterval in every replica): expired or long
 * revoked refresh tokens and used/expired OTPs. Kept one day longer than needed, for investigating incidents.
 */
export const cleanupJob: Job = {
    name: 'cleanup-expired-credentials',
    schedule: '15 3 * * *', // 03:15 Dhaka time
    async run(tx) {
        await tx.query(sql`delete from refresh_token where expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day'`);
        await tx.query(sql`delete from otp where expires_at < now() - interval '1 day'`);
    }
};
