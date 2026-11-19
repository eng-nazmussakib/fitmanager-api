/**
 * Access rules engine: may a member come in right now? A pure function, ported from the web mock
 * (fitmanager-web src/app/mock/domain/access-rules.ts) with its table-driven cases in access-rules.test.ts.
 *
 * Changed from the mock by D-059: a member trains at EVERY branch, so there is no "own branch only" rule; the
 * dues limit is the member's HOME branch's, and the opening hours are the branch being entered.
 *
 * Every rule that fails is reported (not just the first), each with the reason the desk reads out and whether a
 * manager may override it. Order = the order shown on screen.
 */
import { clock12, daysBetween, shortDate, taka } from '#src/lib/clock.ts';

export type AccessRuleId = 'membership' | 'expired' | 'frozen' | 'suspended' | 'dues' | 'hours' | 'already_in' | 'pending';
export type MemberStatus = 'Active' | 'Expired' | 'Frozen' | 'Suspended' | 'Pending';

export interface RuleFailure {
    rule: AccessRuleId;
    message: string;
    overridable: boolean;
}

export interface AccessFacts {
    member: { status: MemberStatus; dues: number; home_branch_name: string; dues_limit: number };
    /** The member's current (or most relevant) subscription. */
    subscription: { start_date: string; end_date: string; freezes: { from: string; to: string }[] } | null;
    /** The branch being entered: its opening hours. */
    branch: { name: string; hours: { days: number[]; open: string; close: string }[] };
    /** An open visit (not checked out), anywhere: its branch and time. */
    open_check_in: { branch_name: string; time: string } | null;
}

/** "Now" at the branch, in Asia/Dhaka. */
export interface AccessClock {
    date: string;
    time: string;
    weekday: number;
}

const fail = (rule: AccessRuleId, message: string, overridable: boolean): RuleFailure => ({ rule, message, overridable });

export function evaluateAccess(facts: AccessFacts, now: AccessClock): RuleFailure[] {
    const failures: RuleFailure[] = [];
    const { member, subscription: sub, branch } = facts;

    if (member.status === 'Pending') failures.push(fail('pending', 'Join request only: the membership starts with the first payment.', false));
    if (member.status === 'Suspended') failures.push(fail('suspended', 'Membership suspended by the branch.', true));

    if (!sub) {
        if (member.status !== 'Pending') failures.push(fail('membership', 'No membership on record.', false));
    } else if (now.date < sub.start_date) {
        failures.push(fail('membership', `Membership starts on ${shortDate(sub.start_date)}.`, true));
    } else if (now.date > sub.end_date) {
        const ago = daysBetween(sub.end_date, now.date);
        failures.push(fail('expired', `Subscription expired ${ago === 1 ? 'yesterday' : `${ago} days ago`} (${shortDate(sub.end_date)}).`, true));
    } else {
        const freeze = sub.freezes.find(f => f.from <= now.date && now.date <= f.to);
        if (freeze) failures.push(fail('frozen', `Membership frozen until ${shortDate(freeze.to)}.`, true));
    }

    if (member.dues > member.dues_limit) {
        failures.push(fail('dues', `Dues ${taka(member.dues)} exceed the limit of ${taka(member.dues_limit)} (${member.home_branch_name}).`, true));
    }

    const today = branch.hours.filter(h => h.days.includes(now.weekday));
    const open = today.some(h => h.open <= now.time && now.time < h.close);
    if (!open) {
        const next = today.find(h => now.time < h.open);
        failures.push(fail('hours', next ? `${branch.name} opens at ${clock12(next.open)} today.` : `${branch.name} is closed for the day.`, true));
    }

    if (facts.open_check_in) {
        failures.push(
            fail('already_in', `Already checked in at ${facts.open_check_in.branch_name} at ${clock12(facts.open_check_in.time)}. Check out first.`, false)
        );
    }
    return failures;
}
