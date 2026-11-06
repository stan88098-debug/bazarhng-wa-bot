import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

export async function getStoreContextByPhone(phone) {
  try {
    // Clean phone number to match variants (with or without country code)
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const shortPhone = cleanPhone.slice(-10); // last 10 digits

    const stores = await sql`
      SELECT * FROM stores 
      WHERE phone LIKE ${'%' + shortPhone} 
      LIMIT 1
    `;

    if (stores.length > 0) {
      return { store: stores[0] };
    }

    // Fallback: If no store matches the phone, grab the first available store for testing/demo
    const defaultStore = await sql`SELECT * FROM stores LIMIT 1`;
    if (defaultStore.length > 0) {
      return { store: defaultStore[0] };
    }

    return null;
  } catch (err) {
    console.error("Database error in getStoreContextByPhone:", err.message);
    return null;
  }
}

export async function insertProductDraft(storeId, product) {
  try {
    const result = await sql`
      INSERT INTO products (store_id, title, price, stock, status, image_url)
      VALUES (${storeId}, ${product.title}, ${product.price}, ${product.stock || 1}, 'draft', ${product.imageUrl || null})
      RETURNING *
    `;
    return result[0];
  } catch (err) {
    console.error("Database error in insertProductDraft:", err.message);
    return null;
  }
}
