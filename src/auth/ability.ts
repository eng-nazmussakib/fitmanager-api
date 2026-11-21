import { createMongoAbility, type MongoAbility, type RawRuleOf } from '@casl/ability';

/**
 * The authorization vocabulary (D-034), the same as the web app's `core/auth/ability.ts`: same actions, same
 * subjects, same rule JSON. The API sends a user's rules in /v1/auth/me and enforces the SAME rules on every call,
 * so a hidden button and a refused request can never disagree.
 *
 * One subject per screen or entity:
 * - branch: Dashboard, Member, Subscription, Payment, Invoice, CashClosing, Attendance, AttendanceOverride, Class,
 *   Booking, Plan, Trainer, Report;
 * - HQ: HqDashboard, Branch, PlanTemplate, Staff, Settings;
 * - both consoles: AuditLog (read only: HQ at HQ across its branches, a branch manager at their branch);
 * - member portal: Portal.
 * - phase 3 (D-083): Room, Locker (`manage` = set up; `create`/`update` = rent), PtSession, ClassType (HQ);
 * - phase 4 (D-086): Exercise, Routine, Workout, Measurement;
 * - phase 5 (D-097): Policy (HQ writes), Incident (cases, sanctions, appeals), Complaint, Feedback (NPS and ratings).
 * - phase 6 (D-102, D-104): Equipment (`create` = raise a maintenance ticket), Product and Supplier (HQ writes), Stock,
 *   PurchaseOrder (HQ approves), Transfer, Sale (POS; `manage` = discounts and late returns).
 */
export type Action = 'manage' | 'read' | 'create' | 'update' | 'delete' | 'export';
export type Subject =
    | 'Dashboard'
    | 'Member'
    | 'Subscription'
    | 'Payment'
    | 'Invoice'
    | 'CashClosing'
    | 'Attendance'
    | 'AttendanceOverride'
    | 'Class'
    | 'Booking'
    | 'Plan'
    | 'Trainer'
    | 'Report'
    | 'HqDashboard'
    | 'Branch'
    | 'PlanTemplate'
    | 'Staff'
    | 'Settings'
    | 'AuditLog'
    | 'Portal'
    | 'Room'
    | 'Locker'
    | 'PtSession'
    | 'ClassType'
    | 'Exercise'
    | 'Routine'
    | 'Workout'
    | 'Measurement'
    | 'Policy'
    | 'Incident'
    | 'Complaint'
    | 'Feedback'
    | 'Equipment'
    | 'Product'
    | 'Supplier'
    | 'Stock'
    | 'PurchaseOrder'
    | 'Transfer'
    | 'Sale'
    | 'all';
export type AppAbility = MongoAbility<[Action, Subject]>;
export type AppRule = RawRuleOf<AppAbility>;

/** Rules that do not depend on a branch, by kind of user. Staff get everything from their assignments. */
export const GLOBAL_RULES: Record<'staff' | 'member', AppRule[]> = {
    staff: [],
    member: [{ action: 'manage', subject: 'Portal' }]
};

/** No rules → nothing allowed. Fail-closed by construction. */
export function createAbility(rules: AppRule[] = []): AppAbility {
    return createMongoAbility<AppAbility>(rules);
}
