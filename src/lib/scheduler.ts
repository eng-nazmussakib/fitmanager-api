import { Cron } from 'croner';

import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';

import { log } from './logger.ts';

/**
 * Background jobs with croner (node-cron in ACAS trans-validate, HRM and VHC; setInterval in IMS).
 *
 * The problem none of them handled: in Swarm every REPLICA runs the schedule, so with 2 replicas each job ran
 * twice, at the same moment. Here a job runs inside a transaction that first takes a PostgreSQL advisory lock
 * (`pg_try_advisory_xact_lock`); the replica that does not get it skips the run. No extra infrastructure, and the
 * lock is released by the commit, or by the database if the process dies.
 * `protect: true` also stops a slow run from overlapping the next tick within one process.
 */
export interface Job {
    name: string;
    /** Cron pattern, evaluated in Asia/Dhaka. */
    schedule: string;
    run(tx: Queryable): Promise<void>;
}

/** Runs the job if no other replica is running it. Returns whether it ran. */
export async function runExclusive(db: Db, job: Job): Promise<boolean> {
    return db.transaction(async tx => {
        const [row] = await tx.query<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${`job:${job.name}`})) as locked`);
        if (!row?.locked) {
            log().debug({ job: job.name }, 'Job skipped: running elsewhere');
            return false;
        }
        const started = Date.now();
        await job.run(tx);
        log().info({ job: job.name, ms: Date.now() - started }, 'Job finished');
        return true;
    });
}

export interface Scheduler {
    stop(): void;
}

export function startScheduler(db: Db, jobs: Job[]): Scheduler {
    const crons = jobs.map(
        job =>
            new Cron(
                job.schedule,
                {
                    name: job.name,
                    timezone: 'Asia/Dhaka',
                    protect: true,
                    catch: (err: unknown) => {
                        log().error({ err, job: job.name }, 'Job failed');
                    }
                },
                async () => {
                    await runExclusive(db, job);
                }
            )
    );
    return {
        stop: () => {
            crons.forEach(c => {
                c.stop();
            });
        }
    };
}
