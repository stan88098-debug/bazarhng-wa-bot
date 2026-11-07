import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const esc = (s) => s.replace(/[\\%_]/g, '\\$&');

// Columns that exist in the platform tables (discovered at startup so the bot adapts and never breaks).
const cols = { products: new Map(), orders: new Map() };
const textCol = (table, col) => ['text', 'character varying'].includes(cols[table].get(col));
export const hasOrders = () => cols.orders.has('business_id');

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
  try {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('products', 'orders')`
    );
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
    `SELECT name, price_kobo, COALESCE(stock_quantity, stock, 0) AS stock, status::text AS status
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
const normProduct = (r) =>
  r && {
    ...r,
    price_kobo: Number(r.price_kobo),
    stock_quantity: Number(r.stock_quantity ?? r.stock ?? 0),
  };

export async function getAllProducts(businessId) {
  const { rows } = await pool.query(
    `SELECT id, name, handle, price_kobo, status::text AS status,
            COALESCE(stock_quantity, stock, 0) AS stock_quantity, image_url, created_at
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
      const params = [businessId, name, handle, priceKobo, stock, images[0]?.url || null];
      if (withDesc) params.push(description);
      const res = await pool.query(
        `INSERT INTO products
           (business_id, name, handle, price_kobo, status, stock_quantity, stock, image_url${withDesc ? ', description' : ''})
         VALUES ($1, $2, $3, $4, 'draft', $5, $5, $6${withDesc ? ', $7' : ''}) RETURNING *`,
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
  return { product: normProduct({ ...row, stock_quantity: row.stock_quantity ?? row.stock }), imagesSaved, descriptionSaved: withDesc };
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
    if (images.length && (replace || !p.image_url)) {
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

const stockOf = (p) => p.stock_quantity ?? p.stock ?? 0;

// target: 'live' | 'draft' | 'archived'
export async function setProductStatus(p, target) {
  const status = target === 'live' ? (stockOf(p) === 0 ? 'out_of_stock' : 'active') : target === 'archived' ? 'archived' : 'draft';
  const { rows } = await pool.query(
    `UPDATE products SET status = $1::product_status, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, p.id]
  );
  return normProduct({ ...rows[0], stock_quantity: rows[0].stock_quantity ?? rows[0].stock });
}

export async function updateProduct(p, { price, stock, mode, name, description }) {
  let newStock = stockOf(p);
  if (stock != null) {
    newStock = mode === 'add' ? newStock + stock : mode === 'subtract' ? Math.max(0, newStock - stock) : stock;
  }
  const priceKobo = price != null ? Math.round(price * 100) : p.price_kobo;
  let status = p.status;
  if (status === 'active' || status === 'out_of_stock') status = newStock === 0 ? 'out_of_stock' : 'active';

  const params = [priceKobo, newStock, status];
  const sets = ['price_kobo = $1', 'stock_quantity = $2', 'stock = $2', 'status = $3::product_status', 'updated_at = NOW()'];
  if (name) { params.push(name); sets.push(`name = $${params.length}`); }
  if (description && textCol('products', 'description')) { params.push(description); sets.push(`description = $${params.length}`); }
  params.push(p.id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return normProduct({ ...rows[0], stock_quantity: rows[0].stock_quantity ?? rows[0].stock });
}

// items: [{ id, newKobo }]  (all-or-nothing)
export async function bulkSetPrices(businessId, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      await client.query(
        'UPDATE products SET price_kobo = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3',
        [it.newKobo, it.id, businessId]
      );
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

// ---------- orders (optional: only if the platform has an orders table with business_id) ----------
function cleanRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (/pass|token|secret|hash|key/i.test(k) || k === 'id' || k.endsWith('_id')) continue;
    if (v === null || v === undefined) continue;
    if (v instanceof Date) { out[k] = v.toISOString(); continue; }
    if (typeof v === 'object') continue;
    if (k.endsWith('_kobo') && Number.isFinite(Number(v))) { out[k.replace(/_kobo$/, '_naira')] = Number(v) / 100; continue; }
    out[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  }
  return out;
}

export async function recentOrders(businessId, limit = 10) {
  if (!hasOrders()) return null;
  const order = cols.orders.has('created_at') ? 'ORDER BY created_at DESC' : '';
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE business_id = $1 ${order} LIMIT $2`,
    [businessId, Math.min(Math.max(1, limit), 25)]
  );
  let byStatus = null;
  if (cols.orders.has('status')) {
    const r = await pool.query(
      `SELECT status::text AS status, COUNT(*)::int AS n FROM orders WHERE business_id = $1 GROUP BY 1`,
      [businessId]
    );
    byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  }
  return { orders: rows.map(cleanRow), byStatus };
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
