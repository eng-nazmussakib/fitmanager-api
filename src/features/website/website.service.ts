import type { Db, Queryable } from '#src/db/db.ts';
import { sql } from '#src/db/sql.ts';
import { type BranchContext, withBranchTx } from '#src/db/tenancy.ts';
import { recordAudit } from '#src/features/audit/audit.service.ts';
import { claimKindFile } from '#src/features/files/files.service.ts';
import { AppError } from '#src/lib/http.ts';

import type { OfferCreate, OfferUpdate, PostCreate, PostUpdate } from './website.schema.ts';

/**
 * The public website's content: the blog, the offers, the gallery and each branch's description.
 * HQ writes the blog and the offers (on the HQ row); the gallery is per branch (HQ any, a branch manager their own).
 * The public reads answer only what is live: posts published by now (a future date is scheduled, checked when read),
 * offers running today, photos not deleted. These tables have no RLS (public master data, like the catalogue).
 */
export interface WebsiteDeps {
    db: Db;
    apiPrefix: string;
}

export interface Image {
    src: string;
    alt: string;
}

/** An uploaded image's public URL, or one of the site's own (`assets/…`). */
export const imageSrc = (apiPrefix: string, fileOid: string | null, url: string | null): string | null =>
    fileOid ? `${apiPrefix}/v1/public/images/${fileOid}` : url;

/* ---------- the blog ---------- */

