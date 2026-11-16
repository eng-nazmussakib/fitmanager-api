import { Router } from 'express';
import * as v from 'valibot';

import { authenticate, currentUser, requireAbility } from '#src/auth/middleware.ts';
import type { AppDeps } from '#src/container.ts';
import { AppError, attachment, ok, parse } from '#src/lib/http.ts';
import { render } from '#src/lib/templates.ts';

import { sendCsv, sendXlsx } from './items.export.ts';
import { itemsRepo } from './items.repo.ts';
import { itemExportSchema, itemListSchema, itemPayloadSchema, oidSchema } from './items.schema.ts';

/**
 * The generic CRUD example: list (offset paging, search, filters, whitelisted sort), detail, create, update,
 * delete, export (CSV / Excel) and a server-rendered PDF. Every route is authenticated and gated by a CASL ability,
 * the same rule the frontend used to show or hide the button.
 *
 * One router per feature, mounted explicitly in app.ts. (hapi-router / hapi-auto-route loaded every file under
 * src/routes by glob: no single place listed the API, and a stray file became a public route.)
 */
export function itemsRouter(deps: AppDeps): Router {
    const { db, pdf } = deps;
    const router = Router();
    router.use('/v1/items', authenticate(deps));

    const findOr404 = async (rawOid: unknown) => {
        const oid = v.safeParse(oidSchema, rawOid);
        const item = oid.success ? await itemsRepo.find(db, oid.output) : undefined;
        if (!item) throw new AppError(404, 'Item not found');
        return item;
    };

    router.get('/v1/items', requireAbility('read', 'Item'), async (req, res) => {
        ok(res, await itemsRepo.list(db, parse(itemListSchema, req.query)));
    });

    // Before '/:oid', or 'export' would be taken for an id.
    router.get('/v1/items/export', requireAbility('export', 'Item'), async (req, res) => {
        const { format, ...filter } = parse(itemExportSchema, req.query);
        const items = await itemsRepo.all(db, filter);
        const name = `items-${new Date().toISOString().slice(0, 10)}`;
        if (format === 'xlsx') await sendXlsx(res, items, `${name}.xlsx`);
        else sendCsv(res, items, `${name}.csv`);
    });

    router.get('/v1/items/:oid', requireAbility('read', 'Item'), async (req, res) => {
        ok(res, await findOr404(req.params['oid']));
    });

    router.get('/v1/items/:oid/pdf', requireAbility('read', 'Item'), async (req, res) => {
        const item = await findOr404(req.params['oid']);
        const html = render('item-report', { item, generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }) });
        const file = await pdf.render(html);
        res.type('application/pdf')
            .set('Content-Disposition', attachment(`item-${item.code}.pdf`))
            .send(Buffer.from(file));
    });

    router.post('/v1/items', requireAbility('create', 'Item'), async (req, res) => {
        const payload = parse(itemPayloadSchema, req.body);
        const oid = await itemsRepo.create(db, payload, currentUser(req).oid);
        ok(res, await itemsRepo.find(db, oid), 'Created successfully', 201);
    });

    router.put('/v1/items/:oid', requireAbility('update', 'Item'), async (req, res) => {
        const { oid } = await findOr404(req.params['oid']);
        const payload = parse(itemPayloadSchema, req.body);
        if (!(await itemsRepo.update(db, oid, payload, currentUser(req).oid))) throw new AppError(404, 'Item not found');
        ok(res, await itemsRepo.find(db, oid), 'Updated successfully');
    });

    router.delete('/v1/items/:oid', requireAbility('delete', 'Item'), async (req, res) => {
        const { oid } = await findOr404(req.params['oid']);
        await itemsRepo.remove(db, oid);
        ok(res, null, 'Deleted');
    });

    return router;
}
