import { endOf, firstClosedDay, freeSlots, isFreeSlot, overlaps, withinHours } from './hours.ts';

const HOURS = [
    { days: [6, 0, 1, 2, 3, 4], open: '07:00', close: '23:00' },
    { days: [5], open: '16:00', close: '21:00' }
];

describe('opening hours', () => {
    it.each([
        [0, '07:00', '07:45', true],
        [0, '06:30', '07:15', false],
        [0, '22:30', '23:00', true],
        [0, '22:30', '23:30', false],
        [5, '17:00', '18:00', true],
        [5, '10:00', '11:00', false]
    ])('weekday %i, %s to %s → %s', (day, start, end, expected) => {
        expect(withinHours(HOURS, day, start, end)).toBe(expected);
    });

    it('names the first weekday a weekly rule does not fit', () => {
        expect(firstClosedDay(HOURS, [6, 0, 1], '07:00', '07:45')).toBeNull();
        expect(firstClosedDay(HOURS, [4, 5], '10:30', '11:15')).toBe(5);
    });

    it('ends on the same day or not at all', () => {
        expect(endOf('19:30', 50)).toBe('20:20');
        expect(endOf('23:30', 45)).toBeNull();
    });

    it.each([
        ['07:00', '08:00', '07:30', '08:30', true],
        ['07:00', '08:00', '08:00', '09:00', false],
        ['2026-11-20T10:00', '2026-11-20T11:00', '2026-11-20T09:00', '2026-11-20T10:30', true]
    ])('[%s, %s) and [%s, %s) overlap: %s', (a1, a2, b1, b2, expected) => {
        expect(overlaps(a1, a2, b1, b2)).toBe(expected);
    });
});

describe('free PT slots', () => {
    const base = { availability: [{ start: '07:00', end: '12:00' }], hours: HOURS, weekday: 0, busy: [], length: 60 };

    it('every half hour that fits inside the availability', () => {
        expect(freeSlots(base)).toEqual(['07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00']);
    });

    it('leaves out what clashes, what is past, and what the branch hours cut off', () => {
        const busy = [{ start: '08:30', end: '09:30' }];
        expect(freeSlots({ ...base, busy, notBefore: '07:15' })).toEqual(['07:30', '09:30', '10:00', '10:30', '11:00']);
        expect(freeSlots({ ...base, weekday: 5 })).toEqual([]); // Friday opens at 4 pm
    });

    it('checks one start', () => {
        expect(isFreeSlot({ ...base, start: '10:00' })).toBe(true);
        expect(isFreeSlot({ ...base, start: '11:30' })).toBe(false);
        expect(isFreeSlot({ ...base, start: '08:00', notBefore: '09:00' })).toBe(false);
    });
});
