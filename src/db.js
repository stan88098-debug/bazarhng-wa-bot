import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        title VARCHAR(150) NOT NULL,
        price NUMERIC(12, 2) NOT NULL,
        stock INTEGER DEFAULT 1,
        status VARCHAR(50) DEFAULT 'draft',
        image_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("[db] schema verified successfully.");
  } finally {
    client.release();
  }
}

export async function getStoreContextByPhone(phone) {
  const client = await pool.connect();
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const res = await client.query(
      "SELECT id, name, phone FROM stores WHERE phone LIKE $1 OR phone LIKE $2 LIMIT 1",
      [`%${cleanPhone}%`, `%${phone}%`]
    );
    if (res.rows.length === 0) {
      const allStores = await client.query("SELECT id, name, phone FROM stores");
      console.log(`[db] lookup phone '${phone}' failed. Available stores in DB:`, allStores.rows);
      return null;
    }
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function getStoreStats(storeId) {
  const client = await pool.connect();
  try {
    const totalRes = await client.query("SELECT COUNT(*) FROM products WHERE store_id = $1", [storeId]);
    const draftsRes = await client.query("SELECT COUNT(*) FROM products WHERE store_id = $1 AND status = 'draft'", [storeId]);
    const activeRes = await client.query("SELECT COUNT(*) FROM products WHERE store_id = $1 AND status = 'active'", [storeId]);
    const recentRes = await client.query("SELECT title, price, status FROM products WHERE store_id = $1 ORDER BY created_at DESC LIMIT 3", [storeId]);

    return {
      totalProducts: Number(totalRes.rows[0].count),
      draftsCount: Number(draftsRes.rows[0].count),
      activeCount: Number(activeRes.rows[0].count),
      recentItems: recentRes.rows
    };
  } finally {
    client.release();
  }
}

export async function insertProductDraft(storeId, product) {
  const client = await pool.connect();
  try {
    const title = String(product.title || "Product Draft").slice(0, 150);
    const price = Number(product.price) || 0;
    const stock = Number(product.stock) || 1;
    const imageUrl = product.image_url || null;

    const res = await client.query(
      `INSERT INTO products (store_id, title, price, stock, status, image_url) 
       VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING *`,
      [storeId, title, price, stock, imageUrl]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}
