import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { type MemberRow, membersRepo } from '#src/features/members/members.repo.ts';
import { addDays, daysBetween, dhakaInstant, dhakaNow } from '#src/lib/clock.ts';

/**
 * The branch and HQ dashboards (the web mock's `build()`, in SQL): KPIs with the change against the previous
 * period, revenue per day (per month beyond ~2 months), an attendance heatmap for the last 8 weeks, a branch
 * comparison and the members who need attention. A read model over members, money and visits. Revenue is
 * money received less refunds.
 */
interface BranchRef {
    oid: string;
    code: string;
    slug: string;
    name: string;
    kind: 'BRANCH';
}

const DAYS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function revenueByDay(tx: Queryable, branchOids: readonly string[], from: string, to: string) {
    return tx.query<{ branch_oid: string; day: string; amount: number }>(sql`
        select p.branch_oid, to_char(p.received_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD') as day,
            sum(case when p.kind = 'payment' then p.amount else -p.amount end)::float8 as amount
        from payment p
        where p.branch_oid = any (${branchOids}::uuid[]) and p.received_at >= ${dhakaInstant(from)} and p.received_at < ${dhakaInstant(addDays(to, 1))}
        group by 1, 2`);
}

async function visitsByDay(tx: Queryable, branchOids: readonly string[], from: string, to: string) {
    return tx.query<{ branch_oid: string; day: string; n: number }>(sql`
        select c.branch_oid, to_char(c.in_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD') as day, count(*)::int as n
        from check_in c
        where c.branch_oid = any (${branchOids}::uuid[]) and c.in_at >= ${dhakaInstant(from)} and c.in_at < ${dhakaInstant(addDays(to, 1))}
        group by 1, 2`);
}

