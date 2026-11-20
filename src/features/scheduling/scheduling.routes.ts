import { type Request, Router } from 'express';

import { authenticate, currentUser, requireAbility, requireAnyBranch, requireBranch } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { branchContext } from '#src/db/tenancy.ts';
import { memberContext } from '#src/features/portal/portal.service.ts';
import { dhakaNow } from '#src/lib/clock.ts';
import { AppError, ok, parse } from '#src/lib/http.ts';

import {
    cancelSession,
    createOneOff,
    createSchedule,
    deskBook,
    listClassTypes,
    listRooms,
    listSchedules,
    memberBookings,
    portalBook,
    portalCancel,
    publicWeek,
    saveClassType,
    saveRoom,
    sessionDetail,
    setBookingStatus,
    updateSchedule,
    updateSession,
    weekSchedule
} from './classes.service.ts';
import { blockTarget, createBlock, endRental, listBlocks, listLockers, removeBlock, rentLocker, saveLocker } from './facilities.service.ts';
import { bookPt, cancelPt, finishPt, memberPt, memberSlots, portalBookPt, portalCancelPt, ptWeek, trainerSlots } from './pt.service.ts';
import {
    assignSchema,
    availabilitySchema,
    blockCreate,
    bookingStatusSchema,
    bookSchema,
    cancelSchema,
    classTypeCreate,
    classTypeUpdate,
    leaveSchema,
    lockerCreate,
    lockerUpdate,
    oidParams,
    oneOffCreate,
    portalBookSchema,
    portalCancelSchema,
    portalPtCreate,
    ptCancelSchema,
    ptCreate,
    ptNoteSchema,
    publicTrainersQuery,
    publicWeekQuery,
    rentSchema,
    roomCreate,
    roomUpdate,
    scheduleCreate,
    scheduleUpdate,
    sessionUpdate,
    slotsQuery,
    slugParams,
    trainerCreate,
    trainerUpdate,
    twoOidParams,
    weekQuery
} from './scheduling.schema.ts';
import {
    addLeave,
    assignTrainer,
    type Caller,
    createTrainer,
    listTrainers,
    publicTrainer,
    publicTrainers,
    removeLeave,
    type SchedulingDeps,
    setAvailability,
    trainerCandidates,
    trainerDetail,
    updateTrainer
} from './trainers.service.ts';

/**
 * Scheduling (phase 3; D-078 to D-083), at the branch in `X-Branch-Id` unless marked HQ, portal or public.
 *
 * Trainers: `GET /v1/trainers`, `GET /v1/trainers/candidates`, `POST /v1/trainers` (`create Trainer`),
 * `GET|PATCH /v1/trainers/:oid` (`update Trainer`: a trainer their own), `PUT /v1/trainers/:oid/availability`,
 * `POST /v1/trainers/:oid/leave`, `DELETE /v1/trainers/:oid/leave/:sub`, `PUT /v1/members/:oid/trainer` (`update Member`).
 * Class types (HQ): `GET /v1/class-types`, `POST /v1/hq/class-types`, `PATCH /v1/hq/class-types/:oid` (`manage ClassType`).
 * Rooms: `GET /v1/rooms`, `POST /v1/rooms`, `PATCH /v1/rooms/:oid` (`manage Room`).
 * Classes: `GET /v1/classes/schedule?week=`, `GET /v1/classes/sessions/:oid`, `POST /v1/classes/sessions` (one-off),
 * `PATCH /v1/classes/sessions/:oid`, `POST /v1/classes/sessions/:oid/cancel` (`manage Class`); `GET|POST /v1/classes/rules`,
 * `PATCH /v1/classes/rules/:oid` (`manage Class`); `POST /v1/classes/sessions/:oid/bookings` (`create Booking`),
 * `PATCH /v1/classes/bookings/:oid` (`update Booking`: a trainer on their own classes).
 * PT: `GET /v1/pt/sessions?week=&trainer=`, `GET /v1/pt/slots?trainer_oid=&date=`, `POST /v1/pt/sessions` (`create PtSession`),
 * `POST /v1/pt/sessions/:oid/cancel|complete|no-show` (`update PtSession`), `GET /v1/members/:oid/pt`.
 * Facilities: `GET /v1/lockers`, `POST /v1/lockers`, `PATCH /v1/lockers/:oid` (`manage Locker`),
 * `POST /v1/lockers/:oid/rentals` (`create Locker`), `POST /v1/lockers/rentals/:oid/end` (`update Locker`),
 * `GET /v1/maintenance` (`read Room`), `POST /v1/maintenance`, `DELETE /v1/maintenance/:oid` (rooms: `manage Room`, lockers: `manage Locker`).
 * Portal: `GET|POST /v1/me/bookings`, `DELETE /v1/me/bookings/:oid`, `GET /v1/me/pt`, `GET /v1/me/pt/slots?date=`,
 * `POST /v1/me/pt-sessions`, `POST /v1/me/pt-sessions/:oid/cancel`.
 * Public: `GET /v1/public/classes?branch=&week=`, `GET /v1/public/trainers?branch=`, `GET /v1/public/trainers/:slug`.
 */
