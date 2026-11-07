export async function processUserMessage(rawText, hasImage, storeContext) {
  try {
    const apiKey = String(process.env.GROQ_API_KEY || "").trim();
    const prompt = `You are an elite, highly intelligent AI business partner and co-pilot for "${storeContext.name}", a store on the BazarhNG e-commerce platform in Nigeria.
Address the store owner warmly or reference their store name. You possess versatile knowledge across business strategy, pricing, marketing, inventory management, e-commerce tips, and general knowledge.

The store owner sent this message on WhatsApp: "${rawText}"
${hasImage ? "[The owner also attached a product photo]" : ""}

Determine the owner's intent:
1. If they want to add/list a product (has product details/image), extract it as ADD_PRODUCT.
2. If they are asking a question about their store, business advice, general knowledge, greetings, or chatting, answer it as CHAT with a smart, helpful, professional, and friendly tone.

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

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq HTTP error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const cleanJson = content.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error("[groq fetch error]:", err.message);
    
    const textLower = rawText.toLowerCase();
    if (hasImage || textLower.includes("price") || textLower.match(/(?:₦|#)\s*[\d,]+/)) {
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
      reply: `Hello ${storeContext.name} owner! I'm your BazarhNG AI co-pilot. I am ready to help you manage your store, set prices, and answer any questions. What would you like to do today?`
    };
  }
}
