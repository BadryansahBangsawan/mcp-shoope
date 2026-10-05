export const MODERN_VERSION = "2026-07-28";

export interface WireOptions {
  id?: number;
  /** Protocol version claimed in both the header and the _meta envelope. */
  version?: string;
  /** Omit the _meta envelope and MCP-Protocol-Version header (legacy-shaped request). */
  bare?: boolean;
  headers?: Record<string, string>;
}

export interface WireResponse {
  status: number;
  contentType: string | null;
  body: JsonRpcBody;
}

export interface JsonRpcBody {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown> & { [key: string]: unknown };
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

const NAME_SOURCE: Record<string, string> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

/** A JSON-RPC message body carrying the full 2026-07-28 per-request _meta envelope. */
export function rpcMessage(method: string, params: Record<string, unknown> = {}, options: WireOptions = {}) {
  const version = options.version ?? MODERN_VERSION;
  const meta = {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "vitest-wire", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  return {
    jsonrpc: "2.0",
    id: options.id ?? 1,
    method,
    params: options.bare ? params : { ...params, _meta: meta },
  };
}

/** Build a Streamable HTTP POST /mcp request with the standard MCP headers. */
export function rpcRequest(method: string, params: Record<string, unknown> = {}, options: WireOptions = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    // Node's Request does not derive Host from the URL; the handler validates it.
    host: "localhost",
    ...options.headers,
  };
  if (!options.bare) {
    headers["mcp-protocol-version"] = options.version ?? MODERN_VERSION;
    headers["mcp-method"] = method;
    const source = NAME_SOURCE[method];
    const name = source ? params[source] : undefined;
    if (typeof name === "string") headers["mcp-name"] = name;
  }
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(rpcMessage(method, params, options)),
  });
}

/** Parse a JSON or single-event SSE response body. */
export async function readWire(response: Response): Promise<WireResponse> {
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  let json = text;
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    json = data[data.length - 1] ?? "{}";
  }
  return { status: response.status, contentType, body: (json ? JSON.parse(json) : {}) as JsonRpcBody };
}
