import { truncateResponse, truncateResult } from "@cloudflare/codemode";
import { AppError, ErrorCodes } from "../errors/codes";

const CHARS_PER_TOKEN = 4;
/** Room for truncateResponse's trailing marker on top of the char budget. */
const MARKER_ALLOWANCE = 300;

export const NO_VALUE_MESSAGE =
  "The script finished without returning a value (undefined). Return the data from the async function, e.g. `return result;`.";

/**
 * Turn a script or mutation result into the final tool text: structural
 * truncation first (keeps JSON valid), then ONE compact serialization, then a
 * hard character cap on the exact string sent to the client.
 */
export function formatResult(value: unknown, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (value === undefined) return NO_VALUE_MESSAGE;
  if (typeof value === "string") return hardCap(value, maxTokens, maxChars);
  let text: string | undefined;
  try {
    text = JSON.stringify(truncateResult(value, { maxTokens }));
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      `Result is not JSON-serializable (${reason}); return plain objects, arrays, strings, numbers or booleans`,
    );
  }
  if (text === undefined) return NO_VALUE_MESSAGE;
  return hardCap(text, maxTokens, maxChars);
}

function hardCap(text: string, maxTokens: number, maxChars: number): string {
  const capped = truncateResponse(text, { maxTokens });
  // truncateResponse appends a short marker; never let anything beyond that through.
  return capped.length > maxChars + MARKER_ALLOWANCE
    ? capped.slice(0, maxChars + MARKER_ALLOWANCE)
    : capped;
}