interface PostRow {
    oid: string;
    slug: string;
    title: string;
    excerpt: string;
    body: string;
    category_oid: string | null;
    category_name: string | null;
    category_slug: string | null;
    cover_file_oid: string | null;
    cover_url: string | null;
    cover_alt: string;
    author_name: string;
    published_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const POST = sql.raw(`p.oid, p.slug, p.title, p.excerpt, p.body, p.category_oid, c.name as category_name, c.slug as category_slug,
    p.cover_file_oid, p.cover_url, p.cover_alt, p.author_name, p.published_at, p.created_at, p.updated_at
    from blog_post p left join blog_category c on c.oid = p.category_oid`);

function postWire(deps: WebsiteDeps, p: PostRow, now: Date, withBody: boolean) {
    const src = imageSrc(deps.apiPrefix, p.cover_file_oid, p.cover_url);
    return {
        oid: p.oid,
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        ...(withBody ? { body: p.body } : {}),
        category: p.category_oid ? { oid: p.category_oid, name: p.category_name ?? '', slug: p.category_slug ?? '' } : null,
        cover: src ? { src, alt: p.cover_alt } : null,
        cover_file_oid: p.cover_file_oid,
        author_name: p.author_name,
        published_at: p.published_at?.toISOString() ?? null,
        status: !p.published_at ? ('draft' as const) : p.published_at > now ? ('scheduled' as const) : ('published' as const),
        updated_at: p.updated_at.toISOString()
    };
}

/** `GET /v1/public/posts[?category=]`: published posts, newest first (no bodies). */
export async function publicPosts(deps: WebsiteDeps, now: Date, category: string | undefined) {
    const rows = await deps.db.query<PostRow>(sql`
        select ${POST}
        where p.deleted_at is null and p.published_at <= ${now} and (${category ?? null}::text is null or c.slug = ${category ?? null})
        order by p.published_at desc limit 100`);
    return rows.map(p => postWire(deps, p, now, false));
}

/** `GET /v1/public/posts/:slug`: one published post, with its body (Markdown). */
export async function publicPost(deps: WebsiteDeps, now: Date, slug: string) {
    const [p] = await deps.db.query<PostRow>(sql`select ${POST} where p.slug = ${slug} and p.deleted_at is null and p.published_at <= ${now}`);
    if (!p) throw new AppError(404, 'Post not found');
    return postWire(deps, p, now, true);
}

export async function categories(db: Queryable) {
    return db.query<{ oid: string; name: string; slug: string }>(sql`select oid, name, slug from blog_category order by sort_order, name`);
}

/** `GET /v1/website/posts`: every post that is not deleted, drafts and scheduled ones too (HQ). */
export async function allPosts(deps: WebsiteDeps, now: Date) {
    const rows = await deps.db.query<PostRow>(sql`select ${POST} where p.deleted_at is null order by coalesce(p.published_at, p.created_at) desc`);
    return rows.map(p => postWire(deps, p, now, true));
}

async function postIn(tx: Queryable, oid: string): Promise<PostRow> {
    const [p] = await tx.query<PostRow>(sql`select ${POST} where p.oid = ${oid} and p.deleted_at is null for update of p`);
    if (!p) throw new AppError(404, 'Post not found');
    return p;
}

async function checkSlug(tx: Queryable, table: 'blog_post' | 'offer', slug: string, except: string | null): Promise<void> {
    const rows = await tx.query(
        table === 'blog_post'
            ? sql`select 1 from blog_post where slug = ${slug} and oid is distinct from ${except}::uuid`
            : sql`select 1 from offer where slug = ${slug} and oid is distinct from ${except}::uuid`
    );
    if (rows.length) throw new AppError(409, 'That address is taken', [{ path: 'slug', message: 'Already used' }]);
}

async function checkCategory(tx: Queryable, oid: string | null | undefined): Promise<void> {
    if (!oid) return;
    const [c] = await tx.query(sql`select 1 from blog_category where oid = ${oid}`);
    if (!c) throw new AppError(400, 'Choose a category', [{ path: 'category_oid', message: 'Unknown category' }]);
}

export async function createPost(deps: WebsiteDeps, ctx: BranchContext, now: Date, input: PostCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        await checkSlug(tx, 'blog_post', input.slug, null);
        await checkCategory(tx, input.category_oid);
        if (input.cover_file_oid) await claimKindFile(tx, ctx.branchOid, input.cover_file_oid, 'site_image');
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into blog_post (branch_oid, slug, title, excerpt, body, category_oid, cover_file_oid, cover_url, cover_alt, author_name, published_at)
            values (${ctx.branchOid}, ${input.slug}, ${input.title}, ${input.excerpt}, ${input.body}, ${input.category_oid}, ${input.cover_file_oid ?? null},
                ${input.cover_file_oid ? null : (input.cover_url ?? null)}, ${input.cover_alt}, ${ctx.actor?.name ?? 'HQ'}, ${input.published_at})
            returning oid`);
        if (!row) throw new Error('blog_post insert returned nothing');
        const out = postWire(deps, await postIn(tx, row.oid), now, true);
        await recordAudit(tx, ctx, {
            action: 'create',
            entity: 'blog_post',
            entityKey: input.slug,
            before: null,
            after: { title: out.title, status: out.status }
        });
        return out;
    });
}

export async function updatePost(deps: WebsiteDeps, ctx: BranchContext, now: Date, oid: string, input: PostUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await postIn(tx, oid);
        if (input.slug !== undefined) await checkSlug(tx, 'blog_post', input.slug, oid);
        await checkCategory(tx, input.category_oid);
        if (input.cover_file_oid && input.cover_file_oid !== before.cover_file_oid) await claimKindFile(tx, ctx.branchOid, input.cover_file_oid, 'site_image');
        const pick = <K extends keyof PostRow>(k: K, v: PostRow[K] | undefined): PostRow[K] => (v === undefined ? before[k] : v);
        const coverFile = pick('cover_file_oid', input.cover_file_oid);
        await tx.query(sql`
            update blog_post set slug = ${pick('slug', input.slug)}, title = ${pick('title', input.title)}, excerpt = ${pick('excerpt', input.excerpt)},
                body = ${pick('body', input.body)}, category_oid = ${pick('category_oid', input.category_oid)}, cover_file_oid = ${coverFile},
                cover_url = ${coverFile ? null : pick('cover_url', input.cover_url)}, cover_alt = ${pick('cover_alt', input.cover_alt)},
                published_at = ${input.published_at === undefined ? before.published_at : input.published_at ? new Date(input.published_at) : null},
                updated_at = ${now}
            where oid = ${oid}`);
        const out = postWire(deps, await postIn(tx, oid), now, true);
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'blog_post',
            entityKey: out.slug,
            before: { title: before.title, status: postWire(deps, before, now, false).status },
            after: { title: out.title, status: out.status }
        });
        return out;
    });
}

export async function deletePost(deps: WebsiteDeps, ctx: BranchContext, now: Date, oid: string) {
    await withBranchTx(deps.db, ctx, async tx => {
        const before = await postIn(tx, oid);
        await tx.query(sql`update blog_post set deleted_at = ${now}, slug = slug || '-deleted-' || left(oid::text, 8) where oid = ${oid}`);
        await recordAudit(tx, ctx, { action: 'delete', entity: 'blog_post', entityKey: before.slug, before: { title: before.title }, after: null });
    });
}

export async function createCategory(deps: WebsiteDeps, ctx: BranchContext, input: { name: string; slug: string }) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [taken] = await tx.query(sql`select 1 from blog_category where slug = ${input.slug}`);
        if (taken) throw new AppError(409, 'That category exists', [{ path: 'slug', message: 'Already used' }]);
        const [row] = await tx.query<{ oid: string; name: string; slug: string }>(sql`
            insert into blog_category (branch_oid, name, slug, sort_order)
            values (${ctx.branchOid}, ${input.name}, ${input.slug}, (select coalesce(max(sort_order), 0) + 1 from blog_category))
            returning oid, name, slug`);
        await recordAudit(tx, ctx, { action: 'create', entity: 'blog_category', entityKey: input.slug, before: null, after: { name: input.name } });
        return row;
    });
}

/* ---------- offers ---------- */

interface OfferRow {
    oid: string;
    slug: string;
    title: string;
    summary: string;
    body: string;
    conditions: string[];
    promo_code: string | null;
    starts_on: string;
    ends_on: string | null;
    sort_order: number;
    published: boolean;
}

const OFFER = sql.raw(`o.oid, o.slug, o.title, o.summary, o.body, o.conditions, o.promo_code, o.starts_on::text as starts_on, o.ends_on::text as ends_on,
    o.sort_order, o.published from offer o`);

/** `GET /v1/public/offers`: the offers running today, in HQ's order. */
export async function publicOffers(db: Queryable, today: string) {
    return db.query<OfferRow>(sql`
        select ${OFFER} where o.deleted_at is null and o.published and o.starts_on <= ${today}::date and (o.ends_on is null or o.ends_on >= ${today}::date)
        order by o.sort_order, o.title`);
}

export async function allOffers(db: Queryable) {
    return db.query<OfferRow>(sql`select ${OFFER} where o.deleted_at is null order by o.sort_order, o.title`);
}

async function offerIn(tx: Queryable, oid: string): Promise<OfferRow> {
    const [o] = await tx.query<OfferRow>(sql`select ${OFFER} where o.oid = ${oid} and o.deleted_at is null for update of o`);
    if (!o) throw new AppError(404, 'Offer not found');
    return o;
}

async function checkPromo(tx: Queryable, code: string | null | undefined): Promise<void> {
    if (!code) return;
    const [p] = await tx.query(sql`select 1 from promo where code = ${code}`);
    if (!p) throw new AppError(400, 'No such promo code', [{ path: 'promo_code', message: 'Unknown code' }]);
}

export async function createOffer(deps: WebsiteDeps, ctx: BranchContext, input: OfferCreate) {
    return withBranchTx(deps.db, ctx, async tx => {
        await checkSlug(tx, 'offer', input.slug, null);
        await checkPromo(tx, input.promo_code);
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into offer (branch_oid, slug, title, summary, body, conditions, promo_code, starts_on, ends_on, sort_order, published)
            values (${ctx.branchOid}, ${input.slug}, ${input.title}, ${input.summary}, ${input.body}, ${input.conditions}::text[], ${input.promo_code ?? null},
                ${input.starts_on}, ${input.ends_on ?? null}, ${input.sort_order}, ${input.published})
            returning oid`);
        if (!row) throw new Error('offer insert returned nothing');
        const out = await offerIn(tx, row.oid);
        await recordAudit(tx, ctx, { action: 'create', entity: 'offer', entityKey: out.slug, before: null, after: out });
        return out;
    });
}

