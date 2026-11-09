import { naira, parseMoney, parseCount, resolveProduct, similarity, roundPrice, clip } from './util.js';

const STATUS = { draft: '📝 Draft (hidden)', active: '🟢 Live', out_of_stock: '🔴 Out of stock', archived: '🗄 Archived' };
const PENDING_TTL = 5 * 60 * 1000;
const fmtStock = (n) => (n == null ? 'not tracked' : String(n));

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export function toolDefs({ hasOrders = false } = {}) {
  const P = { type: 'string', description: 'Product name as the vendor said it, or the product id from a previous tool result' };
  const defs = [
    fn('list_products', 'List the vendor\'s products with price, stock and status.', {
      filter: { type: 'string', enum: ['all', 'draft', 'active', 'out_of_stock', 'archived', 'low_stock'] },
      limit: { type: 'integer', description: 'Max rows, default 20' },
    }),
    fn('search_products', 'Find products by (possibly misspelled) name.', { query: { type: 'string' } }, ['query']),
    fn('add_product', 'Create a NEW product as a draft. Waiting photos are attached automatically.', {
      name: { type: 'string', description: 'Clean Title Case name without price/stock' },
      price: { type: 'number', description: 'Naira, e.g. 45000' },
      stock: { type: 'integer', description: 'Units available, default 1' },
      description: { type: 'string', description: 'Optional short selling description' },
      allow_duplicate: { type: 'boolean', description: 'Only true after the vendor agreed to add a similar product anyway' },
    }, ['name', 'price']),
    fn('update_product', 'Change an existing product\'s price, stock, name or description.', {
      product: P,
      price: { type: 'number', description: 'New price in Naira' },
      stock: { type: 'integer' },
      stock_mode: { type: 'string', enum: ['set', 'add', 'subtract'], description: 'How to apply stock; default set' },
      new_name: { type: 'string' },
      description: { type: 'string' },
    }, ['product']),
    fn('set_product_visibility', 'Publish (make live), unpublish (back to draft/hidden) or archive a product.', {
      product: P, action: { type: 'string', enum: ['publish', 'unpublish', 'archive'] },
    }, ['product', 'action']),
    fn('publish_all_drafts', 'Publish every draft product at once.'),
    fn('attach_photos', 'Attach the waiting photos to an existing product (add to gallery, or replace).', {
      product: P, replace: { type: 'boolean', description: 'true to replace existing photos' },
    }, ['product']),
    fn('set_sale', 'Put ONE product on sale: the old price shows crossed out with a discount badge. Give percent_off OR sale_price.', {
      product: P,
      percent_off: { type: 'number', description: 'e.g. 20 for 20% off' },
      sale_price: { type: 'number', description: 'The new lower price in Naira' },
    }, ['product']),
    fn('end_sale', 'End a sale: the price goes back to normal. Give a product, or all=true for every product on sale (asks for confirmation).', {
      product: P, all: { type: 'boolean' },
    }),
    fn('delete_product', 'Permanently delete a product. TWO-STEP: this only asks for confirmation.', { product: P }, ['product']),
    fn('bulk_price_change', 'Raise or lower prices by a percentage (e.g. -10 for 10% off). TWO-STEP: this only previews and asks for confirmation.', {
      percent: { type: 'number', description: 'Positive to increase, negative to discount' },
      scope: { type: 'string', enum: ['all', 'active', 'draft', 'out_of_stock'], description: 'Default all (archived excluded)' },
      products: { type: 'array', items: { type: 'string' }, description: 'Optional: only these products' },
    }, ['percent']),
    fn('confirm_pending_action', 'Run the pending delete/bulk price change after the vendor said yes in a NEW message.'),
    fn('cancel_pending_action', 'Drop the pending action because the vendor said no.'),
    fn('get_store_stats', 'Counts, inventory value, low stock and products without photos.'),
    fn('set_daily_summary', 'Turn the vendor\'s optional morning WhatsApp summary on or off (drafts waiting, low stock, new orders). It is off by default.', {
      enabled: { type: 'boolean' },
      hour: { type: 'integer', description: 'Hour of the day in Lagos time, 5 to 21. Default 8.' },
    }, ['enabled']),
  ];
  if (hasOrders) {
    defs.push(fn('recent_orders', 'The latest orders with customer, items, total and status.', { limit: { type: 'integer' } }));
    defs.push(fn('orders_overview', 'Sales for the last N days: number of orders, revenue, orders by status, orders waiting for the vendor and best sellers.', {
      days: { type: 'integer', description: 'Default 7' },
    }));
  }
  return defs;
}

