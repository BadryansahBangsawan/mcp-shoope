import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { approvalsStubFor, MutationApprovalsDO } from "./approvals/mutation-approvals";
import { handleApprovalRoutes } from "./approvals/routes";
import { handleAuthorize, handleLogin, handleLogout } from "./auth/owner-routes";
import { SCOPES, scopesForAccessToken } from "./auth/scopes";
import { principalFromProps, resolveDevPsk } from "./auth/verify";
import { createSessionProvider, handleConnectRoutes } from "./connect/routes";
import { BUNDLED_DOCS } from "./docs/bundled";
import { AppError } from "./errors/codes";
import { createShopeeServer, type ServerDeps } from "./mcp/server";
import { log } from "./observability/log";
import { ShopeeSessionsDO } from "./session/shopee-sessions-do";

export { ShopeeSessionsDO, MutationApprovalsDO };

const PROTOCOL_VERSION = "2026-07-28";

function publicBaseUrl(env: Env): URL {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) throw new AppError("UNAUTHORIZED", "PUBLIC_BASE_URL is not configured", { status: 503 });
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new AppError("UNAUTHORIZED", "PUBLIC_BASE_URL must be https", { status: 503 });
  }
  return url;
}

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let principal;
    try {
      principal = principalFromProps((ctx as ExecutionContext & { props?: unknown }).props);
    } catch (err) {
      const status = err instanceof AppError ? err.status : 401;
      return Response.json({ code: "UNAUTHORIZED", message: "Invalid token properties" }, { status });
    }
    const sessions = createSessionProvider(env);
    const approvals: ServerDeps["approvals"] = approvalsStubFor(env.MUTATION_APPROVALS, principal.subject);
    const handler = createMcpHandler(
      () =>
        createShopeeServer({
          env,
          sessions,
          principal,
          readDoc: async (name) => BUNDLED_DOCS[name] ?? null,
          approvals,
        }),
      {
        route: "/mcp",
        legacy: env.MCP_LEGACY_MODE === "stateless" ? "stateless" : "reject",
        allowedHostnames: [publicBaseUrl(env).hostname, "localhost", "127.0.0.1"],
        onerror: (error) => log("warn", "mcp.handler.error", { err: error.message }),
      },
    );
    const authInfo: AuthInfo = {
      token: "redacted",
      clientId: principal.clientId ?? principal.subject,
      scopes: principal.scopes,
      extra: { subject: principal.subject, via: principal.via },
    };
    return handler.fetch(request, { authInfo });
  },
} satisfies ExportedHandler<Env>;

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        name: env.MCP_SERVER_NAME,
        version: env.MCP_SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        mutations: env.ENABLE_MUTATIONS === "true",
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        name: env.MCP_SERVER_NAME,
        mcp: `${url.origin}/mcp`,
        authorization: "OAuth 2.1 (see /.well-known/oauth-protected-resource/mcp)",
      });
    }
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/login") return handleLogin(request, env);
    if (url.pathname === "/logout") return handleLogout(request);
    const approval = await handleApprovalRoutes(request, env);
    if (approval) return approval;
    const connect = await handleConnectRoutes(request, env);
    if (connect) return connect;
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function registrationRejection(meta: Record<string, unknown>) {
  const uris = meta.redirect_uris;
  const ok =
    Array.isArray(uris) &&
    uris.length > 0 &&
    uris.length <= 5 &&
    uris.every((u) => typeof u === "string" && u.length <= 512) &&
    String(meta.client_name ?? "").length <= 100 &&
    JSON.stringify(meta).length <= 8_192;
  return ok ? undefined : { code: "invalid_client_metadata", description: "Client metadata exceeds server limits" };
}

let cached: { base: string; provider: OAuthProvider<Env> } | undefined;

function providerFor(env: Env): OAuthProvider<Env> {
  const base = publicBaseUrl(env).origin;
  if (cached?.base === base) return cached.provider;
  const resource = `${base}/mcp`;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: appHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPES.READ, SCOPES.WRITE, SCOPES.ADMIN],
    accessTokenTTL: 3600,
    refreshTokenTTL: 180 * 86_400,
    clientRegistrationTTL: 365 * 86_400,
    clientRegistrationCallback: ({ clientMetadata }) => registrationRejection(clientMetadata),
    resourceMetadata: {
      resource,
      ...(base.startsWith("https://") ? { authorization_servers: [base] } : {}),
      scopes_supported: [SCOPES.READ],
      bearer_methods_supported: ["header"],
      resource_name: "Shopee MCP",
    },
    tokenExchangeCallback: ({ props, requestedScope }) => {
      const p = (props ?? {}) as Record<string, unknown>;
      return {
        accessTokenProps: { ...p, scopes: scopesForAccessToken(p.scopes, requestedScope) },
      };
    },
    resolveExternalToken: async ({ token, request, env: e }) => {
      const props = await resolveDevPsk(token, request, e);
      return props ? { props, audience: resource } : null;
    },
    onError: ({ code, status, internal }) => {
      log(status >= 500 ? "error" : "warn", "oauth.error", { code, status, reason: internal?.reason });
    },
  });
  cached = { base, provider };
  return provider;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    try {
      return await providerFor(env).fetch(request, env, ctx);
    } catch (err) {
      log("error", "worker.unhandled", { err: err instanceof Error ? err.message : String(err) });
      const status = err instanceof AppError ? err.status : 500;
      return Response.json({ code: "INTERNAL", message: "Internal error" }, { status });
    }
  },
} satisfies ExportedHandler<Env>;
