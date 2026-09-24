/**
 * Cloud chat via the Anthropic Messages API (Claude Haiku or equivalent).
 *
 * On-device models (Gemma and similar) are not a code path. When
 * ANTHROPIC_API_KEY is unset, callers keep the deterministic mock reply.
 * The request body is built only from injectChatContext / buildSystemPrompt.
 */

import { buildChatReply } from "./chat.js";
import { buildSystemPrompt } from "./persona.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export function resolveLlmConfig(env = process.env) {
  const apiKey = String(env.ANTHROPIC_API_KEY ?? "").trim();
  const model = String(env.ANTHROPIC_MODEL ?? "").trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? "").trim();
  return {
    enabled: apiKey.length > 0,
    apiKey,
    model: model || DEFAULT_ANTHROPIC_MODEL,
    baseUrl: (baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, ""),
    maxTokens: 320,
  };
}

export function toAnthropicMessages(turns) {
  const messages = [];
  for (const turn of turns ?? []) {
    const content = String(turn?.content ?? "").trim();
    if (!content) continue;
    const role = turn.role === "assistant" ? "assistant" : "user";
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n${content}`;
    } else {
      messages.push({ role, content });
    }
  }
  while (messages[0]?.role === "assistant") messages.shift();
  return messages;
}

export async function completeWithCloud({ config, system, turns, fetchImpl }) {
  const messages = toAnthropicMessages(turns);
  if (!messages.length) {
    throw new Error("cloud chat needs at least one user turn");
  }
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const res = await fetchFn(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      messages,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`anthropic messages failed: ${res.status}`);
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return { text, model: data.model ?? config.model };
}

/**
 * Cloud when configured; otherwise the existing deterministic mock.
 * Cloud failures fall back to the mock so a bad key does not 500 the stub.
 */
export async function resolveChatReply({ message, tip, context, llm, fetchImpl }) {
  if (!llm?.enabled) {
    return { text: buildChatReply(message, tip), provider: "mock" };
  }
  try {
    const system = buildSystemPrompt(context);
    const cloud = await completeWithCloud({
      config: llm,
      system,
      turns: context.turns,
      fetchImpl,
    });
    if (!cloud.text) {
      return { text: buildChatReply(message, tip), provider: "mock" };
    }
    return { text: cloud.text, provider: "cloud", model: cloud.model };
  } catch (err) {
    return {
      text: buildChatReply(message, tip),
      provider: "mock",
      error: err?.message ?? "cloud failed",
    };
  }
}