export function createToolbox({ db, media, siteUrl, log }) {
  const storeUrl = (biz) => `${siteUrl}/store/${biz.slug}`;
  const onSaleNow = (p) => p.compare_at_price_kobo != null && p.compare_at_price_kobo > p.price_kobo;
  const brief = (p) => ({
    id: p.id, name: p.name, price: p.price_kobo / 100, stock: p.stock_quantity, status: p.status,
    ...(onSaleNow(p) ? { was_price: p.compare_at_price_kobo / 100, on_sale: true } : {}),
  });

  function card(p, biz, o = {}) {
    let price =
      o.beforePrice != null && o.beforePrice !== p.price_kobo
        ? `${naira(o.beforePrice / 100)} ➜ ${naira(p.price_kobo / 100)}`
        : naira(p.price_kobo / 100);
    if (onSaleNow(p)) {
      const pctOff = Math.round((1 - p.price_kobo / p.compare_at_price_kobo) * 100);
      price += ` (was ${naira(p.compare_at_price_kobo / 100)}, -${pctOff}%)`;
    }
    const stock =
      o.beforeStock !== undefined && o.beforeStock !== p.stock_quantity
        ? `${fmtStock(o.beforeStock)} ➜ ${fmtStock(p.stock_quantity)}`
        : fmtStock(p.stock_quantity);
    return [
      `📦 ${p.name}`,
      `💰 ${price}`,
      `🔢 Stock: ${stock}`,
      o.photoLine || null,
      STATUS[p.status] || p.status,
      p.status === 'active' ? `🔗 ${storeUrl(biz)}` : null,
    ].filter(Boolean).join('\n');
  }

  async function pick(biz, ref, ctx) {
    const all = await db.getAllProducts(biz.id);
    // "2" after a numbered list means the 2nd product we just listed
    const raw = String(ref ?? '').trim();
    const last = ctx?.st?.lastChoices;
    if (/^\d{1,2}$/.test(raw) && last && Date.now() - last.ts < 10 * 60 * 1000) {
      const hit = all.find((p) => p.id === last.ids[Number(raw) - 1]);
      if (hit) return { product: hit, all };
    }
    const r = resolveProduct(all, ref);
    if (r.type === 'one') return { product: r.product, all };
    if (r.type === 'unsure') {
      return { reply: { status: 'unsure_match', suggestion: brief(r.product), message: `No exact match for "${ref}". Closest is "${r.product.name}". Ask the vendor if they mean that one.` } };
    }
    if (r.type === 'many') {
      if (ctx?.st) ctx.st.lastChoices = { ids: r.candidates.map((p) => p.id), ts: Date.now() };
      return { reply: { status: 'ambiguous', candidates: r.candidates.map(brief), message: 'Several products match. Ask which one, with a short numbered list (name and price).' } };
    }
    return { reply: { status: 'not_found', message: `No product matches "${ref}".`, some_products: all.slice(0, 5).map((p) => p.name) } };
  }

  async function uploadPhotos(ctx) {
    const photos = (ctx.st.photos || []).slice(0, 5);
    const images = [];
    let failed = 0;
    for (const ph of photos) {
      try { images.push(await media.uploadProductImage(ph.buffer)); }
      catch (e) { failed++; log.error({ err: e.message }, 'Cloudinary upload failed'); }
    }
    if (images.length) ctx.st.photos = [];
    return { images, failed, tried: photos.length };
  }

  const touch = (ctx, name) => { ctx.st.lastTouched = { name, ts: Date.now() }; };

  async function exec(name, args = {}, ctx) {
    const biz = ctx.biz;
    try {
      switch (name) {
        case 'list_products': {
          const all = await db.getAllProducts(biz.id);
          const f = args.filter || 'all';
          let rows = all;
          if (f === 'low_stock') rows = all.filter((p) => (p.status === 'active' || p.status === 'out_of_stock') && p.stock_quantity != null && p.stock_quantity <= 2);
          else if (f !== 'all') rows = all.filter((p) => p.status === f);
          const limit = Math.min(Math.max(parseCount(args.limit) ?? 20, 1), 50);
          return { matching: rows.length, showing: Math.min(rows.length, limit), products: rows.slice(0, limit).map(brief) };
        }

        case 'search_products': {
          const all = await db.getAllProducts(biz.id);
          const hits = all.map((p) => ({ p, s: similarity(args.query, p.name) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 5);
          return { matches: hits.map((x) => ({ ...brief(x.p), match: Number(x.s.toFixed(2)) })) };
        }

        case 'add_product': {
          const price = parseMoney(args.price);
          if (price == null || price <= 0) return { error: 'Price is missing or invalid. Ask the vendor for the price.' };
          if (price < 20 || price > 20_000_000) {
            return { status: 'needs_check', message: `A price of ${naira(price)} looks unusual. Ask the vendor to confirm the exact price in Naira.` };
          }
          const pname = String(args.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          if (pname.length < 2) return { error: 'Product name is missing. Ask the vendor for it.' };
          let stock = args.stock == null ? 1 : parseCount(args.stock);
          if (stock == null) stock = 1;
          stock = Math.min(stock, 1_000_000);

          const all = await db.getAllProducts(biz.id);
          const priceKobo = Math.round(price * 100);
          const dups = all.filter((p) => {
            if (p.status === 'archived') return false;
            const s = similarity(pname, p.name);
            return s >= 0.96 || (s >= 0.88 && p.price_kobo === priceKobo);
          });
          if (dups.length && !args.allow_duplicate) {
            return { status: 'possible_duplicate', existing: dups.slice(0, 3).map(brief), message: 'A very similar product already exists. Ask whether to update it or add a new one anyway.' };
          }

          const { images, failed, tried } = await uploadPhotos(ctx);
          const description = args.description ? clip(String(args.description), 600) : null;
          const res = await db.createDraftProduct({ businessId: biz.id, name: pname, price, stock, images, description });
          const photoLine = tried ? (images.length ? `🖼 ${images.length} photo${images.length > 1 ? 's' : ''} attached` : '⚠️ Photo failed to upload, add it on the dashboard') : null;
          ctx.cards.push(card(res.product, biz, { photoLine }));
          touch(ctx, res.product.name);
          return { status: 'created_as_draft', product: brief(res.product), photos_attached: images.length, photos_failed: failed, description_saved: res.descriptionSaved };
        }

        case 'update_product': {
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          const price = args.price == null ? null : parseMoney(args.price);
          if (args.price != null && (price == null || price <= 0 || price > 20_000_000)) return { error: 'The new price is invalid. Ask the vendor to confirm it.' };
          const stock = args.stock == null ? null : parseCount(args.stock);
          if (args.stock != null && stock == null) return { error: 'The stock number is invalid.' };
          const mode = ['set', 'add', 'subtract'].includes(args.stock_mode) ? args.stock_mode : 'set';
          const newName = args.new_name ? String(args.new_name).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
          const description = args.description ? clip(String(args.description), 600) : null;
          if (price == null && stock == null && !newName && !description) return { error: 'Nothing to change. Ask what to update (price, stock, name or description).' };
          if (stock != null && mode !== 'set' && p.stock_quantity == null) {
            return { status: 'stock_not_tracked', message: `Stock is not tracked for "${p.name}" yet, so it cannot be added to or reduced. Ask the vendor how many are in stock right now, then set that number.` };
          }

          const u = await db.updateProduct(p, { price, stock, mode, name: newName, description });
          ctx.cards.push(card(u, biz, { beforePrice: p.price_kobo, beforeStock: p.stock_quantity }));
          touch(ctx, u.name);
          const low = (u.status === 'active' || u.status === 'out_of_stock') && u.stock_quantity != null && u.stock_quantity <= 2;
          return { status: 'updated', product: brief(u), previous: { price: p.price_kobo / 100, stock: p.stock_quantity }, low_stock: low, ...(price != null && onSaleNow(p) && !onSaleNow(u) ? { sale_ended: true } : {}) };
        }

        case 'set_product_visibility': {
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          const target = { publish: 'live', unpublish: 'draft', archive: 'archived' }[args.action];
          if (!target) return { error: 'Unknown action.' };
          const u = await db.setProductStatus(p, target);
          ctx.cards.push(card(u, biz));
          touch(ctx, u.name);
          const warnings = [];
          if (target === 'live' && !p.image_url) warnings.push('This product has no photo. Suggest sending one.');
          if (target === 'live' && u.status === 'out_of_stock') warnings.push('Stock is 0 so it shows as out of stock until restocked.');
          return { status: 'ok', product: brief(u), warnings };
        }

        case 'publish_all_drafts': {
          const all = await db.getAllProducts(biz.id);
          const drafts = all.filter((p) => p.status === 'draft');
          if (!drafts.length) return { status: 'nothing_to_do', message: 'There are no drafts.' };
          const done = [];
          for (const p of drafts) { const u = await db.setProductStatus(p, 'live'); done.push(u); }
          const names = done.slice(0, 12).map((u) => `• ${u.name} (${naira(u.price_kobo / 100)})`);
          ctx.cards.push([`🟢 Published ${done.length} product${done.length > 1 ? 's' : ''}`, ...names, done.length > 12 ? `…and ${done.length - 12} more` : null, `🔗 ${storeUrl(biz)}`].filter(Boolean).join('\n'));
          return { status: 'published', count: done.length, without_photo: drafts.filter((p) => !p.image_url).length };
        }

        case 'attach_photos': {
          if (!(ctx.st.photos || []).length) return { error: 'No photos are waiting. Ask the vendor to send the photo(s) first.' };
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          const { images, failed } = await uploadPhotos(ctx);
          if (!images.length) return { error: 'Photo upload failed. Ask the vendor to try again.' };
          await db.addProductImages(p, images, { replace: !!args.replace });
          const u = { ...p, image_url: p.image_url || images[0].url };
          ctx.cards.push(card(u, biz, { photoLine: `🖼 ${args.replace ? 'Photos replaced' : `+${images.length} photo${images.length > 1 ? 's' : ''} added`}` }));
          touch(ctx, p.name);
          return { status: 'photos_attached', product: brief(p), count: images.length, failed };
        }

        case 'set_sale': {
          if (!db.supportsSale()) return { error: 'Sales are not available on this setup. Use update_product to change the price.' };
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          const base = onSaleNow(p) ? p.compare_at_price_kobo : p.price_kobo; // never stack discounts on a discount
          let newKobo;
          if (args.sale_price != null) {
            const sp = parseMoney(args.sale_price);
            if (sp == null || sp <= 0) return { error: 'The sale price is invalid. Ask the vendor for it.' };
            newKobo = Math.round(sp * 100);
          } else {
            const pct = Number(args.percent_off);
            if (!Number.isFinite(pct) || pct <= 0 || pct >= 95) return { error: 'percent_off must be between 1 and 94. Ask the vendor how much off.' };
            newKobo = roundPrice((base / 100) * (1 - pct / 100)) * 100;
          }
          if (newKobo >= base) return { error: `The sale price must be lower than the normal price (${naira(base / 100)}).` };
          await db.bulkSetPrices(biz.id, [{ id: p.id, newKobo, compareKobo: base }]);
          const u = { ...p, price_kobo: newKobo, compare_at_price_kobo: base };
          ctx.cards.push(card(u, biz, { beforePrice: p.price_kobo }));
          touch(ctx, p.name);
          return { status: 'sale_started', product: brief(u) };
        }

        case 'end_sale': {
          if (!db.supportsSale()) return { error: 'Sales are not available on this setup.' };
          if (args.all) {
            const all = await db.getAllProducts(biz.id);
            const items = all
              .filter((p) => p.status !== 'archived' && onSaleNow(p))
              .map((p) => ({ id: p.id, name: p.name, oldKobo: p.price_kobo, newKobo: p.compare_at_price_kobo, compareKobo: null }));
            if (!items.length) return { status: 'not_on_sale', message: 'No product is on sale right now.' };
            ctx.st.pending = {
              kind: 'bulk_price', items, pct: null, turn: ctx.turn, expires: Date.now() + PENDING_TTL,
              summary: `End the sale on ${items.length} product(s): prices go back to normal`,
            };
            return { status: 'needs_confirmation', summary: ctx.st.pending.summary, count: items.length, sample: items.slice(0, 5).map((i) => `${i.name}: ${naira(i.oldKobo / 100)} ➜ ${naira(i.newKobo / 100)}`), note: 'Ask the vendor to confirm.' };
          }
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          if (!onSaleNow(p)) return { status: 'not_on_sale', message: `"${p.name}" is not on sale.` };
          await db.bulkSetPrices(biz.id, [{ id: p.id, newKobo: p.compare_at_price_kobo, compareKobo: null }]);
          const u = { ...p, price_kobo: p.compare_at_price_kobo, compare_at_price_kobo: null };
          ctx.cards.push(card(u, biz, { beforePrice: p.price_kobo }));
          touch(ctx, p.name);
          return { status: 'sale_ended', product: brief(u) };
        }

        case 'delete_product': {
          const r = await pick(biz, args.product, ctx);
          if (r.reply) return r.reply;
          const p = r.product;
          ctx.st.pending = {
            kind: 'delete', productId: p.id, name: p.name, turn: ctx.turn, expires: Date.now() + PENDING_TTL,
            summary: `Delete "${p.name}" (${naira(p.price_kobo / 100)}, stock ${fmtStock(p.stock_quantity)}) permanently`,
          };
          return { status: 'needs_confirmation', summary: ctx.st.pending.summary, note: 'Tell the vendor this cannot be undone (if the product has past orders it will be archived instead). Ask them to confirm.' };
        }

        case 'bulk_price_change': {
          const pct = Number(args.percent);
          if (!Number.isFinite(pct) || pct === 0 || pct < -90 || pct > 300) return { error: 'Percent must be between -90 and 300 and not zero.' };
          const all = await db.getAllProducts(biz.id);
          let targets = [];
          if (Array.isArray(args.products) && args.products.length) {
            for (const ref of args.products.slice(0, 30)) {
              const rr = resolveProduct(all, ref);
              if (rr.type === 'one') targets.push(rr.product);
              else return { status: 'ambiguous_or_missing', problem: ref, message: `Could not uniquely identify "${ref}". Ask the vendor.` };
            }
          } else {
            const scope = args.scope || 'all';
            targets = all.filter((p) => p.status !== 'archived' && (scope === 'all' || p.status === scope));
          }
          targets = [...new Map(targets.map((p) => [p.id, p])).values()];
          const sale = db.supportsSale();
          const items = targets
            .map((p) => {
              const base = sale && onSaleNow(p) ? p.compare_at_price_kobo : p.price_kobo;
              const item = { id: p.id, name: p.name, oldKobo: p.price_kobo, newKobo: roundPrice((base / 100) * (1 + pct / 100)) * 100 };
              if (sale) item.compareKobo = pct < 0 ? base : null; // discount = sale (old price crossed out), increase = new normal price
              return item;
            })
            .filter((i) => i.newKobo !== i.oldKobo);
          if (!items.length) return { error: 'No products would change.' };
          const sample = items.slice(0, 5).map((i) => `${i.name}: ${naira(i.oldKobo / 100)} ➜ ${naira(i.newKobo / 100)}`);
          ctx.st.pending = {
            kind: 'bulk_price', items, pct, turn: ctx.turn, expires: Date.now() + PENDING_TTL,
            summary: pct < 0 && sale ? `Put ${items.length} product(s) on sale at ${Math.abs(pct)}% off (old prices shown crossed out)` : `Change ${items.length} product price(s) by ${pct > 0 ? '+' : ''}${pct}%`,
          };
          return { status: 'needs_confirmation', summary: ctx.st.pending.summary, count: items.length, sample, note: 'Show the vendor a couple of examples and ask them to confirm.' };
        }

        case 'confirm_pending_action': {
          const pd = ctx.st.pending;
          if (!pd || pd.expires < Date.now()) { ctx.st.pending = null; return { error: 'Nothing is pending (it may have expired). Ask the vendor what they want.' }; }
          if (pd.turn === ctx.turn) return { error: 'Cannot confirm in the same message. Ask the vendor to confirm first.' };
          ctx.st.pending = null;
          if (pd.kind === 'delete') {
            const result = await db.deleteProduct({ id: pd.productId }, biz.id);
            ctx.cards.push(result === 'deleted' ? `🗑 ${pd.name} deleted` : `🗄 ${pd.name} archived (it has past orders, so it was hidden instead of deleted)`);
            return { status: result };
          }
          if (pd.kind === 'bulk_price') {
            await db.bulkSetPrices(biz.id, pd.items);
            const lines = pd.items.slice(0, 8).map((i) => `• ${i.name}: ${naira(i.oldKobo / 100)} ➜ ${naira(i.newKobo / 100)}`);
            const head = pd.pct == null ? `💰 Sale ended on ${pd.items.length} product${pd.items.length > 1 ? 's' : ''}` : pd.pct < 0 && db.supportsSale() ? `🏷 ${pd.items.length} product${pd.items.length > 1 ? 's' : ''} on sale (${Math.abs(pd.pct)}% off)` : `💰 Updated ${pd.items.length} price${pd.items.length > 1 ? 's' : ''} (${pd.pct > 0 ? '+' : ''}${pd.pct}%)`;
            ctx.cards.push([head, ...lines, pd.items.length > 8 ? `…and ${pd.items.length - 8} more` : null].filter(Boolean).join('\n'));
            return { status: 'prices_updated', count: pd.items.length };
          }
          return { error: 'Unknown pending action.' };
        }

        case 'cancel_pending_action': {
          const had = !!ctx.st.pending;
          ctx.st.pending = null;
          return { status: had ? 'cancelled' : 'nothing_pending' };
        }

        case 'get_store_stats': {
          const all = await db.getAllProducts(biz.id);
          const by = (s) => all.filter((p) => p.status === s);
          const active = by('active');
          return {
            total: all.length, drafts: by('draft').length, active: active.length, out_of_stock: by('out_of_stock').length, archived: by('archived').length,
            inventory_value_naira: active.reduce((s, p) => s + (p.price_kobo / 100) * (p.stock_quantity ?? 0), 0),
            stock_not_tracked: all.filter((p) => p.stock_quantity == null && p.status !== 'archived').length,
            low_stock: active.filter((p) => p.stock_quantity != null && p.stock_quantity <= 2).slice(0, 10).map(brief),
            without_photo: all.filter((p) => !p.image_url && p.status !== 'archived').length,
            store_link: storeUrl(biz),
          };
        }

        case 'orders_overview': {
          const o = await db.ordersOverview(biz.id, parseCount(args.days) ?? 7);
          return o || { error: 'Orders are not available.' };
        }

        case 'set_daily_summary': {
          if (!ctx.phone) return { error: 'Cannot save this setting right now.' };
          if (args.enabled === false) {
            await db.setDigestHour(ctx.phone, null);
            return { status: 'summary_off' };
          }
          const h = Math.min(21, Math.max(5, parseCount(args.hour) ?? 8));
          await db.setDigestHour(ctx.phone, h);
          return { status: 'summary_on', hour_24: h, note: `Sent every morning at ${h}:00 Lagos time, and only when there is something to report.` };
        }

        case 'recent_orders': {
          const o = await db.recentOrders(biz.id, parseCount(args.limit) ?? 10);
          return o || { error: 'Orders are not available.' };
        }

        default:
          return { error: `Unknown tool ${name}.` };
      }
    } catch (e) {
      log.error({ err: e.message, tool: name }, 'Tool failed');
      return { error: `The ${name} action failed on the server. Apologise briefly and suggest trying again.` };
    }
  }

  return { exec };
}
