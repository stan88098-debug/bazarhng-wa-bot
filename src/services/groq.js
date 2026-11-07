export async function processUserMessage(rawText, hasImage, storeContext, storeStats) {
  try {
    const apiKey = String(process.env.GROQ_API_KEY || "").trim();
    const prompt = `You are an elite, all-in-one AI business partner and co-pilot for "${storeContext.name}", store ID ${storeContext.id}, on BazarhNG.
Here is the LIVE database inventory data for this store right now:
- Total Products in Database: ${storeStats.totalProducts}
- Draft Items: ${storeStats.draftsCount}
- Active Live Items: ${storeStats.activeCount}
- Recent Items: ${JSON.stringify(storeStats.recentItems)}

The store owner sent this message on WhatsApp: "${rawText}"
${hasImage ? "[The owner also attached a product photo]" : ""}

Instructions:
1. If they want to add/list a product (has product details/image), extract it as ADD_PRODUCT.
2. If they ask about how many products they have, inventory counts, or store stats, YOU MUST use the exact numbers provided above in your reply. Do NOT tell them to log into the dashboard to check counts—you already have the live data right here!
3. For any other questions, chat, or advice, reply as CHAT with a smart, helpful, and friendly tone.

Return ONLY a valid JSON object with no markdown formatting:
{
  "intent": "ADD_PRODUCT" or "CHAT",
  "product": {
    "title": "extracted product name if ADD_PRODUCT",
    "price": number in Naira (e.g. 5000),
    "stock": number (default 1)
  },
  "reply": "Your intelligent response using the exact live database numbers or product confirmation here."
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
        temperature: 0.5,
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
        reply: `✅ Added to shop drafts for ${storeContext.name}!\n\n🔗 View Store: https://bazarhng.netlify.app`
      };
    }

    return {
      intent: "CHAT",
      reply: `Hello ${storeContext.name}! You currently have ${storeStats.totalProducts} total products (${storeStats.draftsCount} drafts) in your store. How can I help you manage your inventory or grow your business today?`
    };
  }
}
