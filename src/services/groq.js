import Groq from "groq-sdk";

const MODEL = "llama-3.1-8b-instant";

const SYSTEM = `You are BazarhNG's vendor assistant for Nigerian shop owners messaging on WhatsApp.
Parse the vendor's message and reply with ONLY valid JSON (no markdown, no commentary).

Two intents only:

1) ADD_PRODUCT — when they describe an item to list (name + price, optional stock).
{"intent":"ADD_PRODUCT","product":{"title":"string","price":number,"stock":number}}

2) CHAT — questions, greetings, help, anything that is not clearly adding a product.
{"intent":"CHAT","reply":"short friendly helpful message"}

Rules:
- price is a number in Naira (no currency symbol). "5k" → 5000, "1,500" → 1500.
- stock defaults to 1 if not stated.
- title is a clean product name, not the whole sentence.
- CHAT replies must be friendly and can mention the store name if given.
- Never invent a product if the message is only a greeting or question.`;

function getClient() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing");
  }
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

export function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function regexFallback(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return { intent: "CHAT", reply: "Send a product name and price, e.g. Big fridge for 5000" };
  }

  let price = null;
  const kMatch = text.match(/(?:₦|ngn|naira|n)?\s*(\d+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) {
    price = Math.round(parseFloat(kMatch[1]) * 1000);
  }

  if (price == null) {
    const money = text.match(/(?:₦|ngn|naira|n)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/i);
    if (money) {
      price = Math.round(parseFloat(money[1].replace(/,/g, "")));
    }
  }

  let stock = 1;
  const stockMatch = text.match(/(?:stock|qty|quantity|x)\s*[:=]?\s*(\d{1,5})|(\d{1,5})\s*(?:left|pcs|pieces|units)\b/i);
  if (stockMatch) {
    stock = parseInt(stockMatch[1] || stockMatch[2], 10) || 1;
  }

  if (price != null && price > 0) {
    let title = text
      .replace(/(?:₦|ngn|naira|n)?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*k?\b/gi, " ")
      .replace(/(?:stock|qty|quantity|x)\s*[:=]?\s*\d+/gi, " ")
      .replace(/\b\d+\s*(?:left|pcs|pieces|units)\b/gi, " ")
      .replace(/\b(?:for|price|cost|selling|at|only)\b/gi, " ")
      .replace(/[^\w\s\-/'&.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 2) title = "Product";

    return {
      intent: "ADD_PRODUCT",
      product: { title: title.slice(0, 120), price, stock },
    };
  }

  return { intent: "CHAT", reply: "I can add products to your shop drafts. Try: Big fridge for 5000 (stock 2)" };
}

function normalizeResult(parsed, storeName) {
  if (!parsed || typeof parsed !== "object") return null;

  const intent = String(parsed.intent || "").toUpperCase();

  if (intent === "ADD_PRODUCT" && parsed.product) {
    const p = parsed.product;
    const price = Number(p.price);
    if (!p.title || !Number.isFinite(price) || price < 0) return null;
    return {
      intent: "ADD_PRODUCT",
      product: {
        title: String(p.title).trim().slice(0, 120),
        price,
        stock: Number.isFinite(Number(p.stock)) ? Math.max(0, Math.floor(Number(p.stock))) : 1,
      },
    };
  }

  if (intent === "CHAT") {
    let reply = String(parsed.reply || "").trim();
    if (!reply) {
      reply = storeName ? `Hi! I'm your assistant for ${storeName}. Send a product like "Sneakers for 15000" to add a draft.` : "Hi! Send a product name and price to add it as a draft in your shop.";
    }
    return { intent: "CHAT", reply: reply.slice(0, 900) };
  }

  return null;
}

export async function processUserMessage(rawText, hasImage, storeContext) {
  const text = String(rawText || "").trim();
  const storeName = storeContext?.name || null;

  if (!text && hasImage) {
    return { intent: "CHAT", reply: "Got the photo. Reply with the name and price (e.g. Red sneakers for 12000) and I'll add it as a draft." };
  }

  if (!text) {
    return { intent: "CHAT", reply: "Send a product name and price, e.g. Big fridge for 5000" };
  }

  try {
    const groq = getClient();
    const completion = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: storeName ? `Store name: ${storeName}\nVendor message: ${text}` : `Vendor message: ${text}` },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    const normalized = normalizeResult(parsed, storeName);
    if (normalized) return normalized;
  } catch (err) {
    console.error("[groq] error:", err.message || err);
  }

  const fallback = regexFallback(text);
  if (fallback.intent === "CHAT" && storeName && !text.match(/\d/)) {
    fallback.reply = `Hi from ${storeName}! Send something like "Big fridge for 5000" and I'll save it as a draft.`;
  }
  return fallback;
}
