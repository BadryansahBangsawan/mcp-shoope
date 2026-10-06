import { describe, expect, it } from "vitest";
import { SCOPES, parseScopeList, scopesForAccessToken } from "../../src/auth/scopes";

describe("parseScopeList", () => {
  it("accepts arrays or space/plus-delimited strings and drops unknown names", () => {
    expect(parseScopeList([SCOPES.READ, "nope", SCOPES.ADMIN])).toEqual([SCOPES.READ, SCOPES.ADMIN]);
    expect(parseScopeList("shopee:read+shopee:write extra")).toEqual([SCOPES.READ, SCOPES.WRITE]);
    expect(parseScopeList(undefined)).toEqual([]);
  });
});

describe("scopesForAccessToken", () => {
  it("keeps the grant when the token request omits scope", () => {
    expect(scopesForAccessToken([SCOPES.READ], undefined)).toEqual([SCOPES.READ]);
    expect(scopesForAccessToken([SCOPES.READ], "")).toEqual([SCOPES.READ]);
  });

  it("does not replace a grant array with a raw requestedScope string", () => {
    expect(scopesForAccessToken([SCOPES.READ], SCOPES.READ)).toEqual([SCOPES.READ]);
  });

  it("intersects known scopes and never mints an empty known-scope list", () => {
    expect(scopesForAccessToken([SCOPES.READ, SCOPES.WRITE], SCOPES.READ)).toEqual([SCOPES.READ]);
    expect(scopesForAccessToken([SCOPES.READ], SCOPES.WRITE)).toEqual([SCOPES.READ]);
    expect(scopesForAccessToken([SCOPES.READ], "unknown")).toEqual([SCOPES.READ]);
  });
});