export async function updateOffer(deps: WebsiteDeps, ctx: BranchContext, now: Date, oid: string, input: OfferUpdate) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await offerIn(tx, oid);
        const given = Object.fromEntries(Object.entries(input).filter((e: [string, unknown]) => e[1] !== undefined)) as Partial<OfferRow>;
        const next: OfferRow = { ...before, ...given };
        if (next.ends_on && next.ends_on < next.starts_on)
            throw new AppError(400, 'The end is before the start', [{ path: 'ends_on', message: 'Before the start' }]);
        if (input.slug !== undefined) await checkSlug(tx, 'offer', input.slug, oid);
        await checkPromo(tx, input.promo_code);
        await tx.query(sql`
            update offer set slug = ${next.slug}, title = ${next.title}, summary = ${next.summary}, body = ${next.body}, conditions = ${next.conditions}::text[],
                promo_code = ${next.promo_code}, starts_on = ${next.starts_on}, ends_on = ${next.ends_on}, sort_order = ${next.sort_order},
                published = ${next.published}, updated_at = ${now}
            where oid = ${oid}`);
        const out = await offerIn(tx, oid);
        await recordAudit(tx, ctx, { action: 'update', entity: 'offer', entityKey: out.slug, before, after: out });
        return out;
    });
}

export async function deleteOffer(deps: WebsiteDeps, ctx: BranchContext, now: Date, oid: string) {
    await withBranchTx(deps.db, ctx, async tx => {
        const before = await offerIn(tx, oid);
        await tx.query(sql`update offer set deleted_at = ${now}, slug = slug || '-deleted-' || left(oid::text, 8) where oid = ${oid}`);
        await recordAudit(tx, ctx, { action: 'delete', entity: 'offer', entityKey: before.slug, before: { title: before.title }, after: null });
    });
}

