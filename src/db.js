import { neon } from "@neondatabase/serverless";

export async function getStoreContextByPhone(phoneNumber) {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.log("⚠️ DATABASE_URL not set in environment.");
      return null;
    }
    
    const sql = neon(dbUrl);
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
    const matchPattern = '%' + cleanPhone.slice(-10);

    const stores = await sql`
      SELECT id, name, slug, phone
      FROM stores 
      WHERE phone LIKE ${matchPattern} 
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
      LIMIT 20
    `;

    return {
      store,
      products: products || [],
    };
  } catch (err) {
    console.error("Database Lookup Error:", err.message);
    return null;
  }
}

export async function insertProductDraft(storeId, productData) {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return null;

    const sql = neon(dbUrl);
    const result = await sql`
      INSERT INTO products (store_id, title, price, stock, is_published)
      VALUES (
        ${storeId}, 
        ${productData.title}, 
        ${productData.price}, 
        ${productData.stock || 1}, 
        false
      )
      RETURNING id, title, price
    `;
    return result[0];
  } catch (err) {
    console.error("Database Insert Error:", err.message);
    return null;
  }
}
