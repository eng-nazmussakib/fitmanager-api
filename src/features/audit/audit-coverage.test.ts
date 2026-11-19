import { createTestApp, type TestApp } from '#src/testing/test-app.ts';

/**
 * Phase 1 exit: every write produces an audit entry. This test lists every write route the app mounts and fails
 * when a route is in neither list below, so a new POST/PUT/PATCH/DELETE cannot ship without a decision:
 * - AUDITED: the route writes an audit row in the same transaction; the value names the test that proves it.
 * - EXEMPT: the route writes nothing that belongs in the audit log; the value says why.
 */
const AUDITED: Record<string, string> = {
    'PATCH /v1/hq/site-groups/:key': 'site.test.ts › site groups: audit log',
    'PATCH /v1/hq/settings': 'settings.test.ts › settings: audit log',
    'POST /v1/members': 'members.test.ts › members: RLS and audit',
    'PATCH /v1/members/:oid': 'members.test.ts › members: RLS and audit',
    'POST /v1/members/:oid/suspend': 'members.test.ts › suspend needs a manager (timeline reads the audit rows)',
    'POST /v1/members/:oid/unsuspend': 'members.test.ts › suspend needs a manager (timeline reads the audit rows)',
    'POST /v1/members/:oid/transfer': 'members.test.ts › a manager moves a member home (audited at both)',
    'POST /v1/members/:oid/anonymise': 'members.test.ts › anonymise',
    'POST /v1/subscriptions': 'sales.test.ts › sales: audit log',
    'POST /v1/subscriptions/:oid/freeze': 'sales.test.ts › sales: audit log',
    'POST /v1/subscriptions/:oid/cancel': 'sales.test.ts › sales: audit log',
    'POST /v1/subscriptions/:oid/upgrade': 'sales.test.ts › sales: audit log',
    'POST /v1/payments': 'sales.test.ts › sales: audit log',
    'POST /v1/invoices/:oid/refund': 'sales.test.ts › sales: audit log',
    'POST /v1/cash-closing': 'sales.test.ts › sales: audit log (cash_closing close)',
    'POST /v1/attendance/check-in': 'attendance.test.ts › attendance: RLS and audit',
    'POST /v1/attendance/:oid/check-out': 'attendance.test.ts › attendance: RLS and audit',
    'POST /v1/attendance/backdated': 'attendance.test.ts › attendance: RLS and audit',
    'POST /v1/members/:oid/portal-access': 'portal.test.ts › portal access is audited at the branch',
    'POST /v1/files/:oid/complete': 'files.test.ts › files: audit log',
    'DELETE /v1/files/:oid': 'files.test.ts › files: audit log',
    'PATCH /v1/hq/branches/:oid': 'branches.test.ts › branches: audit log',
    'POST /v1/hq/plans': 'plans.test.ts › plans: audit log',
    'PATCH /v1/hq/plans/:oid': 'plans.test.ts › plans: audit log',
    'POST /v1/hq/plan-templates': 'plans.test.ts › plans: audit log',
    'PATCH /v1/hq/plan-templates/:oid': 'plans.test.ts › plans: audit log',
    'POST /v1/hq/promos': 'plans.test.ts › plans: audit log',
    'PATCH /v1/hq/promos/:code': 'plans.test.ts › plans: audit log',
    'POST /v1/hq/staff': 'staff.test.ts › staff: audit log',
    'PATCH /v1/hq/staff/:oid': 'staff.test.ts › staff: audit log',
    'PUT /v1/hq/staff/:oid/assignments': 'staff.test.ts › staff: audit log',
    'POST /v1/hq/staff/:oid/deactivate': 'staff.test.ts › staff: audit log',
    'POST /v1/hq/staff/:oid/activate': 'staff.test.ts › staff: audit log',
    'POST /v1/hq/staff/:oid/reset-password': 'staff.test.ts › staff: audit log',
    'POST /v1/hq/staff/:oid/sign-out': 'staff.test.ts › staff: audit log',
    'POST /v1/branch/staff': 'staff.test.ts › staff: audit log',
    'PATCH /v1/branch/staff/:oid': 'staff.test.ts › staff: audit log',
    'PUT /v1/branch/staff/:oid/role': 'staff.test.ts › staff: audit log',
    'DELETE /v1/branch/staff/:oid': 'staff.test.ts › staff: audit log',
    'POST /v1/branch/staff/:oid/deactivate': 'staff.test.ts › staff: audit log',
    'POST /v1/branch/staff/:oid/activate': 'staff.test.ts › staff: audit log',
    'POST /v1/branch/staff/:oid/reset-password': 'staff.test.ts › staff: audit log',
    'POST /v1/branch/staff/:oid/sign-out': 'staff.test.ts › staff: audit log'
};

const EXEMPT: Record<string, string> = {
    'POST /v1/auth/login': 'session start; the session itself is the refresh_token row (user, time, user agent)',
    'POST /v1/auth/refresh': 'token rotation inside an existing session (refresh_token rows)',
    'POST /v1/auth/logout': 'session end (refresh_token revoked_at)',
    'POST /v1/auth/change-password': "the user's own password (no branch context; app_user.updated_at, sessions revoked)",
    'DELETE /v1/auth/sessions/:id': 'the user ends one of their own sessions (refresh_token revoked_at)',
    'POST /v1/subscriptions/quote': 'computes a price, stores nothing',
    'POST /v1/public/enquiries': 'creates a Pending member through createMember, which writes the audit row (members.test.ts)',
    'POST /v1/public/join-requests': 'creates a Pending member through createMember, which writes the audit row (members.test.ts)',
    'POST /v1/attendance/evaluate': 'an access decision, stores nothing',
    'POST /v1/files': 'a pending row and an upload URL only; the file is audited when it is completed',
    'PUT /v1/files/:oid/content': "the local store's upload target (bytes only); audited on completion"
};

interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
}

function writeRoutes(stack: Layer[]): string[] {
    const out: string[] = [];
    for (const layer of stack) {
        if (layer.route) {
            for (const [method, on] of Object.entries(layer.route.methods))
                if (on && !['get', 'head', 'options', '_all'].includes(method)) out.push(`${method.toUpperCase()} ${layer.route.path}`);
        } else if (layer.handle?.stack) out.push(...writeRoutes(layer.handle.stack));
    }
    return out;
}

let t: TestApp;
beforeAll(async () => {
    t = await createTestApp();
});
afterAll(() => t.close());

describe('audit coverage', () => {
    it('every write route is either audited or exempt with a reason', () => {
        const routes = writeRoutes((t.app as unknown as { router: { stack: Layer[] } }).router.stack);
        expect(routes.length).toBeGreaterThan(5); // the walk found the routers
        const undecided = routes.filter(r => !(r in AUDITED) && !(r in EXEMPT));
        expect(undecided, 'add these to AUDITED (with a test) or EXEMPT (with a reason)').toEqual([]);
        const stale = [...Object.keys(AUDITED), ...Object.keys(EXEMPT)].filter(r => !routes.includes(r));
        expect(stale, 'routes listed here no longer exist').toEqual([]);
    });
});
