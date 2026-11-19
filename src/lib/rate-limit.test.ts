import express from 'express';
import request from 'supertest';

import { type CounterNamespace, type CounterStub, createLimiter, durableObjectStores, nextWindow, type WindowState } from './rate-limit.ts';

describe('rate limits: fixed window', () => {
    it('a first hit opens a window; later hits count until it ends; then a new one opens', () => {
        const a = nextWindow(undefined, 1_000, 60_000);
        expect(a).toEqual({ hits: 1, resetAt: 61_000 });
        expect(nextWindow(a, 30_000, 60_000)).toEqual({ hits: 2, resetAt: 61_000 });
        expect(nextWindow({ hits: 9, resetAt: 61_000 }, 61_000, 60_000)).toEqual({ hits: 1, resetAt: 121_000 });
    });
});

/** A Durable Object namespace in memory: one counter per name, as Workers gives one object per id. */
function fakeNamespace(): CounterNamespace & { names: string[] } {
    const objects = new Map<string, WindowState>();
    const names: string[] = [];
    return {
        names,
        idFromName: name => name,
        get: (id: never) => {
            const name = id as string;
            if (!names.includes(name)) names.push(name);
            const stub: CounterStub = {
                hit: windowMs => {
                    const next = nextWindow(objects.get(name), Date.now(), windowMs);
                    objects.set(name, next);
                    return Promise.resolve(next);
                },
                undo: () => {
                    const w = objects.get(name);
                    if (w) objects.set(name, { ...w, hits: w.hits - 1 });
                    return Promise.resolve();
                },
                reset: () => {
                    objects.delete(name);
                    return Promise.resolve();
                }
            };
            return stub;
        }
    };
}

describe('rate limits: Durable Object store (Workers)', () => {
    it('counts each key in its own object, named after the limiter, and answers 429 past the limit', async () => {
        const ns = fakeNamespace();
        const app = express();
        app.post('/x', createLimiter({ name: 'test', windowMs: 60_000, limit: 2, stores: durableObjectStores(ns), key: () => 'k1' }), (_req, res) => {
            res.sendStatus(204);
        });
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) codes.push((await request(app).post('/x')).status);
        expect(codes).toEqual([204, 204, 429]);
        expect(ns.names).toEqual(['test:k1']);
    });
});
