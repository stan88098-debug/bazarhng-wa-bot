import { neon } from "@neondatabase/serverless";

export async function getStoreContextByPhone(phoneNumber) {
  try {
    if (!process.environ?.DATABASE_URL && !process.env.DATABASE_URL) {
      console.log("⚠️ DATABASE_URL not set in environment.");
      return null;
    }
    
    const sql = neon(process.env.DATABASE_URL);
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");

    const stores = await sql`
      SELECT id, name, slug, phone
      FROM stores 
      WHERE phone LIKE ${'%' + cleanPhone.slice(-10)} 
      LIMIT 1
    `;

    if (!stores || stores.length === 0) {
      return null;
    }

    const store = stores[0];

    const products = await sql`
      SELECT title, price, stock, is_published 
      FROM products 
      WHERE store_id = ${store.id} 
      ORDER BY created_at DESC 
      LIMIT 15
    `;

    return {
      store,
      products: products || [],
    };
  } catch (err) {
    console.error("Database Lookup Error (Safe Mode):", err.message);
    return null;
  }
}

export async function insertProductDraft(storeId, productData) {
  try {
    const sql = neon(process.env.DATABASE_URL);
    const result = await sql`
      INSERT INTO products (store_id, title, price, stock, is_published)
      VALUES (${storeId}, ${productData.title}, ${productData.price}, ${productData.stock || 1}, false)
      RETURNING id, title, price
    `;
    return result[0];
  } catch (err) {
    console.error("Database Insert Error (Safe Mode):", err.message);
    return null;
  }
}
