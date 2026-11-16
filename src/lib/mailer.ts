import nodemailer from 'nodemailer';

import { log } from './logger.ts';

/**
 * Outgoing mail with nodemailer. SMTP_URL (`smtps://user:pass@smtp.example.com:465`) in real environments;
 * without it, development logs each message instead of sending it, and tests use the in-memory mailer.
 *
 * The OMS `send-email-otp` route built its own transporter inside the request handler; here there is one,
 * created at startup with a connection pool, and closed on shutdown.
 */
export interface MailMessage {
    to: string[];
    subject: string;
    html: string;
    text?: string;
}

export interface Mailer {
    send(message: MailMessage): Promise<{ messageId: string }>;
    close(): void;
}

export function createMailer(opts: { smtpUrl?: string | undefined; from: string; logBodies: boolean }): Mailer {
    if (!opts.smtpUrl) {
        return {
            send: message => {
                // Development only: the body is logged so OTP codes can be read in the console.
                log().info(
                    { mail: { to: message.to, subject: message.subject, ...(opts.logBodies ? { text: message.text } : {}) } },
                    'Mail (not sent: no SMTP_URL)'
                );
                return Promise.resolve({ messageId: `logged-${Date.now()}` });
            },
            close: () => undefined
        };
    }
    const transport = nodemailer.createTransport(opts.smtpUrl, { from: opts.from });
    return {
        async send(message) {
            const info = await transport.sendMail({ ...message, from: opts.from });
            return { messageId: info.messageId };
        },
        close: () => {
            transport.close();
        }
    };
}

/** Collects messages instead of sending them (tests). */
export function createMemoryMailer(): Mailer & { sent: MailMessage[] } {
    const sent: MailMessage[] = [];
    return {
        sent,
        send(message) {
            sent.push(message);
            return Promise.resolve({ messageId: `memory-${sent.length}` });
        },
        close: () => undefined
    };
}
