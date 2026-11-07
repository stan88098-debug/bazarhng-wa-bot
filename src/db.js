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
  return `${base}-${Math.random().toString(36.slice(2, 7))}`;
}

export async function ensureSchema() {
  // Schema is managed by your main app, just verify connection
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM businesses`;
  console.log(`[db] connected successfully. Found ${count} businesses in DB.`);
}

export async function getStoreContextByPhone(phone) {
  try {
    const suffix = phoneSuffix(phone);
    let rows = [];
    if (suffix.length >= 10) {
      rows = await sql`
        SELECT id, business_name, owner_phone, whatsapp_phone
        FROM businesses
        WHERE RIGHT(REGEXP_REPLACE(COALESCE(owner_phone, whatsapp_phone, ''), '[^0-9]', '', 'g'), 10) = ${suffix}
        ORDER BY id ASC
        LIMIT 1
      `;
    }

    if (!rows.length) {
      rows = await sql`
        SELECT id, business_name, owner_phone, whatsapp_phone
        FROM businesses
        ORDER BY id ASC
        LIMIT 1
      `;
    }

    const business = rows[0];
    if (!business) {
      throw new Error("No businesses found in the database.");
    }

    return { 
      id: business.id, 
      name: business.business_name, 
      phone: business.owner_phone || business.whatsapp_phone 
    };
  } catch (err) {
    console.error("[db] getStoreContextByPhone error:", err.message);
    const [fallback] = await sql`SELECT id, business_name, owner_phone FROM businesses ORDER BY id ASC LIMIT 1`;
    return fallback ? { id: fallback.id, name: fallback.business_name, phone: fallback.owner_phone } : null;
  }
}

export async function insertProductDraft(businessId, product) {
  const title = String(product.title || "Untitled item").trim().slice(0, 200);
  
  // Convert Naira to kobo (integer) as required by price_kobo
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
    RETURNING id, business_id, name, price_kobo, status, image_url, created_at
  `;

  return {
    ...row,
    price: row.price_kobo / 100 // convert back for confirmation text display
  };
}
