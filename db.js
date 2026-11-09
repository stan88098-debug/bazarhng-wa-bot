import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const esc = (s) => s.replace(/[\\%_]/g, '\\$&');

// Columns that exist in the platform tables (discovered at startup so the bot adapts and never breaks).
const cols = { products: new Map(), orders: new Map(), order_items: new Map() };
const textCol = (table, col) => ['text', 'character varying'].includes(cols[table].get(col));
export const hasOrders = () => cols.orders.has('business_id');
const hasProductCol = (c) => cols.products.has(c);
// Sale prices use the site's compare_at_price_kobo column (old price crossed out + discount badge)
export const supportsSale = () => hasProductCol('compare_at_price_kobo');
// stock_quantity is the real column (NULL = "stock not tracked"). A legacy `stock` column is only used if it exists.
const stockExpr = () => (hasProductCol('stock') ? 'COALESCE(stock_quantity, stock)' : 'stock_quantity');
// photo shown for a product: first gallery image, falling back to a legacy products.image_url column if present
const photoExpr = () =>
  `(SELECT pi.url FROM product_images pi WHERE pi.product_id = products.id ORDER BY pi.sort_order ASC, pi.created_at ASC LIMIT 1)`;
const photoSelect = () => (hasProductCol('image_url') ? `COALESCE(${photoExpr()}, products.image_url)` : photoExpr());

// The bot only creates its own tables (wa_session, wa_chat). It never touches platform tables' structure.
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_session (
      file TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chat (
      phone TEXT PRIMARY KEY,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_prefs (
      phone TEXT PRIMARY KEY,
      digest_hour INT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_jobs (
      key TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('products', 'orders', 'order_items')`
    );
    for (const m of Object.values(cols)) m.clear();
    for (const r of rows) cols[r.table_name].set(r.column_name, r.data_type);
  } catch (e) {
    console.warn('Schema introspection failed (continuing with defaults):', e.message);
  }
}

// ---------- store owner authorization ----------
export async function getBusinessByPhone(phone) {
  const key = digits10(phone);
  if (key.length < 10) return null;
  const { rows } = await pool.query(
    `SELECT id, business_name, slug, owner_name, is_active
     FROM businesses
     WHERE RIGHT(REGEXP_REPLACE(owner_phone, '\\D', '', 'g'), 10) = $1
        OR RIGHT(REGEXP_REPLACE(whatsapp_phone, '\\D', '', 'g'), 10) = $1
     ORDER BY is_active DESC, created_at ASC
     LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

export async function getStoreStats(businessId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'out_of_stock')::int AS out_of_stock,
            COUNT(*) FILTER (WHERE status = 'archived')::int AS archived
     FROM products WHERE business_id = $1`,
    [businessId]
  );
  const recent = await pool.query(
    `SELECT name, price_kobo, ${stockExpr()} AS stock, status::text AS status
     FROM products WHERE business_id = $1 ORDER BY created_at DESC LIMIT 15`,
    [businessId]
  );
  return { ...rows[0], recent: recent.rows };
}

// ---------- products ----------
function slugify(name) {
  return (
    String(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product'
  );
}

async function uniqueHandle(businessId, name) {
  const base = slugify(name);
  const { rows } = await pool.query(
    `SELECT handle FROM products WHERE business_id = $1 AND handle LIKE $2`,
    [businessId, esc(base) + '%']
  );
  const taken = new Set(rows.map((r) => r.handle));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// pg returns bigint/numeric as strings, so normalise numbers once here
const normProduct = (r) => {
  if (!r) return r;
  const raw = r.stock_quantity ?? r.stock ?? null; // null = stock not tracked
  return {
    ...r,
    price_kobo: Number(r.price_kobo),
    stock_quantity: raw == null ? null : Number(raw),
    compare_at_price_kobo: r.compare_at_price_kobo == null ? null : Number(r.compare_at_price_kobo),
  };
};

export async function getAllProducts(businessId) {
  const { rows } = await pool.query(
    `SELECT id, name, handle, price_kobo, status::text AS status,
            ${stockExpr()} AS stock_quantity, ${photoSelect()} AS image_url, ${supportsSale() ? 'compare_at_price_kobo' : 'NULL::int AS compare_at_price_kobo'}, created_at
     FROM products WHERE business_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [businessId]
  );
  return rows.map(normProduct);
}

// images: [{url, publicId}]  ->  { product, imagesSaved, descriptionSaved }
export async function createDraftProduct({ businessId, name, price, stock, images = [], description = null }) {
  const priceKobo = Math.round(price * 100);
  const withDesc = !!description && textCol('products', 'description');
  let handle = await uniqueHandle(businessId, name);
  let row;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const names = ['business_id', 'name', 'handle', 'price_kobo', 'status', 'stock_quantity'];
      const params = [businessId, name, handle, priceKobo, stock];
      const marks = ['$1', '$2', '$3', '$4', `'draft'`, '$5'];
      const add = (col, val) => { params.push(val); names.push(col); marks.push(`$${params.length}`); };
      if (hasProductCol('stock')) { names.push('stock'); marks.push('$5'); }
      if (hasProductCol('image_url') && images[0]?.url) add('image_url', images[0].url);
      if (withDesc) add('description', description);
      const res = await pool.query(
        `INSERT INTO products (${names.join(', ')}) VALUES (${marks.join(', ')}) RETURNING *`,
        params
      );
      row = res.rows[0];
      break;
    } catch (e) {
      if (e.code === '23505') handle = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
      else throw e;
    }
  }
  if (!row) throw new Error('Could not generate a unique product handle');

  let imagesSaved = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      await pool.query(
        `INSERT INTO product_images (id, product_id, cloudinary_public_id, url, alt_text, sort_order, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
        [row.id, images[i].publicId, images[i].url, name, i]
      );
      imagesSaved++;
    } catch (e) {
      console.error('product_images insert failed:', e.message);
    }
  }
  return { product: normProduct({ ...row, stock_quantity: row.stock_quantity ?? row.stock ?? stock }), imagesSaved, descriptionSaved: withDesc };
}

// Add (or replace) gallery photos on an existing product
export async function addProductImages(p, images, { replace = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let start = 0;
    if (replace) {
      await client.query('DELETE FROM product_images WHERE product_id = $1', [p.id]);
    } else {
      const { rows } = await client.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_images WHERE product_id = $1', [p.id]
      );
      start = Number(rows[0].n);
    }
    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO product_images (id, product_id, cloudinary_public_id, url, alt_text, sort_order, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
        [p.id, images[i].publicId, images[i].url, p.name, start + i]
      );
    }
    if (images.length && hasProductCol('image_url') && (replace || !p.image_url)) {
      await client.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [images[0].url, p.id]);
    }
    await client.query('COMMIT');
    return images.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const stockOf = (p) => p.stock_quantity ?? p.stock ?? null; // null = not tracked

// target: 'live' | 'draft' | 'archived'. Only a tracked stock of 0 counts as out of stock.
export async function setProductStatus(p, target) {
  const status = target === 'live' ? (stockOf(p) === 0 ? 'out_of_stock' : 'active') : target === 'archived' ? 'archived' : 'draft';
  const { rows } = await pool.query(
    `UPDATE products SET status = $1::product_status, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, p.id]
  );
  return normProduct(rows[0]);
}

