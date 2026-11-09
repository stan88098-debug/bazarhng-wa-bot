// Self-test: runs with plain `node test.js` (no database, no WhatsApp, no internet).
// The deploy script runs this before pushing, so a broken change never reaches Render.
import { parseMoney, parseCount, similarity, resolveProduct, roundPrice, lagosNow, detectLang } from './util.js';
import { createToolbox, toolDefs } from './tools.js';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('FAIL', l); } };

// ---- util ----
ok(parseMoney('45k') === 45000 && parseMoney('2.5k') === 2500 && parseMoney('1.2m') === 1200000 && parseMoney('₦45,000') === 45000, 'money parsing');
ok(parseMoney('abc') === null && parseCount(-1) === null && parseCount('3') === 3, 'bad numbers rejected');
ok(roundPrice(40500) === 40500 && roundPrice(2198.9) === 2200, 'price rounding');
const P = [
  { id: 'a1', name: 'Nike Air Max 45', handle: 'a' }, { id: 'a2', name: 'Nike Air Force 1', handle: 'b' },
  { id: 'a3', name: 'Adidas Samba', handle: 'c' }, { id: 'a4', name: 'Nike Air Max 42', handle: 'd' },
];
ok(resolveProduct(P, 'samba').product?.id === 'a3', 'finds by partial name');
ok(resolveProduct(P, 'adidas sambas').product?.id === 'a3', 'tolerates a typo');
ok(resolveProduct(P, 'nike').type === 'many', 'asks when ambiguous');
ok(resolveProduct(P, 'ghost').type === 'none' && resolveProduct(P, '2').type === 'none', 'no wild guesses');
ok(similarity('Nike Air Max 42', 'Nike Air Max 45') < 0.96, 'variants are not duplicates');
const lg = lagosNow(new Date('2026-11-09T23:30:00Z'));
ok(lg.date === '2026-11-10' && lg.hour === 0 && lg.weekday === 2, 'Lagos clock is UTC+1');
ok(detectLang('abeg wetin be the price') === 'pcm' && detectLang('please add nike') === 'en', 'language hint');

// ---- tools (fake database) ----
let n = 0;
const mk = (name, price, stock, status = 'draft', image = null, cmp = null) =>
  ({ id: `id-${++n}-xxxxxx`, name, handle: name.toLowerCase().replace(/ /g, '-'), price_kobo: price * 100, compare_at_price_kobo: cmp, stock_quantity: stock, status, image_url: image });
const store = [mk('Nike Air Max 45', 45000, 3, 'active', 'u'), mk('Nike Air Force 1', 38000, 0, 'out_of_stock'), mk('Adidas Samba', 30000, 5, 'draft'), mk('Local Rice', 8000, null, 'active', 'u')];
let digest = 'unset';
const db = {
  supportsSale: () => true,
  getAllProducts: async () => store.map((p) => ({ ...p })),
  createDraftProduct: async ({ name, price, stock, images }) => { const p = mk(name, price, stock, 'draft', images[0]?.url || null); store.unshift(p); return { product: { ...p }, imagesSaved: images.length, descriptionSaved: false }; },
  updateProduct: async (p, { price, stock, mode }) => { const r = store.find((x) => x.id === p.id); if (price != null) r.price_kobo = Math.round(price * 100); if (stock != null) r.stock_quantity = mode === 'add' ? (r.stock_quantity ?? 0) + stock : mode === 'subtract' ? Math.max(0, (r.stock_quantity ?? 0) - stock) : stock; if (r.stock_quantity != null && (r.status === 'active' || r.status === 'out_of_stock')) r.status = r.stock_quantity === 0 ? 'out_of_stock' : 'active'; return { ...r }; },
  setProductStatus: async (p, t) => { const r = store.find((x) => x.id === p.id); r.status = t === 'live' ? (r.stock_quantity === 0 ? 'out_of_stock' : 'active') : t === 'archived' ? 'archived' : 'draft'; return { ...r }; },
  deleteProduct: async (p) => { store.splice(store.findIndex((x) => x.id === p.id), 1); return 'deleted'; },
  bulkSetPrices: async (b, items) => { for (const it of items) { const r = store.find((x) => x.id === it.id); r.price_kobo = it.newKobo; if (it.compareKobo !== undefined) r.compare_at_price_kobo = it.compareKobo; } return items.length; },
  addProductImages: async () => 1,
  recentOrders: async () => ({ orders: [{ order_number: 'BZ-1', total_naira: 15000 }] }),
  ordersOverview: async () => ({ days: 7, orders: 4, revenue_naira: 60000, best_sellers: [] }),
  setDigestHour: async (phone, h) => { digest = h; },
};
const media = { uploadProductImage: async () => ({ url: 'https://img/x.jpg', publicId: 'pid' }) };
const { exec } = createToolbox({ db, media, siteUrl: 'https://site', log: { error: () => {} } });
const biz = { id: 'b1', slug: 'my-shop' };
const st = { photos: [], pending: null, lastTouched: null };
const ctx = (turn) => ({ biz, phone: '2347000000000', st, turn, cards: [] });

