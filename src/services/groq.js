import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function processUserMessage(text, hasImage, storeContext) {
  try {
    const prompt = `You are an AI assistant for BazarhNG, a multi-vendor marketplace in Nigeria. 
A vendor sent a message: "${text}" (Has image: ${hasImage}).
Store Name: ${storeContext?.store?.name || 'Unknown'}

Analyze the message. If the user is trying to add a product, list an item, or providing an item name and price, respond in strict JSON format:
{
  "intent": "ADD_PRODUCT",
  "product": {
    "title": "extracted product name",
    "price": extracted_number_only,
    "stock": 1
  },
  "reply": null
}

If it's just a greeting or general question, respond in strict JSON format:
{
  "intent": "CHAT",
  "product": null,
  "reply": "Your helpful response here"
}

Return ONLY valid JSON. No markdown codeblocks, just raw JSON.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const content = completion.choices[0]?.message?.content?.trim() || "";
    const jsonStr = content.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.intent) return parsed;
    throw new Error("Invalid JSON structure");
  } catch (err) {
    console.error("Groq parsing error or fallback triggered:", err.message);
    
    // Bulletproof regex fallback for captions like "Big fridge for 5000" or "Sneakers 25000"
    const matchPrice = text.match(/(?:for|at|₦|price[:\s]*)?\s*([0-9][0-9,\s]*)/i);
    if (matchPrice && text.length > 3) {
      const priceVal = parseInt(matchPrice[1].replace(/[\s,]/g, ""), 10);
      if (priceVal > 0) {
        let titleVal = text.replace(matchPrice[0], "").replace(/for|at|price|₦/gi, "").trim();
        if (!titleVal || titleVal.length < 2) titleVal = "Store Product";
        return {
          intent: "ADD_PRODUCT",
          product: {
            title: titleVal,
            price: priceVal,
            stock: 1
          },
          reply: null
        };
      }
    }

    return {
      intent: "CHAT",
      product: null,
      reply: "Hello! 👋 Welcome to our store. Send a product picture with the title and price in the caption to add items to your shop!"
    };
  }
}
