import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || "",
});

export async function processUserMessage(rawText, hasImage, storeContext) {
  try {
    const prompt = `You are an elite, highly intelligent AI business partner and co-pilot for "${storeContext.name}", a store on the BazarhNG e-commerce platform in Nigeria.
You are chatting directly with the store owner. Address them warmly or reference their store name context where appropriate.
You possess versatile knowledge across business strategy, pricing, marketing, inventory management, e-commerce tips, and general knowledge.

The owner sent this message on WhatsApp: "${rawText}"
${hasImage ? "[The owner also attached a product photo]" : ""}

Determine the owner's intent:
1. If they want to add/list a product (has product details/image), extract it as ADD_PRODUCT.
2. If they are asking a question about their store, business advice, general knowledge, greetings, or anything else, answer it as CHAT with a smart, helpful, professional, and friendly tone.

Return ONLY a valid JSON object with no markdown formatting:
{
  "intent": "ADD_PRODUCT" or "CHAT",
  "product": {
    "title": "extracted product name if ADD_PRODUCT",
    "price": number in Naira (e.g. 5000),
    "stock": number (default 1)
  },
  "reply": "Your intelligent, helpful response or product confirmation here."
}`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 800,
    });

    const content = completion.choices[0]?.message?.content || "";
    const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error("[groq] error:", err.message);
    
    if (hasImage || rawText.toLowerCase().includes("price") || rawText.match(/(?:₦|#)\s*[\d,]+/)) {
      const priceMatch = rawText.match(/(?:₦|price\s*:?\s*|#)\s*([\d,]+)/i);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 5000;
      const title = rawText.replace(/(?:₦|price\s*:?\s*|#)\s*[\d,]+/gi, "").trim() || "Product Draft";
      return {
        intent: "ADD_PRODUCT",
        product: { title, price, stock: 1 },
        reply: `✅ Added to shop drafts for ${storeContext.name}!`
      };
    }

    return {
      intent: "CHAT",
      reply: `Hello from ${storeContext.name}! I am your BazarhNG AI co-pilot. How can I assist you or your store today?`
    };
  }
}