/* ---------- the gallery and branch photos ---------- */

interface GalleryRow {
    oid: string;
    branch_oid: string;
    branch_slug: string;
    branch_name: string;
    file_oid: string | null;
    image_url: string | null;
    thumb_url: string | null;
    alt: string;
    width: number;
    height: number;
    sort_order: number;
}

const GALLERY = sql.raw(`g.oid, g.branch_oid, b.slug as branch_slug, b.name as branch_name, g.file_oid, g.image_url, g.thumb_url, g.alt, g.width, g.height,
    g.sort_order from gallery_item g join branch b on b.oid = g.branch_oid`);

function galleryWire(deps: WebsiteDeps, g: GalleryRow) {
    const src = imageSrc(deps.apiPrefix, g.file_oid, g.image_url) ?? '';
    return {
        oid: g.oid,
        branch: { oid: g.branch_oid, slug: g.branch_slug, name: g.branch_name },
        src,
        thumb: g.thumb_url ?? src,
        alt: g.alt,
        width: g.width,
        height: g.height,
        sort_order: g.sort_order,
        file_oid: g.file_oid
    };
}

/** The photos of one branch (by slug), or of every active branch, in branch then HQ's order. */
export async function gallery(deps: WebsiteDeps, branch: { slug?: string | undefined; oid?: string | undefined } = {}) {
    const rows = await deps.db.query<GalleryRow>(sql`
        select ${GALLERY}
        where g.deleted_at is null and b.kind = 'BRANCH' and b.status = 'Active'
          and (${branch.slug ?? null}::text is null or b.slug = ${branch.slug ?? null}) and (${branch.oid ?? null}::uuid is null or b.oid = ${branch.oid ?? null}::uuid)
        order by b.name, g.sort_order, g.created_at`);
    return rows.map(g => galleryWire(deps, g));
}

/** The branch a gallery write is about: HQ names any branch; a branch manager writes their own. */
async function galleryBranch(tx: Queryable, ctx: BranchContext, atHq: boolean, named: string | undefined): Promise<string> {
    const oid = atHq ? named : ctx.branchOid;
    if (!oid) throw new AppError(400, 'Choose a branch', [{ path: 'branch_oid', message: 'Required' }]);
    const [b] = await tx.query(sql`select 1 from branch where oid = ${oid} and kind = 'BRANCH'`);
    if (!b) throw new AppError(400, 'Choose a branch', [{ path: 'branch_oid', message: 'Unknown branch' }]);
    return oid;
}

