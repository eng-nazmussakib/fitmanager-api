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
    'POST /v1/branch/staff/:oid/sign-out': 'staff.test.ts › staff: audit log',
    // Phase 7a (D-107): the first page of an export writes the audit row.
    'POST /v1/exports/members': 'exports.test.ts › the member list: … one audit row for the first page only',
    'POST /v1/exports/payments': 'exports.test.ts › payments in a range, a page at a time',
    'POST /v1/exports/stock': 'exports.test.ts › stock, with the costs for a manager',
    'POST /v1/exports/audit': 'exports.test.ts › the audit log, at HQ and at a branch',
    'POST /v1/exports/report': 'exports.test.ts › a report table: only the audit row',
    'POST /v1/website/posts': 'website.test.ts › the blog: create, update, delete audited',
    'PATCH /v1/website/posts/:oid': 'website.test.ts › the blog',
    'DELETE /v1/website/posts/:oid': 'website.test.ts › the blog',
    'POST /v1/website/categories': 'website.test.ts › the blog (blog_category)',
    'POST /v1/website/offers': 'website.test.ts › offers',
    'PATCH /v1/website/offers/:oid': 'website.test.ts › offers',
    'DELETE /v1/website/offers/:oid': 'website.test.ts › offers (delete, audited like posts)',
    'POST /v1/website/gallery': 'website.test.ts › the gallery (gallery_item)',
    'PATCH /v1/website/gallery/:oid': 'website.test.ts › the gallery',
    'DELETE /v1/website/gallery/:oid': 'website.test.ts › the gallery',
    'PUT /v1/website/branch': 'website.test.ts › branch pages (branch_page)',
    // Phase 3 (D-078 to D-083)
    'POST /v1/trainers': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PATCH /v1/trainers/:oid': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PUT /v1/trainers/:oid/availability': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/trainers/:oid/leave': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'DELETE /v1/trainers/:oid/leave/:sub': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PUT /v1/members/:oid/trainer': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/hq/class-types': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PATCH /v1/hq/class-types/:oid': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/rooms': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PATCH /v1/rooms/:oid': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/classes/rules': 'classes.test.ts › scheduling: audit log',
    'PATCH /v1/classes/rules/:oid': 'classes.test.ts › scheduling: audit log',
    'POST /v1/classes/sessions': 'classes.test.ts › scheduling: audit log',
    'PATCH /v1/classes/sessions/:oid': 'classes.test.ts › scheduling: audit log',
    'POST /v1/classes/sessions/:oid/cancel': 'classes.test.ts › scheduling: audit log',
    'POST /v1/classes/sessions/:oid/bookings': 'classes.test.ts › scheduling: audit log',
    'PATCH /v1/classes/bookings/:oid': 'classes.test.ts › scheduling: audit log',
    'POST /v1/pt/sessions': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/pt/sessions/:oid/cancel': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/pt/sessions/:oid/complete': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/pt/sessions/:oid/no-show': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/lockers': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'PATCH /v1/lockers/:oid': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/lockers/rentals/:oid/end': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/lockers/:oid/rentals': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/maintenance': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'DELETE /v1/maintenance/:oid': 'pt-facilities.test.ts › PT, trainers and facilities: audit log',
    'POST /v1/me/bookings': 'classes.test.ts › the member portal (book: the same bookMember, audited)',
    'DELETE /v1/me/bookings/:oid': 'classes.test.ts › the member portal (cancel: the same cancelBooking, audited)',
    'POST /v1/me/pt-sessions': 'pt.service.ts book(): the same audited path as POST /v1/pt/sessions',
    'POST /v1/me/pt-sessions/:oid/cancel': 'pt.service.ts cancel(): the same audited path as POST /v1/pt/sessions/:oid/cancel',
    'POST /v1/exercises': 'training.test.ts › training: audit log',
    'PATCH /v1/exercises/:oid': 'training.test.ts › training: audit log',
    'POST /v1/routines': 'training.test.ts › training: audit log',
    'PATCH /v1/routines/:oid': 'training.test.ts › training: audit log',
    'POST /v1/members/:oid/routine': 'training.test.ts › training: audit log',
    'POST /v1/members/:oid/routine/end': 'training.test.ts › training: audit log',
    'POST /v1/members/:oid/workouts': 'training.test.ts › training: audit log',
    'PATCH /v1/workouts/:oid': 'training.test.ts › training: audit log',
    'DELETE /v1/workouts/:oid': 'training.test.ts › training: audit log',
    'POST /v1/members/:oid/measurements': 'training.test.ts › training: audit log',
    'DELETE /v1/measurements/:oid': 'training.test.ts › training: audit log',
    'POST /v1/me/routine': 'portal-training.test.ts › the portal: audit log',
    'POST /v1/me/routine/end': 'portal-training.test.ts › the portal: audit log',
    'POST /v1/me/workouts': 'portal-training.test.ts › the portal: audit log',
    'PATCH /v1/me/workouts/:oid': 'portal-training.test.ts › the portal: audit log',
    'DELETE /v1/me/workouts/:oid': 'portal-training.test.ts › the portal: audit log',
    'POST /v1/me/measurements': 'portal-training.test.ts › the portal: audit log',
    'DELETE /v1/me/measurements/:oid': 'portal-training.test.ts › the portal: audit log',
    'POST /v1/me/files/:oid/complete': 'files.service.ts completeUpload(): the same audited path as POST /v1/files/:oid/complete (portal-training.test.ts)',
    // Phase 5 (D-090 to D-097)
    'POST /v1/hq/policies': 'policies.test.ts › policies: audit log',
    'PATCH /v1/hq/policies/:oid': 'policies.test.ts › policies: audit log',
    'POST /v1/hq/policies/:oid/versions': 'policies.test.ts › policies: audit log',
    'POST /v1/members/:oid/policies/accept': 'policies.test.ts › policies: audit log',
    'POST /v1/me/policies/accept': 'policies.test.ts › policies: audit log',
    'POST /v1/incidents': 'discipline.test.ts › discipline: audit log',
    'PATCH /v1/incidents/:oid': 'discipline.test.ts › discipline: audit log',
    'POST /v1/incidents/:oid/sanctions': 'discipline.test.ts › discipline: audit log',
    'POST /v1/sanctions/:oid/lift': 'discipline.test.ts › discipline: audit log',
    'POST /v1/appeals/:oid/decide': 'discipline.test.ts › discipline: audit log',
    'POST /v1/my-record/:oid/appeal': 'discipline.test.ts › discipline: audit log',
    'POST /v1/me/record/:oid/appeal': 'discipline.test.ts › discipline: audit log',
    'POST /v1/complaints': 'feedback.test.ts › feedback: audit log',
    'POST /v1/complaints/:oid/updates': 'feedback.test.ts › feedback: audit log',
    'POST /v1/complaints/:oid/escalate': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/complaints': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/complaints/:oid/reply': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/complaints/:oid/accept': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/complaints/:oid/escalate': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/nps': 'feedback.test.ts › feedback: audit log',
    'POST /v1/me/ratings': 'feedback.test.ts › feedback: audit log',
    'POST /v1/equipment': 'equipment.test.ts › equipment: audit log',
    'PATCH /v1/equipment/:oid': 'equipment.test.ts › equipment: audit log',
    'POST /v1/equipment/:oid/retire': 'equipment.test.ts › equipment: audit log',
    'POST /v1/equipment/:oid/service': 'equipment.test.ts › equipment: audit log',
    'POST /v1/equipment/:oid/tickets': 'equipment.test.ts › equipment: audit log',
    'PATCH /v1/equipment-tickets/:oid': 'equipment.test.ts › equipment: audit log',
    'POST /v1/hq/products': 'catalogue.test.ts › catalogue: audit log',
    'PATCH /v1/hq/products/:oid': 'catalogue.test.ts › catalogue: audit log',
    'POST /v1/hq/suppliers': 'catalogue.test.ts › catalogue: audit log',
    'PATCH /v1/hq/suppliers/:oid': 'catalogue.test.ts › catalogue: audit log',
    'POST /v1/stock/:product_oid/adjust': 'stock.test.ts › stock: audit log',
    'PUT /v1/stock/:product_oid/reorder-level': 'stock.test.ts › stock: audit log',
    'POST /v1/purchase-orders': 'stock.test.ts › stock: audit log',
    'POST /v1/purchase-orders/:oid/sent': 'stock.test.ts › stock: audit log',
    'POST /v1/purchase-orders/:oid/deliveries': 'stock.test.ts › stock: audit log',
    'POST /v1/purchase-orders/:oid/cancel': 'stock.test.ts › stock: audit log',
    'POST /v1/hq/purchase-orders/:oid/approve': 'stock.test.ts › stock: audit log',
    'POST /v1/hq/purchase-orders/:oid/reject': 'stock.test.ts › stock: audit log',
    'POST /v1/transfers': 'stock.test.ts › stock: audit log',
    'POST /v1/transfers/:oid/send': 'stock.test.ts › stock: audit log',
    'POST /v1/transfers/:oid/receive': 'stock.test.ts › stock: audit log',
    'POST /v1/transfers/:oid/reject': 'stock.test.ts › stock: audit log',
    'POST /v1/transfers/:oid/cancel': 'stock.test.ts › stock: audit log',
    'POST /v1/pos/sales': 'pos.test.ts › POS: audit log',
    'POST /v1/pos/sales/:oid/return': 'pos.test.ts › POS: audit log'
};

