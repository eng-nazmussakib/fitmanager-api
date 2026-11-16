import { Router } from 'express';
import sanitizeHtml from 'sanitize-html';
import * as v from 'valibot';

import { authenticate, requireAbility } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { ok, parse } from '#src/lib/http.ts';
import { log } from '#src/lib/logger.ts';
import { createLimiter } from '#src/lib/rate-limit.ts';
import { render } from '#src/lib/templates.ts';

const schema = v.strictObject({
    to: v.pipe(v.array(v.pipe(v.string(), v.email())), v.minLength(1), v.maxLength(10)),
    subject: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(150)),
    body: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000))
});

/**
 * Only what the rich-text editor (TipTap in React, ngx-editor in Angular) produces. The frontend sanitises with
 * DOMPurify for DISPLAY; the server must sanitise again before the HTML goes into someone's mailbox, because a
 * request can be sent without the frontend.
 */
const ALLOWED_HTML: sanitizeHtml.IOptions = {
    allowedTags: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a'],
    allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['style'] },
    allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) }
};

/** The editor demo's "send": HTML body → sanitised → layout template → mailer. */
export function mailRouter(deps: AppDeps): Router {
    const router = Router();
    const limiter = createLimiter({ name: 'mail', windowMs: 60_000, limit: 10, redis: deps.redis, key: req => req.auth?.user.oid ?? 'anonymous' });

    router.post('/v1/mail/send', authenticate(deps), requireAbility('manage', 'Settings'), limiter, async (req, res) => {
        const { to, subject, body } = parse(schema, req.body);
        const html = render('mail/layout', { subject, body: sanitizeHtml(body, ALLOWED_HTML) });
        const text = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} });
        const { messageId } = await deps.mailer.send({ to, subject, html, text });
        log().info({ messageId, recipients: to.length }, 'Mail sent');
        ok(res, { message_id: messageId }, 'Email sent');
    });

    return router;
}
