/**
 * Access rules engine: may a member come in right now? A pure function, ported from the web mock
 * (fitmanager-web src/app/mock/domain/access-rules.ts) with its table-driven cases in access-rules.test.ts.
 *
 * Changed from the mock by D-059: a member trains at EVERY branch, so there is no "own branch only" rule; the
 * dues limit is the member's HOME branch's, and the opening hours are the branch being entered.
 *
 * Every rule that fails is reported (not just the first), each with the reason the desk reads out and whether a
 * manager may override it. Order = the order shown on screen.
 *
 * Phase 5 (D-091, D-093): a suspension in force blocks every branch and a ban blocks the branches it covers; neither
 * is overridden at the desk (it is lifted, or overturned on appeal). A required policy not accepted blocks once its
 * grace period is over (`blocks_on`), and a manager may override that like any other rule.
 */
import { clock12, daysBetween, shortDate, taka } from '#src/lib/clock.ts';

export type AccessRuleId = 'membership' | 'expired' | 'frozen' | 'suspended' | 'banned' | 'dues' | 'policy' | 'hours' | 'already_in' | 'pending';
export type MemberStatus = 'Active' | 'Expired' | 'Frozen' | 'Suspended' | 'Banned' | 'Pending';

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
    /** Suspensions not overturned, anywhere, and the bans covering the branch entered (D-093). `branch_name`: where given. */
    sanctions?: {
        level: 'suspension' | 'ban';
        starts_on: string;
        ends_on: string | null;
        scope: 'branch' | 'all' | null;
        branch_name: string;
        reason: string;
    }[];
    /** Required policies the member has not accepted, and the first day each one blocks (D-091). */
    policies?: { title: string; blocks_on: string }[];
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
    for (const x of facts.sanctions ?? []) {
        if (x.level === 'suspension' && x.starts_on <= now.date && x.ends_on !== null && now.date <= x.ends_on)
            failures.push(fail('suspended', `Suspended until ${shortDate(x.ends_on)} (${x.branch_name}): ${x.reason}`, false));
        if (x.level === 'ban') failures.push(fail('banned', `Banned ${x.scope === 'all' ? 'from every branch' : `from ${x.branch_name}`}: ${x.reason}`, false));
    }

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

    const overdue = (facts.policies ?? []).filter(p => p.blocks_on <= now.date);
    if (overdue.length) {
        const names = overdue.map(p => p.title).join(', ');
        failures.push(fail('policy', `Not accepted: ${names}. Accept in the member portal or sign at the desk.`, true));
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