const EXEMPT: Record<string, string> = {
    'POST /v1/inbox/read': "a person's read marks on their own inbox (staff_message_read: who and when), not business data (D-108 d)",
    'POST /v1/me/notifications/read': "the member's read marks on their own messages (notification.read_at), not business data (D-108 d)",
    'POST /v1/auth/login': 'session start; the session itself is the refresh_token row (user, time, user agent)',
    'POST /v1/auth/guest': 'guest session start (D-076), like sign-in: the refresh_token row records user, time and user agent',
    'POST /v1/auth/refresh': 'token rotation inside an existing session (refresh_token rows)',
    'POST /v1/auth/logout': 'session end (refresh_token revoked_at)',
    'POST /v1/auth/change-password': "the user's own password (no branch context; app_user.updated_at, sessions revoked)",
    'DELETE /v1/auth/sessions/:id': 'the user ends one of their own sessions (refresh_token revoked_at)',
    'POST /v1/subscriptions/quote': 'computes a price, stores nothing',
    'POST /v1/pos/quote': 'computes a price, stores nothing',
    'POST /v1/public/enquiries': 'creates a Pending member through createMember, which writes the audit row (members.test.ts)',
    'POST /v1/public/join-requests': 'creates a Pending member through createMember, which writes the audit row (members.test.ts)',
    'POST /v1/attendance/evaluate': 'an access decision, stores nothing',
    'POST /v1/files': 'a pending row and an upload URL only; the file is audited when it is completed',
    'PUT /v1/files/:oid/content': "the local store's upload target (bytes only); audited on completion",
    'POST /v1/me/files': "a member's progress photo: a pending row and an upload URL only, as POST /v1/files"
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
