import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Handlebars from 'handlebars';

/**
 * Handlebars templates (mail bodies, PDF reports), as in the OMS/IMS services, with two changes:
 * - compiled ONCE and cached, not `fs.readFileSync` + `compile` on every request;
 * - `strict: true`: a misspelled field throws instead of silently rendering an empty string.
 * `{{x}}` escapes HTML; `{{{x}}}` does not and is only for already-sanitised HTML.
 */
const DIR = join(import.meta.dirname, '../templates');
const compiled = new Map<string, Handlebars.TemplateDelegate>();

const hbs = Handlebars.create();
hbs.registerHelper('inc', (n: number) => n + 1);
/** `{{taka amount}}` → ৳12,50,000.00 (lakh/crore grouping). */
const TAKA = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
hbs.registerHelper('taka', (n: number) => `৳${TAKA.format(n)}`);

export function render(name: string, data: object): string {
    let template = compiled.get(name);
    if (!template) {
        template = hbs.compile(readFileSync(join(DIR, `${name}.hbs`), 'utf8'), { strict: true });
        compiled.set(name, template);
    }
    return template(data);
}
