import { AppError, ErrorCodes } from "../errors/codes";

const PATH_PARAM = /\{([a-zA-Z0-9_]+)\}/g;
/**
 * Whitelist for substituted segments. Excludes '.', '%', '/', '\\', '?', '#'
 * and anything else the URL parser could normalise into a different path.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Substitute path params. Each value must be a plain id-like segment so the
 * resolved URL path can never differ from the registered template shape.
 */
export function buildPath(
  template: string,
  pathParams: Record<string, string | number>,
): string {
  const path = template.replace(PATH_PARAM, (_m, name: string) => {
    const raw = pathParams[name];
    if (raw === undefined || raw === null || raw === "") {
      throw new AppError(
        ErrorCodes.INVALID_INPUT,
        `Missing path param: ${name}`,
      );
    }
    const value = String(raw);
    assertSafePathSegment(value, name);
    return value;
  });
  if (!path.startsWith("/")) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Path must start with /");
  }
  return path;
}

function assertSafePathSegment(value: string, name: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      `Unsafe path param ${name}`,
    );
  }
}

/**
 * Resolve `path` on `host` and prove the URL parser did not rewrite it
 * (dot segments, backslashes, encoded separators).
 */
export function resolveUrl(host: string, path: string): URL {
  const url = new URL(`https://${host}${path}`);
  if (url.pathname !== path || url.host !== host) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      "Path params changed the registered request path",
    );
  }
  return url;
}

export function applyQuery(
  url: URL,
  query: Record<string, string | number | boolean | undefined> | undefined,
): void {
  if (!query) return;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
}
