import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function processUserMessage(incomingText, hasImage, storeContext = null) {
  let storeInfoPrompt = "The vendor's store details are currently unlinked or not found in the database.";
  
  if (storeContext && storeContext.store) {
    const { store, products } = storeContext;
    const productList = products.map(p => `- ${p.title}: ₦${p.price} (Stock: ${p.stock})`).join("\n");
    
    storeInfoPrompt = `
You are the personal AI assistant for the store "${store.name}".
STORE DETAILS:
- Store Name: ${store.name}
- Store Slug: ${store.slug}
- Current Products in Database (${products.length}):
${productList || "No products currently listed."}
`;
  }

  const systemPrompt = `
You are the official AI store assistant for BazarhNG vendors on WhatsApp.
${storeInfoPrompt}

YOUR TASKS:
1. If the user message or image caption is listing a product/item with a price (e.g., "Lg tv \\n 3000", "Big fridge for 5000"):
   - Set "intent": "ADD_PRODUCT".
   - Extract title, price (as a pure number), description (if any), and stock (default to 1).

2. If the user asks questions about their store, inventory, store name, or general greetings:
   - Set "intent": "CHAT".
   - Use the STORE DETAILS provided above to give exact, accurate answers about their store name and catalog.

Return ONLY a valid JSON object strictly matching this schema:
{
  "intent": "ADD_PRODUCT" | "CHAT",
  "product": {
    "title": "string or null",
    "price": "number or null",
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
        { role: "user", content: incomingText || (hasImage ? "Uploaded item photo" : "Hello") },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return parsed;
  } catch (err) {
    console.error("Groq Processing Error:", err);
    return {
      intent: "CHAT",
      reply: "I couldn't quite process that. Send your product image with the name and price in the caption!",
    };
  }
}
