const crypto = require("crypto");
const { estimateTokens } = require("./utils");

function mapOpenAIToAnthropic(body, modelId) {
  const messages = [];
  let system = "";
  for (const message of body.messages || []) {
    if (message.role === "system") {
      system += `${message.content}\n`;
    } else {
      messages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      });
    }
  }
  return {
    model: modelId,
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    system: system.trim() || undefined,
    messages
  };
}

function mapAnthropicToOpenAI(body, alias, modelId) {
  const text = (body.content || []).map(part => part.text || "").join("");
  return {
    id: body.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: body.stop_reason || "stop" }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: estimateTokens(body),
      source_model: modelId
    }
  };
}

function mapOpenAIToGemini(body) {
  const contents = [];
  const systemParts = [];
  for (const message of body.messages || []) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (message.role === "system") {
      systemParts.push({ text });
    } else {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text }] });
    }
  }
  return {
    contents,
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    generationConfig: {
      temperature: body.temperature,
      topP: body.top_p,
      topK: body.top_k,
      frequencyPenalty: body.frequency_penalty,
      presencePenalty: body.presence_penalty,
      maxOutputTokens: body.max_tokens || body.max_completion_tokens
    }
  };
}

function mapGeminiToOpenAI(body, alias, modelId) {
  const candidate = body.candidates?.[0] || {};
  const text = (candidate.content?.parts || []).map(part => part.text || "").join("");
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: candidate.finishReason || "stop" }],
    usage: {
      prompt_tokens: body.usageMetadata?.promptTokenCount || 0,
      completion_tokens: body.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: estimateTokens(body),
      source_model: modelId
    }
  };
}

module.exports = {
  mapOpenAIToAnthropic,
  mapAnthropicToOpenAI,
  mapOpenAIToGemini,
  mapGeminiToOpenAI
};
