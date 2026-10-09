/**
 * Owner-gated POST /connect/paste. Never logs cookie values or OWNER_PASSWORD.
 */
import { loadDevVars, workerBase, type PasteBundle } from "./runtime";

class OwnerJar {
  #cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/i.test(c) || !value) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export type PasteResult = { connected?: boolean; cookieCount?: number; source?: string };

export type OrdersImportResult = {
  imported?: boolean;
  listCount?: number;
  detailCount?: number;
  pulledAt?: number;
};

async function ownerConnectSession(base: string): Promise<{ jar: OwnerJar; csrf: string }> {
  const vars = loadDevVars();
  const password = vars.OWNER_PASSWORD;
  if (!password) throw new Error("OWNER_PASSWORD missing in .dev.vars");
  const jar = new OwnerJar();

  const health = await fetch(`${base}/healthz`);
  if (!health.ok) throw new Error(`Worker not up at ${base}`);

  const loginPage = await fetch(`${base}/login?next=/connect`, { redirect: "manual" });
  jar.absorb(loginPage);
  const loginCsrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await loginPage.text())?.[1];
  if (!loginCsrf) throw new Error("owner /login has no CSRF");
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ csrf: loginCsrf, next: "/connect", password }),
  });
  jar.absorb(login);
  if (login.status !== 302) throw new Error(`owner login failed (${login.status})`);

  const connectPage = await fetch(`${base}/connect`, { headers: { cookie: jar.header() } });
  jar.absorb(connectPage);
  const connectCsrf = /name="csrf" value="([a-f0-9]{32})"/.exec(await connectPage.text())?.[1];
  if (!connectCsrf) throw new Error("GET /connect has no CSRF");
  return { jar, csrf: connectCsrf };
}

export async function pasteToWorker(bundle: PasteBundle, base = workerBase()): Promise<PasteResult> {
  const { jar, csrf } = await ownerConnectSession(base);
  const paste = await fetch(`${base}/connect/paste`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: jar.header(),
    },
    body: JSON.stringify({ csrf, bundle }),
  });
  const body = (await paste.json()) as Record<string, unknown>;
  if (!paste.ok || body.connected !== true) {
    throw new Error(`paste failed ${paste.status}: ${JSON.stringify({ code: body.code, message: body.message })}`);
  }
  return body as PasteResult;
}

export async function importOrdersToWorker(
  bundle: { v: 1; source: "browser-export"; pulledAt: number; list: unknown[]; details: Record<string, unknown> },
  base = workerBase(),
): Promise<OrdersImportResult> {
  const { jar, csrf } = await ownerConnectSession(base);
  const res = await fetch(`${base}/connect/orders-import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: jar.header(),
    },
    body: JSON.stringify({ csrf, bundle }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || body.imported !== true) {
    throw new Error(
      `orders-import failed ${res.status}: ${JSON.stringify({ code: body.code, message: body.message })}`,
    );
  }
  return body as OrdersImportResult;
}