async function galleryIn(tx: Queryable, ctx: BranchContext, atHq: boolean, oid: string): Promise<GalleryRow> {
    const [g] = await tx.query<GalleryRow>(sql`select ${GALLERY} where g.oid = ${oid} and g.deleted_at is null for update of g`);
    if (!g || (!atHq && g.branch_oid !== ctx.branchOid)) throw new AppError(404, 'Photo not found');
    return g;
}

export async function addPhoto(
    deps: WebsiteDeps,
    ctx: BranchContext,
    atHq: boolean,
    input: { branch_oid?: string | undefined; file_oid: string; alt: string; width: number; height: number }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const branch = await galleryBranch(tx, ctx, atHq, input.branch_oid);
        await claimKindFile(tx, ctx.branchOid, input.file_oid, 'site_image');
        const [row] = await tx.query<{ oid: string }>(sql`
            insert into gallery_item (branch_oid, file_oid, alt, width, height, sort_order)
            values (${branch}, ${input.file_oid}, ${input.alt}, ${input.width}, ${input.height},
                (select coalesce(max(sort_order), 0) + 1 from gallery_item where branch_oid = ${branch} and deleted_at is null))
            returning oid`);
        if (!row) throw new Error('gallery_item insert returned nothing');
        const out = galleryWire(deps, await galleryIn(tx, ctx, true, row.oid));
        await recordAudit(tx, ctx, { action: 'create', entity: 'gallery_item', entityKey: out.branch.slug, before: null, after: { alt: out.alt } });
        return out;
    });
}

export async function updatePhoto(
    deps: WebsiteDeps,
    ctx: BranchContext,
    atHq: boolean,
    oid: string,
    input: { alt?: string | undefined; sort_order?: number | undefined }
) {
    return withBranchTx(deps.db, ctx, async tx => {
        const before = await galleryIn(tx, ctx, atHq, oid);
        await tx.query(sql`update gallery_item set alt = ${input.alt ?? before.alt}, sort_order = ${input.sort_order ?? before.sort_order} where oid = ${oid}`);
        const out = galleryWire(deps, await galleryIn(tx, ctx, true, oid));
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'gallery_item',
            entityKey: out.branch.slug,
            before: { alt: before.alt, sort_order: before.sort_order },
            after: { alt: out.alt, sort_order: out.sort_order }
        });
        return out;
    });
}

export async function removePhoto(deps: WebsiteDeps, ctx: BranchContext, atHq: boolean, now: Date, oid: string) {
    await withBranchTx(deps.db, ctx, async tx => {
        const before = await galleryIn(tx, ctx, atHq, oid);
        await tx.query(sql`update gallery_item set deleted_at = ${now} where oid = ${oid}`);
        await recordAudit(tx, ctx, { action: 'delete', entity: 'gallery_item', entityKey: before.branch_slug, before: { alt: before.alt }, after: null });
    });
}

/** `PUT /v1/website/branch`: the branch's description on its public page (its manager, or HQ for any). */
export async function setDescription(deps: WebsiteDeps, ctx: BranchContext, branchOid: string, description: string | null) {
    return withBranchTx(deps.db, ctx, async tx => {
        const [before] = await tx.query<{ slug: string; description: string | null }>(
            sql`select slug, description from branch where oid = ${branchOid} and kind = 'BRANCH' for update`
        );
        if (!before) throw new AppError(404, 'Branch not found');
        const text = description?.length ? description : null;
        await tx.query(sql`update branch set description = ${text}, updated_at = now() where oid = ${branchOid}`);
        await recordAudit(tx, ctx, {
            action: 'update',
            entity: 'branch_page',
            entityKey: before.slug,
            before: { description: before.description },
            after: { description: text }
        });
        return { description: text };
    });
}
