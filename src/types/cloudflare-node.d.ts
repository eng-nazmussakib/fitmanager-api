/**
 * The one `cloudflare:node` export `src/worker.ts` uses. Declared here instead of adding `@cloudflare/workers-types`,
 * whose global `Request`/`Response` clash with Node's in the rest of the code.
 * https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
 */
declare module 'cloudflare:node' {
    /** Sends a Workers `Request` to the `node:http` server listening on `port` (a routing key, not a socket). */
    export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}