let c = ctx(1), r = await exec('add_product', { name: 'Gucci Bag', price: 120000, stock: 2 }, c);
ok(r.status === 'created_as_draft' && store[0].price_kobo === 12000000 && c.cards[0].includes('₦120,000'), 'add product');
st.photos = [{ buffer: Buffer.from('a'), ts: Date.now() }, { buffer: Buffer.from('b'), ts: Date.now() }];
c = ctx(2); r = await exec('add_product', { name: 'Rolex Watch', price: 250000 }, c);
ok(r.photos_attached === 2 && st.photos.length === 0, 'photos attach once');
c = ctx(3); r = await exec('add_product', { name: 'Adidas Samba', price: 30000 }, c);
ok(r.status === 'possible_duplicate', 'duplicate check');
c = ctx(3); r = await exec('add_product', { name: 'Pen', price: 5 }, c);
ok(r.status === 'needs_check', 'odd price check');
c = ctx(4); r = await exec('update_product', { product: 'nike air', price: 50000 }, c);
ok(r.status === 'ambiguous' && st.lastChoices?.ids.length === 2, 'ambiguous asks which, remembers the list');
c = ctx(5); r = await exec('update_product', { product: '1', price: 50000 }, c);
ok(r.status === 'updated', 'reply "1" picks the first listed product');
c = ctx(6); r = await exec('update_product', { product: 'local rice', stock: 2, stock_mode: 'subtract' }, c);
ok(r.status === 'stock_not_tracked', 'untracked stock cannot be subtracted');
c = ctx(6); r = await exec('update_product', { product: 'local rice', price: 9000 }, c);
ok(r.status === 'updated' && r.product.status === 'active', 'untracked product stays active');
c = ctx(7); r = await exec('set_sale', { product: 'samba', percent_off: 20 }, c);
ok(r.status === 'sale_started' && store.find((p) => p.name === 'Adidas Samba').compare_at_price_kobo === 3000000 && c.cards[0].includes('was'), 'sale shows old price');
c = ctx(7); r = await exec('end_sale', { product: 'samba' }, c);
ok(r.status === 'sale_ended' && store.find((p) => p.name === 'Adidas Samba').price_kobo === 3000000, 'sale ends at old price');
c = ctx(8); r = await exec('delete_product', { product: 'gucci' }, c);
ok(r.status === 'needs_confirmation' && !!(await exec('confirm_pending_action', {}, c)).error, 'delete waits, cannot confirm in same turn');
c = ctx(9); r = await exec('confirm_pending_action', {}, c);
ok(r.status === 'deleted', 'delete after yes');
c = ctx(10); r = await exec('bulk_price_change', { percent: -10, scope: 'all' }, c);
ok(r.status === 'needs_confirmation' && r.count >= 1, 'bulk preview');
c = ctx(11); r = await exec('confirm_pending_action', {}, c);
ok(r.status === 'prices_updated', 'bulk applied after yes');
c = ctx(12); r = await exec('bulk_price_change', { percent: -95 }, c);
ok(!!r.error, 'bulk limits');
c = ctx(13); r = await exec('set_daily_summary', { enabled: true, hour: 7 }, c);
ok(r.status === 'summary_on' && digest === 7, 'summary on');
r = await exec('set_daily_summary', { enabled: false }, c);
ok(r.status === 'summary_off' && digest === null, 'summary off');
r = await exec('orders_overview', { days: 7 }, c);
ok(r.orders === 4, 'orders overview');
ok(toolDefs({ hasOrders: true }).length === toolDefs({ hasOrders: false }).length + 2, 'order tools only when orders exist');

// ---- agent loop (fake Groq) ----
process.env.GROQ_API_KEY = 'test';
const { runAgent } = await import('./ai.js');
const base = { biz: { business_name: 'My Shop' }, stats: { total: 1, drafts: 1, active: 0, out_of_stock: 0, archived: 0, recent: [] }, history: [], tools: [], ctx: { now: 'now', storeUrl: 's', siteUrl: 'd', photos: [], lastTouched: null, pending: null } };
const resp = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
let step = 0; const ran = [];
globalThis.fetch = async () => { step++; return step === 1
  ? resp({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'add_product', arguments: '{"name":"Bag","price":1000}' } }] } }] })
  : resp({ choices: [{ message: { content: 'Done.' } }] }); };
ok((await runAgent({ ...base, text: 'add bag 1k', execTool: async (nm, a) => { ran.push([nm, a]); return { status: 'ok' }; } })) === 'Done.' && ran[0][1].price === 1000, 'agent runs a tool then answers');
const models = [];
globalThis.fetch = async (u, init) => { const m = JSON.parse(init.body).model; models.push(m); return m.includes('gpt-oss') ? resp('rate', 429) : resp({ choices: [{ message: { content: 'from fallback' } }] }); };
ok((await runAgent({ ...base, text: 'hi', execTool: async () => ({}) })) === 'from fallback' && models.length === 2, 'rate limit switches model');
let calls = 0;
globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); calls++; return b.tool_choice === 'none' ? resp({ choices: [{ message: { content: 'wrapped up' } }] }) : resp({ choices: [{ message: { content: '', tool_calls: [{ id: 'c' + calls, function: { name: 'list_products', arguments: '{}' } }] } }] }); };
ok((await runAgent({ ...base, text: 'loop', execTool: async () => ({}) })) === 'wrapped up' && calls <= 8, 'endless tool loop is cut off');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
