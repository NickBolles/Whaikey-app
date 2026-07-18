/**
 * Defensive JSON parsing for model output. Models occasionally wrap JSON in
 * markdown fences or add prose around it — strip fences, then fall back to
 * grabbing the outermost JSON object/array in the text.
 */
export function parseModelJson(text: string): unknown | null {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const attempts = [stripped];

  // Fall back to the outermost {...} or [...] span in the raw text.
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) attempts.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) attempts.push(text.slice(arrStart, arrEnd + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Concatenate all text blocks from an Anthropic message response. */
export function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
