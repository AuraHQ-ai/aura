import { gateway } from "@ai-sdk/gateway";
import { getFastModel, withAnthropicFallback } from "../../src/lib/ai.js";

export async function getBenchLanguageModel(modelId?: string) {
  if (!modelId) return getFastModel();
  return withAnthropicFallback(gateway(modelId), modelId);
}
