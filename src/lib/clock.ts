/**
 * Time for the business rules, always in Asia/Dhaka (UTC+6 all year, no daylight saving). The API reads "now"
 * from `deps.clock` so tests can stand at any date and hour; nothing else calls `new Date()` for a rule.
 */
const DHAKA_OFFSET_MS = 6 * 60 * 60_000;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export interface DhakaNow {
    /** `yyyy-MM-dd` */
    date: string;
    /** `HH:mm` */
    time: string;
    /** 0 = Sunday … 6 = Saturday. */
    weekday: number;
    /** The instant, for timestamps. */
    at: Date;
}

export function dhakaNow(at: Date): DhakaNow {
    const local = new Date(at.getTime() + DHAKA_OFFSET_MS);
    const iso = local.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: local.getUTCDay(), at };
}

/** `2026-11-19` + 3 → `2026-11-22`. */
export function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The instant a Dhaka date and time stand for: (`2026-11-19`, `23:00`) → 2026-11-19T17:00:00Z. */
export function dhakaInstant(date: string, time = '00:00'): Date {
    return new Date(Date.parse(`${date}T${time}:00Z`) - DHAKA_OFFSET_MS);
}

/** `2026-03-05` → `5 Mar 2026` (the mock's shortDate). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso: string): string {
    const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
}

/** `18:05` → `6:05 pm`. */
export function clock12(hhmm: string): string {
    const [h = 0, m = 0] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export const taka = (n: number): string => `৳${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)}`;

/** An instant as Dhaka wall time with its offset: `2026-11-20T18:00:00+06:00` (classes and PT sessions on the wire). */
export function dhakaIso(at: Date): string {
    return `${new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 19)}+06:00`;
}
