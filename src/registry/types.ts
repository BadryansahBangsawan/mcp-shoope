export type EvidenceLevel =
  | "observed"
  | "documented-not-executed"
  | "inferred"
  | "empty-response"
  | "failed-probe"
  | "unknown";

export type AuthProfile = "bearer" | "raw-token" | "cookie-csrf" | "www-csrf" | "none";

export type ResponseKind = "json" | "html";

export type SafetyClass = "read" | "write" | "destructive";

export type HostKey = "www";

export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  description?: string;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaLike;
  /** Wire location for mixed POST query+body ops. Omitted = path (template) or body. */
  "x-in"?: "query";
  [key: string]: unknown;
}

export interface ApiOperation {
  operationId: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  host: HostKey;
  pathTemplate: string;
  sourceDocument: string;
  evidence: EvidenceLevel;
  authProfile: AuthProfile;
  responseKind: ResponseKind;
  safety: SafetyClass;
  tags: string[];
  inputSchema: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
  /** When false, not exposed via connector (session/auth helpers or excluded). */
  exposed: boolean;
}

export type CoverageStatus =
  | "implemented"
  | "html-adapter"
  | "mutation-gated"
  | "session-only"
  | "excluded";

export interface CoverageEntry {
  sourceDocument: string;
  method: string;
  /** Upstream host key; method+host+path is the manifest key. */
  host: HostKey;
  path: string;
  operationId: string | null;
  auth: AuthProfile | "n/a";
  safety: SafetyClass | "n/a";
  implModule: string | null;
  testFile: string | null;
  status: CoverageStatus;
  exclusionReason?: string;
}
