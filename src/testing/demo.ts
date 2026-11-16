/**
 * Ids and accounts from the demo seed (`fitmanager-infra/db/seeds/demo/001_branches_and_staff.sql`), for tests
 * and `requests.http`. The seed is the source; keep these in step with it.
 */
export const DEMO_BRANCHES = {
    HQ: { oid: '00000000-0000-4000-8000-000000000001', code: 'HQ', slug: 'hq' },
    GUL: { oid: '00000000-0000-4000-8000-000000000002', code: 'GUL', slug: 'gulshan' },
    DHA: { oid: '00000000-0000-4000-8000-000000000003', code: 'DHA', slug: 'dhanmondi' },
    UTT: { oid: '00000000-0000-4000-8000-000000000004', code: 'UTT', slug: 'uttara' }
} as const;
