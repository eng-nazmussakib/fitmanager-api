import puppeteer, { type Browser } from 'puppeteer-core';

import { AppError } from './http.ts';
import { log } from './logger.ts';

/**
 * Server-side PDF from an HTML template with headless Chrome (puppeteer-core), the OMS approach. HTML and CSS give
 * full layout control (tables, badges, page breaks), which PDFKit does not. Fixes of the OMS code:
 * - OMS launched a whole new browser per request, and never closed it when rendering threw (a leak per failed
 *   report). Here ONE browser is started lazily and reused; each render gets a page that is always closed.
 * - At most MAX_PAGES renders at a time; further requests wait their turn instead of starting more Chromes.
 * - JavaScript and every network request are disabled on the page: the HTML is our template, so it needs
 *   neither, and an injected `<img src="http://internal/…">` can do nothing (server-side request forgery).
 * - `puppeteer-core` downloads no browser on `npm install`; the Docker image installs Chromium from the distro.
 *
 * node-jasper (SPN, ARDS, OMS) is not carried over: last published in 2016, it drives a JVM through a native
 * bridge, so every image needs Java. Keep JasperReports as its own service if reports must stay in .jrxml.
 */
const MAX_PAGES = 3;

export interface PdfRenderer {
    render(html: string): Promise<Uint8Array>;
    close(): Promise<void>;
}

export function createPdfRenderer(chromePath: string | undefined): PdfRenderer {
    let browser: Promise<Browser> | undefined;
    let active = 0;
    const waiting: (() => void)[] = [];

    const getBrowser = (): Promise<Browser> => {
        if (!chromePath) throw new AppError(501, 'PDF rendering is not configured on this server (CHROME_PATH)');
        browser ??= puppeteer
            .launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] })
            .then(b => {
                b.on('disconnected', () => (browser = undefined)); // crashed: the next render starts a new one
                return b;
            })
            .catch((err: unknown) => {
                browser = undefined;
                throw err;
            });
        return browser;
    };

    const acquire = async (): Promise<void> => {
        if (active >= MAX_PAGES) await new Promise<void>(resolve => waiting.push(resolve));
        active++;
    };
    const release = (): void => {
        active--;
        waiting.shift()?.();
    };

    return {
        async render(html) {
            const b = await getBrowser();
            await acquire();
            const page = await b.newPage();
            try {
                await page.setJavaScriptEnabled(false);
                await page.setRequestInterception(true);
                page.on('request', req => {
                    if (req.url().startsWith('data:')) void req.continue();
                    else void req.abort();
                });
                await page.setContent(html, { waitUntil: 'load' });
                return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
            } finally {
                await page.close().catch((err: unknown) => {
                    log().warn({ err }, 'Could not close PDF page');
                });
                release();
            }
        },
        async close() {
            const b = await browser?.catch(() => undefined);
            browser = undefined;
            await b?.close();
        }
    };
}