export async function dashboard(db: Db, ctx: BranchContext, branchOids: readonly string[], from: string, to: string, nowAt: Date) {
    const today = dhakaNow(nowAt).date;
    const len = daysBetween(from, to) + 1;
    const prevFrom = addDays(from, -len);
    const prevTo = addDays(from, -1);
    return withBranchTx(db, ctx, async tx => {
        const branches = await tx.query<BranchRef & { dues_limit: number }>(sql`
            select oid, code, slug, name, kind, dues_limit::float8 as dues_limit from branch where oid = any (${branchOids}::uuid[]) and kind = 'BRANCH' order by name`);
        const oids = branches.map(b => b.oid);
        const members: MemberRow[] = oids.length ? await membersRepo.states(tx, oids, today) : [];
        const revenue = await revenueByDay(tx, oids, prevFrom, to);
        const visits = await visitsByDay(tx, oids, addDays(today, -55) < prevFrom ? addDays(today, -55) : prevFrom, today > to ? today : to);
        const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
        const ref = (b: BranchRef): BranchRef => ({ oid: b.oid, code: b.code, slug: b.slug, name: b.name, kind: 'BRANCH' });

        const revIn = (b: string, a: string, z: string) =>
            sum(
                revenue.filter(r => r.branch_oid === b && r.day >= a && r.day <= z),
                r => r.amount
            );
        const visitsOn = (b: string, day: string) =>
            sum(
                visits.filter(v => v.branch_oid === b && v.day === day),
                v => v.n
            );
        const mine = (b: string) => members.filter(m => m.branch_oid === b);
        const per = (f: (b: string) => number) => branches.map(b => ({ branch: ref(b), value: f(b.oid) }));
        const kpi = (id: string, label: string, money: boolean, values: { branch: BranchRef; value: number }[], previous: number | null) => {
            const value = sum(values, v => v.value);
            return { id, label, money, value, delta_pct: previous ? Math.round(((value - previous) / previous) * 1000) / 10 : null, by_branch: values };
        };
        const activeOf = (b: string) => mine(b).filter(m => m.status === 'Active').length;
        const duesOf = (b: string) => sum(mine(b), m => m.dues);
        const newIn = (b: string, a: string, z: string) => mine(b).filter(m => m.joined_on >= a && m.joined_on <= z).length;
        const expiringOf = (b: string) => mine(b).filter(m => m.status === 'Active' && m.days_left !== null && m.days_left >= 0 && m.days_left <= 7).length;

        const kpis = [
            kpi('active_members', 'Active members', false, per(activeOf), null),
            kpi(
                'revenue',
                'Revenue',
                true,
                per(b => revIn(b, from, to)),
                sum(oids, b => revIn(b, prevFrom, prevTo))
            ),
            kpi('dues', 'Outstanding dues', true, per(duesOf), null),
            kpi(
                'check_ins_today',
                'Check-ins today',
                false,
                per(b => visitsOn(b, today)),
                sum(oids, b => visitsOn(b, addDays(today, -7)))
            ),
            kpi(
                'new_members',
                'New members',
                false,
                per(b => newIn(b, from, to)),
                sum(oids, b => newIn(b, prevFrom, prevTo))
            ),
            kpi('expiring_7d', 'Expiring in 7 days', false, per(expiringOf), null)
        ];

        const monthly = len > 62;
        const buckets: string[] = [];
        if (monthly) for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) buckets.push(m);
        else for (let x = from; x <= to; x = addDays(x, 1)) buckets.push(x);
        const revenueTrend = branches.map(b => ({
            label: b.name,
            points: buckets.map(k => ({
                x: monthly ? `${MONTHS[Number(k.slice(5, 7)) - 1] ?? ''} ${k.slice(2, 4)}` : k,
                y: sum(
                    revenue.filter(r => r.branch_oid === b.oid && r.day >= from && r.day <= to && (monthly ? r.day.startsWith(k) : r.day === k)),
                    r => r.amount
                )
            }))
        }));

        const since = addDays(today, -55);
        const hourly = oids.length
            ? await tx.query<{ dow: number; hour: number; n: number }>(sql`
                select extract(dow from c.in_at at time zone 'Asia/Dhaka')::int as dow, extract(hour from c.in_at at time zone 'Asia/Dhaka')::int as hour, count(*)::int as n
                from check_in c where c.branch_oid = any (${oids}::uuid[]) and c.in_at >= ${dhakaInstant(since)} and c.in_at < ${dhakaInstant(addDays(today, 1))}
                group by 1, 2`)
            : [];
        const grid = DAYS.map(() => Array.from({ length: 17 }, () => 0));
        for (const h of hourly) if (h.hour >= 6 && h.hour <= 22) (grid[(h.dow + 1) % 7] ?? [])[h.hour - 6] = h.n;
        const attendanceHeatmap = DAYS.map((day, k) => ({ day, hours: (grid[k] ?? []).map(n => Math.round((n / 8) * 10) / 10) }));

        // Retention: of the plans that ended 14 to 90 days ago, how many were followed by another within 14 days.
        const retention = oids.length
            ? await tx.query<{ branch_oid: string; ended: number; renewed: number }>(sql`
                select s.home_branch_oid as branch_oid, count(*)::int as ended,
                    count(*) filter (where exists (select 1 from subscription n where n.member_oid = s.member_oid and n.kind = 'membership' and n.start_date > s.start_date
                        and n.start_date <= s.end_date + 14 and n.oid <> s.oid))::int as renewed
                from subscription s
                where s.home_branch_oid = any (${oids}::uuid[]) and s.end_date >= ${addDays(today, -90)}::date and s.end_date < ${addDays(today, -14)}::date
                    and s.cancelled_at is null and s.kind = 'membership'
                group by 1`)
            : [];
        const comparison = branches.map(b => {
            const r = retention.find(x => x.branch_oid === b.oid);
            const v = sum(
                visits.filter(x => x.branch_oid === b.oid && x.day >= from && x.day <= to),
                x => x.n
            );
            return {
                branch: ref(b),
                members: activeOf(b.oid),
                revenue: revIn(b.oid, from, to),
                dues: duesOf(b.oid),
                avg_daily_visits: Math.round((v / len) * 10) / 10,
                retention_pct: r?.ended ? Math.round((r.renewed / r.ended) * 100) : 0
            };
        });

        const attention: {
            kind: 'dues' | 'suspended' | 'expiring';
            member_oid: string;
            member_name: string;
            member_code: string;
            branch: BranchRef;
            detail: string;
        }[] = [];
        for (const m of members) {
            const b = branches.find(x => x.oid === m.branch_oid);
            if (!b) continue;
            const base = { member_oid: m.oid, member_name: m.name, member_code: m.code, branch: ref(b) };
            if (m.status === 'Suspended') attention.push({ ...base, kind: 'suspended', detail: m.suspended_reason ?? 'Suspended' });
            if (m.dues > b.dues_limit)
                attention.push({ ...base, kind: 'dues', detail: `Owes ৳${m.dues.toLocaleString('en-IN')} (limit ৳${b.dues_limit.toLocaleString('en-IN')})` });
            if (m.status === 'Active' && m.days_left !== null && m.days_left >= 0 && m.days_left <= 3) {
                attention.push({
                    ...base,
                    kind: 'expiring',
                    detail: m.days_left === 0 ? 'Expires today' : `Expires in ${m.days_left} day${m.days_left === 1 ? '' : 's'}`
                });
            }
        }
        const order = { suspended: 0, dues: 1, expiring: 2 };
        attention.sort((a, b) => order[a.kind] - order[b.kind]);
        return { from, to, kpis, revenue_trend: revenueTrend, attendance_heatmap: attendanceHeatmap, comparison, attention: attention.slice(0, 30) };
    });
}
