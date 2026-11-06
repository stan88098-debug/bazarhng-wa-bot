import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("[db] DATABASE_URL is missing");
  process.exit(1);
}

export const sql = postgres(process.env.DATABASE_URL, {
  ssl: "require",
  max: 5,
  idle_timeout: 20,
  connect_timeout: 30,
});

export function phoneSuffix(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-10);
}

export async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS stores (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT 'My Shop',
      phone       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      price       NUMERIC(12, 2) NOT NULL DEFAULT 0,
      stock       INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'draft',
      image_url   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const existingStores = await sql`SELECT id, name FROM stores ORDER BY id ASC LIMIT 1`;
  if (existingStores.length === 0) {
    await sql`
      INSERT INTO stores (name, phone)
      VALUES ('Default Shop', '2340000000000')
    `;
    console.log("[db] seeded default fallback store");
  }

  console.log("[db] schema ready");
}

export async function getStoreContextByPhone(phone) {
  try {
    const suffix = phoneSuffix(phone);
    let rows = [];
    if (suffix.length >= 10) {
      rows = await sql`
        SELECT id, name, phone
        FROM stores
        WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ${suffix}
        ORDER BY id ASC
        LIMIT 1
      `;
    }

    if (!rows.length) {
      rows = await sql`
        SELECT id, name, phone
        FROM stores
        ORDER BY id ASC
        LIMIT 1
      `;
    }

    let store = rows[0];
    if (!store) {
      const [created] = await sql`
        INSERT INTO stores (name, phone)
        VALUES ('Default Shop', ${phone || '2340000000000'})
        RETURNING id, name, phone
      `;
      store = created;
    }

    return { id: store.id, name: store.name, phone: store.phone };
  } catch (err) {
    console.error("[db] getStoreContextByPhone error:", err.message);
    // Absolute fallback so it never crashes
    const [fallback] = await sql`SELECT id, name, phone FROM stores ORDER BY id ASC LIMIT 1`;
    return fallback ? { id: fallback.id, name: fallback.name, phone: fallback.phone } : { id: 1, name: "Default Shop", phone: "" };
  }
}

export async function insertProductDraft(storeId, product) {
  const title = String(product.title || "Untitled item").trim().slice(0, 200);
  const price = Number(product.price);
  const stock = Number.isFinite(Number(product.stock)) ? Math.max(0, Math.floor(Number(product.stock))) : 1;
  const imageUrl = product.image_url || product.imageUrl || null;

  const [row] = await sql`
    INSERT INTO products (store_id, title, price, stock, status, image_url)
    VALUES (
      ${storeId},
      ${title},
      ${Number.isFinite(price) && price >= 0 ? price : 0},
      ${stock},
      'draft',
      ${imageUrl}
    )
    RETURNING id, store_id, title, price, stock, status, image_url, created_at
  `;

  return row;
}
