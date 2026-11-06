import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export interface ParsedMessageResult {
  intent: "ADD_PRODUCT" | "CHAT";
  product?: {
    title: string | null;
    price: number | null;
    description: string | null;
    stock: number;
  };
  reply?: string;
}

export async function processUserMessage(
  incomingText: string,
  hasImage: boolean
): Promise<ParsedMessageResult> {
  const systemPrompt = `
You are the official AI store assistant for BazarhNG vendors on WhatsApp.

YOUR TASKS:
1. If the message or image caption is listing a product/item with a price (e.g., "Lg tv \\n 3000", "Big fridge for 5000", "Red shoes 15k"):
   - Set "intent": "ADD_PRODUCT".
   - Extract title, price (as a pure number), description (if any), and stock (default to 1).
   - Clean up short slang prices (e.g. 15k -> 15000).

2. If the user is asking general questions, greeting you, or checking status (e.g. "Hi", "How many sales today?", "Help"):
   - Set "intent": "CHAT".
   - Provide a helpful, warm, concise response appropriate for a Nigerian market business setting.

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
      model: "llama-3.3-70b-versatile",
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