export async function updateProduct(p, { price, stock, mode, name, description }) {
  let newStock = stockOf(p);
  if (stock != null) {
    const base = newStock ?? 0;
    newStock = mode === 'add' ? base + stock : mode === 'subtract' ? Math.max(0, base - stock) : stock;
  }
  const priceKobo = price != null ? Math.round(price * 100) : p.price_kobo;
  let status = p.status;
  if ((status === 'active' || status === 'out_of_stock') && newStock != null) status = newStock === 0 ? 'out_of_stock' : 'active';

  const params = [priceKobo, newStock, status];
  const sets = ['price_kobo = $1', 'stock_quantity = $2', 'status = $3::product_status', 'updated_at = NOW()'];
  if (hasProductCol('stock')) sets.push('stock = $2');
  // a new regular price replaces any running sale
  if (price != null && supportsSale() && p.compare_at_price_kobo != null) sets.push('compare_at_price_kobo = NULL');
  if (name) { params.push(name); sets.push(`name = $${params.length}`); }
  if (description && textCol('products', 'description')) { params.push(description); sets.push(`description = $${params.length}`); }
  params.push(p.id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return normProduct(rows[0]);
}

// items: [{ id, newKobo, compareKobo? }]  (all-or-nothing)
// compareKobo: number = start/keep a sale (old price shown crossed out), null = end the sale, undefined = leave as is
export async function bulkSetPrices(businessId, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      if (supportsSale() && it.compareKobo !== undefined) {
        await client.query(
          'UPDATE products SET price_kobo = $1, compare_at_price_kobo = $2, updated_at = NOW() WHERE id = $3 AND business_id = $4',
          [it.newKobo, it.compareKobo, it.id, businessId]
        );
      } else {
        await client.query(
          'UPDATE products SET price_kobo = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3',
          [it.newKobo, it.id, businessId]
        );
      }
    }
    await client.query('COMMIT');
    return items.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Permanent delete. If orders or other records reference it, archive instead.
export async function deleteProduct(p, businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_images WHERE product_id = $1', [p.id]);
    await client.query('DELETE FROM products WHERE id = $1 AND business_id = $2', [p.id, businessId]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23503') {
      await pool.query(`UPDATE products SET status = 'archived', updated_at = NOW() WHERE id = $1 AND business_id = $2`, [p.id, businessId]);
      return 'archived';
    }
    throw e;
  } finally {
    client.release();
  }
}

// ---------- orders (only if the platform has them; columns are checked at startup) ----------
const ORDER_COLS = ['order_number', 'status', 'payment_record_status', 'customer_name', 'customer_phone', 'delivery_method', 'total_kobo', 'tracking_number', 'created_at'];
const ENUM_COLS = new Set(['status', 'payment_record_status']);
const hasItems = () => cols.order_items.has('order_id') && cols.order_items.has('product_name') && cols.order_items.has('quantity');

function cleanRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) continue;
    if (v instanceof Date) { out[k] = v.toISOString(); continue; }
    if (typeof v === 'object') continue;
    if (k.endsWith('_kobo') && Number.isFinite(Number(v))) { out[k.replace(/_kobo$/, '_naira')] = Number(v) / 100; continue; }
    out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return out;
}

export async function recentOrders(businessId, limit = 10) {
  if (!hasOrders()) return null;
  const picked = ORDER_COLS.filter((c) => cols.orders.has(c)).map((c) => (ENUM_COLS.has(c) ? `o.${c}::text AS ${c}` : `o.${c}`));
  if (hasItems()) picked.push(`(SELECT string_agg(oi.product_name || ' x' || oi.quantity, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS items`);
  const order = cols.orders.has('created_at') ? 'ORDER BY o.created_at DESC' : '';
  const { rows } = await pool.query(
    `SELECT ${picked.join(', ') || 'o.id'} FROM orders o WHERE o.business_id = $1 ${order} LIMIT $2`,
    [businessId, Math.min(Math.max(1, limit), 25)]
  );
  return { orders: rows.map(cleanRow) };
}

// Sales picture for the last N days: orders by status, revenue (cancelled excluded), best sellers
export async function ordersOverview(businessId, days = 7) {
  if (!hasOrders() || !cols.orders.has('status') || !cols.orders.has('total_kobo') || !cols.orders.has('created_at')) return null;
  const d = Math.min(Math.max(1, days), 365);
  const byStatus = await pool.query(
    `SELECT status::text AS status, COUNT(*)::int AS n, COALESCE(SUM(total_kobo), 0)::bigint AS total
     FROM orders WHERE business_id = $1 AND created_at >= NOW() - make_interval(days => $2) GROUP BY 1`,
    [businessId, d]
  );
  const open = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE business_id = $1 AND status::text IN ('pending', 'confirmed', 'preparing')`,
    [businessId]
  );
  let best = [];
  if (hasItems() && cols.order_items.has('line_total_kobo')) {
    const r = await pool.query(
      `SELECT oi.product_name AS name, SUM(oi.quantity)::int AS qty, COALESCE(SUM(oi.line_total_kobo), 0)::bigint AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.business_id = $1 AND o.status::text <> 'cancelled' AND o.created_at >= NOW() - make_interval(days => $2)
       GROUP BY 1 ORDER BY qty DESC, total DESC LIMIT 5`,
      [businessId, d]
    );
    best = r.rows.map((x) => ({ name: x.name, sold: x.qty, revenue_naira: Number(x.total) / 100 }));
  }
  const statuses = {};
  let orders = 0, revenue = 0;
  for (const r of byStatus.rows) {
    statuses[r.status] = r.n;
    orders += r.n;
    if (r.status !== 'cancelled') revenue += Number(r.total) / 100;
  }
  return { days: d, orders, revenue_naira: revenue, by_status: statuses, open_orders_now: open.rows[0]?.n ?? 0, best_sellers: best };
}

// ---------- vendor preferences + once-only jobs ----------
export async function getDigestHour(phone) {
  const { rows } = await pool.query('SELECT digest_hour FROM wa_prefs WHERE phone = $1', [phone]);
  return rows[0]?.digest_hour ?? null;
}
export async function setDigestHour(phone, hour) {
  await pool.query(
    `INSERT INTO wa_prefs (phone, digest_hour) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET digest_hour = EXCLUDED.digest_hour`,
    [phone, hour]
  );
}
// vendors whose summary hour has come (up to 2 hours late, in case the bot was restarting)
export async function listDigestSubscribers(hour) {
  const { rows } = await pool.query(
    'SELECT phone FROM wa_prefs WHERE digest_hour IS NOT NULL AND digest_hour <= $1 AND $1 < digest_hour + 3',
    [hour]
  );
  return rows.map((r) => r.phone);
}
// true only the first time a key is claimed, so a job never runs twice
export async function claimJob(key) {
  const { rows } = await pool.query('INSERT INTO wa_jobs (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key]);
  return rows.length > 0;
}

// ---------- chat memory (survives redeploys) ----------
export async function loadChat(phone) {
  const { rows } = await pool.query(
    `SELECT history FROM wa_chat WHERE phone = $1 AND updated_at > NOW() - INTERVAL '24 hours'`,
    [phone]
  );
  return Array.isArray(rows[0]?.history) ? rows[0].history : [];
}
export async function saveChat(phone, history) {
  await pool.query(
    `INSERT INTO wa_chat (phone, history, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE SET history = EXCLUDED.history, updated_at = NOW()`,
    [phone, JSON.stringify(history)]
  );
}

// ---------- WhatsApp session persistence (Render's disk is wiped on deploy) ----------
export async function saveSessionFile(file, data) {
  await pool.query(
    `INSERT INTO wa_session (file, data) VALUES ($1, $2)
     ON CONFLICT (file) DO UPDATE SET data = EXCLUDED.data`,
    [file, data]
  );
}
export async function loadSessionFiles() {
  const { rows } = await pool.query('SELECT file, data FROM wa_session');
  return rows;
}
export async function clearSession() {
  await pool.query('DELETE FROM wa_session');
}
