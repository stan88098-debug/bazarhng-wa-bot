import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function processUserMessage(incomingText, hasImage, storeContext = null) {
  let storeInfoPrompt = "Store Identity: Unlinked vendor. (Prompt vendor to connect their shop on BazarhNG if they ask about their store name).";
  
  if (storeContext && storeContext.store) {
    const { store, products } = storeContext;
    const productList = products.length > 0
      ? products.map(p => `- ${p.title}: ₦${Number(p.price).toLocaleString()} (Stock: ${p.stock}, ${p.is_published ? 'Live' : 'Draft'})`).join("\n")
      : "No products currently listed.";

    storeInfoPrompt = `
STORE CONTEXT (LIVE DATABASE DATA):
- Store Name: ${store.name}
- Store Web Address: bazarhng.netlify.app/store/${store.slug}
- Registered Phone: ${store.phone}
- Current Catalog (${products.length} items):
${productList}
`;
  }

  const systemPrompt = `
You are the official AI Store Assistant for BazarhNG micro-vendors in Nigeria on WhatsApp.
You speak warm, clear, professional English with a natural tone suitable for Nigerian business owners.

${storeInfoPrompt}

INTENT RECOGNITION RULES:
1. "ADD_PRODUCT": Triggered when the user uploads a photo/text listing an item with a price.
   - Price parsing rules: 
     * Convert "15k" or "15K" -> 15000
     * Convert "3.5m" or "3.5M" -> 3500000
     * Strip out currency signs (e.g., "₦5000" -> 5000, "5,000" -> 5000).
   - Extract title, numeric price, optional description, and stock (default: 1).

2. "CHAT": Triggered for greetings, questions about their store, inventory checks, price lookups, or how to use the bot.
   - Use the STORE CONTEXT to answer questions accurately (e.g. if asked "What's my store name?", answer with their actual store name).
   - If asked how to add items, explain: "Send a product picture with the title and price in the caption!"

RETURN ONLY VALID JSON. No extra preamble or markdown backticks outside JSON.
JSON SCHEMA:
{
  "intent": "ADD_PRODUCT" | "CHAT",
  "product": {
    "title": "string or null",
    "price": number or null,
    "description": "string or null",
    "stock": 1
  },
  "reply": "string"
}
`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: incomingText || (hasImage ? "Uploaded item photo with caption" : "Hello") },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return parsed;
  } catch (err) {
    console.error("Groq Brain Error:", err);
    return {
      intent: "CHAT",
      reply: "I couldn't quite catch that. Try sending your product photo with the item name and price in the caption!",
    };
  }
}
