import type { AuthContext } from '#src/auth/middleware.ts';

declare module 'express-serve-static-core' {
    interface Request {
        /** Set by the `authenticate` middleware. */
        auth?: AuthContext;
    }
}
