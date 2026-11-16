import { containsPattern, sql } from './sql.ts';

describe('sql tagged template', () => {
    it('turns every interpolation into a numbered placeholder', () => {
        const q = sql`select * from item where oid = ${'a'} and status = ${'Active'}`;
        expect(q.text).toBe('select * from item where oid = $1 and status = $2');
        expect(q.values).toEqual(['a', 'Active']);
    });

    it('composes fragments and renumbers their placeholders', () => {
        const where = sql.where([sql`a = ${1}`, false, undefined, sql`b = ${2}`]);
        const q = sql`select 1 from t where ${where} limit ${10}`;
        expect(q.text).toBe('select 1 from t where a = $1 and b = $2 limit $3');
        expect(q.values).toEqual([1, 2, 10]);
    });

    it('treats a value that looks like SQL as data', () => {
        const q = sql`select * from item limit ${'10; drop table item'}`;
        expect(q.text).toBe('select * from item limit $1');
    });

    it('where() with no conditions is `true`; raw() and join() insert trusted text', () => {
        expect(sql`x ${sql.where([])}`.text).toBe('x true');
        expect(sql`order by ${sql.raw('i.code desc')}`.text).toBe('order by i.code desc');
        expect(sql.join([sql`${1}`, sql`${2}`]).text).toBe('$1, $2');
    });

    it('escapes LIKE wildcards', () => {
        expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    });
});
