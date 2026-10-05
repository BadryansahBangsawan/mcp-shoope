import type { AuthProfile, CoverageEntry, HostKey, SafetyClass } from "./types";

type Method = CoverageEntry["method"];

interface NonOpEntry {
  doc: string;
  method: Method;
  host: HostKey;
  path: string;
  auth: AuthProfile;
  safety: SafetyClass;
  reason: string;
}

function excluded(e: NonOpEntry): CoverageEntry {
  return {
    sourceDocument: e.doc,
    method: e.method,
    host: e.host,
    path: e.path,
    operationId: null,
    auth: e.auth,
    safety: e.safety,
    implModule: null,
    testFile: null,
    status: "excluded",
    exclusionReason: e.reason,
  };
}

function sessionOnly(e: NonOpEntry & { implModule: string; testFile: string }): CoverageEntry {
  return {
    ...excluded(e),
    implModule: e.implModule,
    testFile: e.testFile,
    status: "session-only",
  };
}

const LOGIN_IMPL = "src/connect/login-flow.ts";
const CONNECT_TEST = "tests/unit/connect.test.ts";

const LOGIN_REASON = "Buyer login hop used by /connect; model never calls this.";

/** Login/OTP hops used by /connect, never as Code Mode operations. */
export const SESSION_ONLY: CoverageEntry[] = [
  sessionOnly({
    doc: "auth-login.md",
    method: "GET",
    host: "www",
    path: "/buyer/login",
    auth: "cookie-csrf",
    safety: "read",
    implModule: LOGIN_IMPL,
    testFile: CONNECT_TEST,
    reason: LOGIN_REASON,
  }),
  sessionOnly({
    doc: "auth-login.md",
    method: "POST",
    host: "www",
    path: "/api/v2/authentication/login",
    auth: "cookie-csrf",
    safety: "read",
    implModule: LOGIN_IMPL,
    testFile: CONNECT_TEST,
    reason: LOGIN_REASON,
  }),
  sessionOnly({
    doc: "auth-login.md",
    method: "POST",
    host: "www",
    path: "/api/v2/authentication/resend_otp",
    auth: "cookie-csrf",
    safety: "read",
    implModule: LOGIN_IMPL,
    testFile: CONNECT_TEST,
    reason: LOGIN_REASON,
  }),
  sessionOnly({
    doc: "auth-login.md",
    method: "POST",
    host: "www",
    path: "/api/v2/authentication/vcode_login",
    auth: "cookie-csrf",
    safety: "read",
    implModule: LOGIN_IMPL,
    testFile: CONNECT_TEST,
    reason: LOGIN_REASON,
  }),
];

/**
 * Captured writes and out-of-product hops. Checkout/pay/chat-send/follow/
 * marketplace/Open Platform stay prose-only until a METHOD URL is captured.
 */
export const EXCLUSIONS: CoverageEntry[] = [
  excluded({
    doc: "exclusions.md",
    method: "POST",
    host: "www",
    path: "/api/v4/cart/update",
    auth: "cookie-csrf",
    safety: "write",
    reason: "Cart write (quantity/select/checkout prep). Not a Code Mode operation.",
  }),
];
