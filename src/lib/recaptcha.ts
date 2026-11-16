import { log } from './logger.ts';

/**
 * reCAPTCHA v3 check for the sign-in form (the frontends send `recaptcha_token` when they have a site key).
 *
 * The SPN helper posted `secret=…&response=…` built by string concatenation (unencoded), with axios and no
 * timeout, and looked only at `success`. Here: native fetch, URL-encoded body, a 5 s timeout, and the v3 `score`
 * and `action` are checked too (a token minted for another form, or with a bot-like score, is refused).
 * Without RECAPTCHA_SECRET the check is off (development).
 */
export type RecaptchaVerifier = (token: string | undefined, action: string, ip: string | undefined) => Promise<boolean>;

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

export function createRecaptchaVerifier(cfg: { secret?: string | undefined; minScore: number }, fetchImpl: typeof fetch = fetch): RecaptchaVerifier {
    const { secret } = cfg;
    if (!secret) return () => Promise.resolve(true);
    return async (token, action, ip) => {
        if (!token) return false;
        try {
            const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
            const res = await fetchImpl(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
            const result = (await res.json()) as { success?: boolean; score?: number; action?: string; 'error-codes'?: string[] };
            const passed = result.success === true && (result.score ?? 1) >= cfg.minScore && (result.action === undefined || result.action === action);
            if (!passed) log().warn({ score: result.score, action: result.action, errors: result['error-codes'] }, 'reCAPTCHA rejected');
            return passed;
        } catch (err) {
            log().error({ err }, 'reCAPTCHA verification failed');
            return false; // fail closed: an unreachable verifier must not switch the bot check off
        }
    };
}
