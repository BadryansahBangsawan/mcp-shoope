/*
 * Env bindings for shopee-mcp. Kept in sync with wrangler.jsonc by hand
 * (`wrangler types` would also regenerate runtime types that conflict with
 * @cloudflare/workers-types). Secrets are optional so the Worker fails closed.
 */
interface Env {
  // Bindings
  LOADER: WorkerLoader;
  OAUTH_KV: KVNamespace;
  MUTATION_APPROVALS: DurableObjectNamespace;
  SHOPEE_SESSIONS: DurableObjectNamespace;
  /** Injected by @cloudflare/workers-oauth-provider before handlers run. */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;

  // Vars
  PUBLIC_BASE_URL: string;
  ENABLE_MUTATIONS: string;
  /** "false" (v1 default) omits MCP App widget tools and ui:// views. */
  ENABLE_WIDGETS: string;
  ALLOW_DEV_PSK: string;
  REQUIRE_SESSION_ENCRYPTION: string;
  /** "reject" (default, 2026-07-28 only) or "stateless" (also serve 2025-era clients). */
  MCP_LEGACY_MODE: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  SHOPEE_REGION: string;

  // Secrets
  /** Owner password for /authorize, /login, /connect (>= 16 chars). */
  OWNER_PASSWORD?: string;
  /** Base64 32-byte AES-GCM key; also the HKDF root for owner cookies. */
  SESSION_ENCRYPTION_KEY?: string;
  /** Local development only; honoured on loopback hosts when ALLOW_DEV_PSK=true. */
  DEV_PSK?: string;
}
