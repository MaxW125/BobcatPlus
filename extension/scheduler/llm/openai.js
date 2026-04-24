// scheduler/llm/openai.js — shared OpenAI call wrapper
// Extracted from scheduleGenerator.js section 5. No dependencies.

export async function openaiChat({ apiKey, model, temperature, messages, responseFormat, stream = false }) {
  const body = { model, temperature, messages };
  if (responseFormat) body.response_format = responseFormat;
  if (stream) body.stream = true;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (stream) return res;

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "OpenAI API error");
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  return {
    content,
    tokensIn: data.usage?.prompt_tokens ?? null,
    tokensOut: data.usage?.completion_tokens ?? null,
  };
}

export async function openaiJson({ apiKey, model, temperature, messages, retries = 1 }) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await openaiChat({
        apiKey, model, temperature, messages,
        responseFormat: { type: "json_object" },
      });
      return { json: JSON.parse(r.content), tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        messages = [
          ...messages,
          { role: "system", content: "Return ONLY valid JSON. No prose, no markdown." },
        ];
      }
    }
  }
  throw lastErr;
}
