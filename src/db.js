import { neon } from "@neondatabase/serverless";

// Fallback to your Neon connection string if env var is missing
const sql = neon(process.env.DATABASE_URL || "postgresql://neondb_owner:npg_ARpltcqv5Sn8@ep-patient-meadow-b4o33wug-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require");

/**
 * Fetch store and inventory context for a vendor by their phone number
 */
export async function getStoreContextByPhone(phoneNumber) {
  try {
    // Sanitize phone number (e.g. 2348012345678 -> find matching user or store)
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");

    // Query user/store by phone
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

    // Fetch store items to build AI context
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
    console.error("Error fetching store context from Neon:", err);
    return null;
  }
}

/**
 * Insert new product draft directly into Neon
 */
export async function insertProductDraft(storeId, productData) {
  try {
    const result = await sql`
      INSERT INTO products (store_id, title, price, stock, is_published)
      VALUES (${storeId}, ${productData.title}, ${productData.price}, ${productData.stock || 1}, false)
      RETURNING id, title, price
    `;
    return result[0];
  } catch (err) {
    console.error("Error inserting product into Neon:", err);
    return null;
  }
}
