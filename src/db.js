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

function generateHandle(title) {
  const base = String(title || "product")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
  const rand = Math.random().toString(36).substring(2, 7);
  return `${base}-${rand}`;
}

export async function ensureSchema() {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM businesses`;
  console.log(`[db] connected successfully. Found ${count} businesses in DB.`);
}

export async function getStoreContextByPhone(phone) {
  try {
    const suffix = phoneSuffix(phone);
    if (suffix.length >= 10) {
      // Search exact match on owner_phone or whatsapp_phone suffix
      const rows = await sql`
        SELECT id, business_name, owner_phone, whatsapp_phone
        FROM businesses
        WHERE RIGHT(REGEXP_REPLACE(COALESCE(owner_phone, ''), '[^0-9]', '', 'g'), 10) = ${suffix}
           OR RIGHT(REGEXP_REPLACE(COALESCE(whatsapp_phone, ''), '[^0-9]', '', 'g'), 10) = ${suffix}
        LIMIT 1
      `;
      if (rows.length > 0) {
        return { 
          id: rows[0].id, 
          name: rows[0].business_name, 
          phone: rows[0].owner_phone || rows[0].whatsapp_phone 
        };
      }
    }

    // Fallback if no exact match found
    const [fallback] = await sql`SELECT id, business_name, owner_phone FROM businesses ORDER BY id ASC LIMIT 1`;
    return fallback ? { id: fallback.id, name: fallback.business_name, phone: fallback.owner_phone } : null;
  } catch (err) {
    console.error("[db] getStoreContextByPhone error:", err.message);
    return null;
  }
}

export async function insertProductDraft(businessId, product) {
  const title = String(product.title || "Untitled item").trim().slice(0, 200);
  const nairaPrice = Number(product.price) || 0;
  const priceKobo = Math.round(nairaPrice * 100);
  const stock = Number.isFinite(Number(product.stock)) ? Math.max(0, Math.floor(Number(product.stock))) : 1;
  const handle = generateHandle(title);
  const imageUrl = product.image_url || product.imageUrl || null;

  const [row] = await sql`
    INSERT INTO products (
      business_id, 
      name, 
      handle, 
      price_kobo, 
      status, 
      currency, 
      sort_order, 
      stock_quantity, 
      image_url
    )
    VALUES (
      ${businessId},
      ${title},
      ${handle},
      ${priceKobo},
      'draft',
      'NGN',
      0,
      ${stock},
      ${imageUrl}
    )
    RETURNING id, business_id, name, price_kobo, stock_quantity, status, image_url, created_at
  `;

  return {
    id: row.id,
    title: row.name,
    price: row.price_kobo / 100,
    stock: row.stock_quantity
  };
}
