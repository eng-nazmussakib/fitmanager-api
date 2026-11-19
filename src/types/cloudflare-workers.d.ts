/**
 * The slice of `cloudflare:workers` the Worker uses (`src/worker.ts`, `src/worker/*`). Declared here instead of
 * adding `@cloudflare/workers-types`, whose global `Request`/`Response` clash with Node's in the rest of the code.
 * https://developers.cloudflare.com/durable-objects/api/base/
 */
declare module 'cloudflare:workers' {
    interface DurableObjectStorage {
        get<T>(key: string): Promise<T | undefined>;
        put(key: string, value: unknown): Promise<void>;
        deleteAll(): Promise<void>;
        setAlarm(scheduledTime: number): Promise<void>;
    }
    interface DurableObjectState {
        readonly storage: DurableObjectStorage;
    }
    export abstract class DurableObject<Env = unknown> {
        protected readonly ctx: DurableObjectState;
        protected readonly env: Env;
        constructor(ctx: DurableObjectState, env: Env);
        alarm?(): Promise<void>;
    }
    /** The Worker's bindings, readable in global scope. */
    export const env: Record<string, unknown>;
}