export function schedulingRouter(deps: AppDeps): Router {
    const router = Router();
    const s: SchedulingDeps = { db: deps.db, jwtSecret: deps.config.auth.jwtSecret, apiPrefix: deps.config.apiPrefix };
    const now = () => dhakaNow(deps.clock());
    const branch = [authenticate(deps), requireBranch('BRANCH')];
    const hq = [authenticate(deps), requireBranch('HQ')];
    const member = [authenticate(deps), requireAbility('read', 'Portal')];
    /** A trainer at this branch is narrowed to their own profile, classes and PT sessions (D-083). */
    const caller = (req: Request): Caller => ({ userOid: currentUser(req).oid, selfOnly: req.auth?.assignment?.role === 'TRAINER' });
    const portal = async (req: Request) => memberContext(deps, currentUser(req));

    /* ---------- public ---------- */

    router.get('/v1/public/classes', async (req, res) => {
        const q = parse(publicWeekQuery, req.query);
        ok(res, await publicWeek(s, q.branch, now(), q.week));
    });
    router.get('/v1/public/trainers', async (req, res) => {
        const q = parse(publicTrainersQuery, req.query);
        ok(res, await publicTrainers(s, q.branch));
    });
    router.get('/v1/public/trainers/:slug', async (req, res) => {
        const { slug } = parse(slugParams, req.params);
        ok(res, await publicTrainer(s, slug, deps.clock()));
    });

    /* ---------- trainers ---------- */

    router.get('/v1/trainers', ...branch, requireAbility('read', 'Trainer'), async (req, res) => {
        ok(res, await listTrainers(s, branchContext(req)));
    });
    router.get('/v1/trainers/candidates', ...branch, requireAbility('create', 'Trainer'), async (req, res) => {
        ok(res, await trainerCandidates(s, branchContext(req)));
    });
    router.post('/v1/trainers', ...branch, requireAbility('create', 'Trainer'), async (req, res) => {
        ok(res, await createTrainer(s, branchContext(req), parse(trainerCreate, req.body)), 'Trainer profile created', 201);
    });
    router.get('/v1/trainers/:oid', ...branch, requireAbility('read', 'Trainer'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await trainerDetail(s, branchContext(req), oid, now()));
    });
    router.patch('/v1/trainers/:oid', ...branch, requireAbility('update', 'Trainer'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await updateTrainer(s, branchContext(req), oid, parse(trainerUpdate, req.body), caller(req)), 'Profile saved');
    });
    router.put('/v1/trainers/:oid/availability', ...branch, requireAbility('update', 'Trainer'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { slots } = parse(availabilitySchema, req.body);
        ok(res, await setAvailability(s, branchContext(req), oid, slots, caller(req)), 'Availability saved');
    });
    router.post('/v1/trainers/:oid/leave', ...branch, requireAbility('update', 'Trainer'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const out = await addLeave(s, branchContext(req), oid, parse(leaveSchema, req.body), caller(req));
        ok(res, out, out.pt_sessions_to_move ? `Day off saved. ${out.pt_sessions_to_move} PT sessions fall on it: move or cancel them.` : 'Day off saved', 201);
    });
    router.delete('/v1/trainers/:oid/leave/:sub', ...branch, requireAbility('update', 'Trainer'), async (req, res) => {
        const { oid, sub } = parse(twoOidParams, req.params);
        await removeLeave(s, branchContext(req), oid, sub, caller(req));
        ok(res, null, 'Day off removed');
    });
    router.put('/v1/members/:oid/trainer', ...branch, requireAbility('update', 'Member'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { trainer_oid } = parse(assignSchema, req.body);
        const out = await assignTrainer(s, branchContext(req), oid, trainer_oid);
        ok(res, out, out.trainer_name ? `Trainer: ${out.trainer_name}` : 'Trainer removed');
    });

    /* ---------- class types (HQ) and rooms ---------- */

    router.get('/v1/class-types', authenticate(deps), requireAnyBranch(), requireAbility('read', 'Class'), async (req, res) => {
        ok(res, await listClassTypes(s, branchContext(req)));
    });
    router.get('/v1/hq/class-types', ...hq, requireAbility('manage', 'ClassType'), async (req, res) => {
        ok(res, await listClassTypes(s, branchContext(req)));
    });
    router.post('/v1/hq/class-types', ...hq, requireAbility('manage', 'ClassType'), async (req, res) => {
        ok(res, await saveClassType(s, branchContext(req), null, parse(classTypeCreate, req.body)), 'Class type added', 201);
    });
    router.patch('/v1/hq/class-types/:oid', ...hq, requireAbility('manage', 'ClassType'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await saveClassType(s, branchContext(req), oid, parse(classTypeUpdate, req.body)), 'Class type saved');
    });
    router.get('/v1/rooms', ...branch, requireAbility('read', 'Room'), async (req, res) => {
        ok(res, await listRooms(s, branchContext(req)));
    });
    router.post('/v1/rooms', ...branch, requireAbility('manage', 'Room'), async (req, res) => {
        ok(res, await saveRoom(s, branchContext(req), null, parse(roomCreate, req.body)), 'Room added', 201);
    });
    router.patch('/v1/rooms/:oid', ...branch, requireAbility('manage', 'Room'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await saveRoom(s, branchContext(req), oid, parse(roomUpdate, req.body)), 'Room saved');
    });

    /* ---------- classes ---------- */

    router.get('/v1/classes/schedule', ...branch, requireAbility('read', 'Class'), async (req, res) => {
        const q = parse(weekQuery, req.query);
        const out = await weekSchedule(s, branchContext(req), now(), q.week, currentUser(req).oid);
        ok(res, q.trainer ? { ...out, sessions: out.sessions.filter(x => x.trainer_oid === q.trainer) } : out);
    });
    router.get('/v1/classes/rules', ...branch, requireAbility('read', 'Class'), async (req, res) => {
        ok(res, await listSchedules(s, branchContext(req)));
    });
    router.post('/v1/classes/rules', ...branch, requireAbility('manage', 'Class'), async (req, res) => {
        ok(res, await createSchedule(s, branchContext(req), now(), parse(scheduleCreate, req.body)), 'Weekly class added', 201);
    });
    router.patch('/v1/classes/rules/:oid', ...branch, requireAbility('manage', 'Class'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const out = await updateSchedule(s, branchContext(req), now(), oid, parse(scheduleUpdate, req.body));
        ok(res, out, out.sessions_cancelled ? `Saved. ${out.sessions_cancelled} booked classes were cancelled and their members told.` : 'Weekly class saved');
    });
    router.post('/v1/classes/sessions', ...branch, requireAbility('manage', 'Class'), async (req, res) => {
        ok(res, await createOneOff(s, branchContext(req), now(), parse(oneOffCreate, req.body)), 'Class added', 201);
    });
    router.get('/v1/classes/sessions/:oid', ...branch, requireAbility('read', 'Class'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await sessionDetail(s, branchContext(req), now(), oid));
    });
    router.patch('/v1/classes/sessions/:oid', ...branch, requireAbility('manage', 'Class'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await updateSession(s, branchContext(req), now(), oid, parse(sessionUpdate, req.body)), 'Class changed');
    });
    router.post('/v1/classes/sessions/:oid/cancel', ...branch, requireAbility('manage', 'Class'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { reason } = parse(cancelSchema, req.body);
        const out = await cancelSession(s, branchContext(req), now(), oid, reason);
        ok(res, out, out.bookings_cancelled ? `Class cancelled; ${out.bookings_cancelled} members were told` : 'Class cancelled');
    });
    router.post('/v1/classes/sessions/:oid/bookings', ...branch, requireAbility('create', 'Booking'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { member_oid } = parse(bookSchema, req.body);
        const out = await deskBook(s, branchContext(req), now(), oid, member_oid);
        ok(res, out.booking, out.message, 201);
    });
    router.patch('/v1/classes/bookings/:oid', ...branch, requireAbility('update', 'Booking'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { status } = parse(bookingStatusSchema, req.body);
        const out = await setBookingStatus(s, branchContext(req), now(), oid, status, caller(req));
        ok(res, out.booking, out.message);
    });

    /* ---------- PT ---------- */

    router.get('/v1/pt/sessions', ...branch, requireAbility('read', 'PtSession'), async (req, res) => {
        const q = parse(weekQuery, req.query);
        ok(res, await ptWeek(s, branchContext(req), now(), q.week, q.trainer));
    });
    router.get('/v1/pt/slots', ...branch, requireAbility('read', 'PtSession'), async (req, res) => {
        const q = parse(slotsQuery, req.query);
        if (!q.trainer_oid) throw new AppError(400, 'Choose a trainer', [{ path: 'trainer_oid', message: 'Required' }]);
        ok(res, await trainerSlots(s, branchContext(req), now(), q.trainer_oid, q.date, q.minutes));
    });
    router.post('/v1/pt/sessions', ...branch, requireAbility('create', 'PtSession'), async (req, res) => {
        ok(res, await bookPt(s, branchContext(req), now(), parse(ptCreate, req.body), caller(req)), 'PT session booked', 201);
    });
    router.post('/v1/pt/sessions/:oid/cancel', ...branch, requireAbility('update', 'PtSession'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { by, reason } = parse(ptCancelSchema, req.body);
        ok(res, null, await cancelPt(s, branchContext(req), now(), oid, by, reason, caller(req)));
    });
    router.post('/v1/pt/sessions/:oid/complete', ...branch, requireAbility('update', 'PtSession'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const { notes } = parse(ptNoteSchema, req.body ?? {});
        ok(res, await finishPt(s, branchContext(req), now(), oid, 'Completed', notes ?? null, caller(req)), 'Session done');
    });
    router.post('/v1/pt/sessions/:oid/no-show', ...branch, requireAbility('update', 'PtSession'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await finishPt(s, branchContext(req), now(), oid, 'NoShow', null, caller(req)), 'Marked no-show: the session is used');
    });
    router.get('/v1/members/:oid/pt', ...branch, requireAbility('read', 'PtSession'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await memberPt(s, branchContext(req), now(), oid));
    });

    /* ---------- facilities ---------- */

    router.get('/v1/lockers', ...branch, requireAbility('read', 'Locker'), async (req, res) => {
        ok(res, await listLockers(s, branchContext(req), now()));
    });
    router.post('/v1/lockers', ...branch, requireAbility('manage', 'Locker'), async (req, res) => {
        ok(res, await saveLocker(s, branchContext(req), now(), null, parse(lockerCreate, req.body)), 'Locker added', 201);
    });
    router.patch('/v1/lockers/:oid', ...branch, requireAbility('manage', 'Locker'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await saveLocker(s, branchContext(req), now(), oid, parse(lockerUpdate, req.body)), 'Locker saved');
    });
    router.post('/v1/lockers/rentals/:oid/end', ...branch, requireAbility('update', 'Locker'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        ok(res, await endRental(s, branchContext(req), now(), oid), 'Rental ended: take the key back');
    });
    router.post('/v1/lockers/:oid/rentals', ...branch, requireAbility('create', 'Locker'), async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const out = await rentLocker(s, branchContext(req), now(), oid, parse(rentSchema, req.body));
        ok(res, out, `Locker rented: ${out.invoice.number}`, 201);
    });
    router.get('/v1/maintenance', ...branch, requireAbility('read', 'Room'), async (req, res) => {
        ok(res, await listBlocks(s, branchContext(req), now()));
    });
    router.post('/v1/maintenance', ...branch, async (req, res) => {
        const body = parse(blockCreate, req.body);
        if (!req.auth?.ability.can('manage', body.room_oid ? 'Room' : 'Locker')) throw new AppError(403, 'You do not have permission to do this');
        const out = await createBlock(s, branchContext(req), now(), body);
        ok(res, out, out.classes_affected ? `Blocked. ${out.classes_affected} classes fall in it: move or cancel them.` : 'Blocked', 201);
    });
    router.delete('/v1/maintenance/:oid', ...branch, async (req, res) => {
        const { oid } = parse(oidParams, req.params);
        const target = await blockTarget(s, branchContext(req), oid);
        if (!req.auth?.ability.can('manage', target === 'room' ? 'Room' : 'Locker')) throw new AppError(403, 'You do not have permission to do this');
        await removeBlock(s, branchContext(req), oid);
        ok(res, null, 'Block lifted');
    });

    /* ---------- the member portal ---------- */

    router.get('/v1/me/bookings', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await memberBookings(s, ctx, now(), memberOid));
    });
    router.post('/v1/me/bookings', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const { session_oid } = parse(portalBookSchema, req.body);
        const out = await portalBook(s, ctx, now(), memberOid, session_oid);
        ok(res, out.booking, out.message, 201);
    });
    router.delete('/v1/me/bookings/:oid', ...member, requireAbility('delete', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const { oid } = parse(oidParams, req.params);
        ok(res, null, await portalCancel(s, ctx, now(), memberOid, oid));
    });
    router.get('/v1/me/pt', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await memberPt(s, ctx, now(), memberOid));
    });
    router.get('/v1/me/pt/slots', ...member, async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const q = parse(slotsQuery, req.query);
        ok(res, await memberSlots(s, ctx, now(), memberOid, q.date));
    });
    router.post('/v1/me/pt-sessions', ...member, requireAbility('create', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        ok(res, await portalBookPt(s, ctx, now(), memberOid, parse(portalPtCreate, req.body)), 'PT session booked', 201);
    });
    router.post('/v1/me/pt-sessions/:oid/cancel', ...member, requireAbility('update', 'Portal'), async (req, res) => {
        const { ctx, memberOid } = await portal(req);
        const { oid } = parse(oidParams, req.params);
        const { reason } = parse(portalCancelSchema, req.body ?? {});
        ok(res, null, await portalCancelPt(s, ctx, now(), memberOid, oid, reason));
    });

    return router;
}
