import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

export async function getStoreContextByPhone(phone) {
  try {
    const cleanPhone = phone ? phone.replace(/[^0-9]/g, "") : "";
    const shortPhone = cleanPhone.slice(-10);

    if (shortPhone) {
      const stores = await sql`
        SELECT * FROM stores 
        WHERE phone LIKE ${'%' + shortPhone} 
        LIMIT 1
      `;
      if (stores.length > 0) {
        console.log(`✅ Found store for phone ${phone}:`, stores[0].name, "(ID:", stores[0].id, ")");
        return { store: stores[0] };
      }
    }

    // Fallback: grab the first store in the database so it never returns null
    const defaultStore = await sql`SELECT * FROM stores LIMIT 1`;
    if (defaultStore.length > 0) {
      console.log(`⚠️ Using default fallback store:`, defaultStore[0].name, "(ID:", defaultStore[0].id, ")");
      return { store: defaultStore[0] };
    }

    console.log(`❌ No stores found in database!`);
    return null;
  } catch (err) {
    console.error("❌ Database error in getStoreContextByPhone:", err.message);
    return null;
  }
}

export async function insertProductDraft(storeId, product) {
  try {
    console.log(`Inserting product into DB for store ID ${storeId}:`, product);
    const result = await sql`
      INSERT INTO products (store_id, title, price, stock, status, image_url)
      VALUES (${storeId}, ${product.title}, ${product.price}, ${product.stock || 1}, 'draft', ${product.imageUrl || null})
      RETURNING *
    `;
    console.log(`✅ Successfully inserted product ID:`, result[0]?.id);
    return result[0];
  } catch (err) {
    console.error("❌ CRITICAL Database error in insertProductDraft:", err.message);
    return null;
  }
}
