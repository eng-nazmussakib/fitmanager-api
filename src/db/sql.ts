/**
 * A tagged template for parameterised SQL: every `${value}` becomes a `$n` placeholder, never text.
 *
 *     sql`select * from item where oid = ${oid} and status = ${status}`
 *     → { text: 'select * from item where oid = $1 and status = $2', values: [oid, status] }
 *
 * Fragments compose (`sql`... ${where} ...``), so dynamic filters need no manual `$n` counting. Why it matters
 * here: the ACAS admin API built `limit ${request.query.limit} offset ${request.query.offset}` straight into SQL
 * strings (injectable), and every service concatenated `${SCHEMA.PUBLIC}${TABLE.X}` for names. Identifiers that
 * really must be dynamic (an ORDER BY column) go through `sql.raw`, from a whitelist, never from input.
 */
export class Sql {
    readonly strings: string[];
    readonly values: unknown[];

    constructor(rawStrings: readonly string[], rawValues: readonly unknown[]) {
        this.strings = [];
        this.values = [];
        let current = rawStrings[0] ?? '';
        rawValues.forEach((child, i) => {
            const next = rawStrings[i + 1] ?? '';
            if (child instanceof Sql) {
                // Splice the fragment in: its text joins ours, its values join ours (renumbered by `text`).
                current += child.strings[0] ?? '';
                child.values.forEach((v, j) => {
                    this.strings.push(current);
                    this.values.push(v);
                    current = child.strings[j + 1] ?? '';
                });
                current += next;
            } else {
                this.strings.push(current);
                this.values.push(child);
                current = next;
            }
        });
        this.strings.push(current);
    }

    get text(): string {
        return this.strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
    }
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
    return new Sql(strings, values);
}

/** Trusted SQL text. Only for constants and whitelisted identifiers. */
sql.raw = (text: string): Sql => new Sql([text], []);

/** `sql.join([sql`a = ${1}`, sql`b = ${2}`], ' and ')` */
sql.join = (parts: readonly Sql[], separator = ', '): Sql =>
    parts.length === 0 ? sql.raw('') : new Sql(['', ...Array<string>(parts.length - 1).fill(separator), ''], parts);

/** `where ${sql.where([...])}`, or `true` when there are no conditions. */
sql.where = (conditions: readonly (Sql | false | null | undefined)[]): Sql => {
    const present = conditions.filter((c): c is Sql => c instanceof Sql);
    return present.length ? sql.join(present, ' and ') : sql.raw('true');
};

/** A LIKE pattern that matches `text` literally: `50%_off` must not match everything. */
export function containsPattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

/** Postgres error code (23505 unique, 23503 foreign key…) from a pg or PGlite error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}
