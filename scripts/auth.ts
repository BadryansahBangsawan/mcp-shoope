/**
 * Headed Shopee buyer login on this machine. Saves a paste bundle under
 * `.runtime/auth/` (gitignored) and POSTs it to the Worker /connect/paste.
 * Does not copy cookie values to stdout. Cloudflare Worker cannot run Chrome.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { chromium, type BrowserContext, type Cookie, type Page } from "playwright";

import { pasteToWorker } from "./paste-to-worker";
import {
  LOGIN_FALLBACK_URL,
  LOGIN_URL,
  acquireLock,
  chromiumExecutable,
  cookieNamesLine,
  ensureRuntimeDirs,
  hasSessionCookie,
  releaseLock,
  toPasteBundle,
  workerBase,
  writeAtomic,
  type BrowserCookie,
  type PasteBundle,
} from "./runtime";

const LOGIN_PROMPT = `Chrome for Testing opened the official Shopee QR page.
Scan it in the Shopee app (Scan QR/Barcode → Konfirmasi Log in).
Do not type a Shopee account in this terminal. Do not paste cookies.
The script sends the session to the Worker once SPC_EC or SPC_ST appears.
Or press Enter here after the homepage is visible (or touch .runtime/auth/operator-done).
Timeout 20 minutes.
`;

async function openQrLogin(page: Page): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const qrLink = page.locator('a[href="/buyer/login/qr"]');
  if ((await qrLink.count()) > 0) {
    await qrLink.first().click({ timeout: 5_000 }).catch(() => undefined);
    return;
  }
  if (!page.url().includes("/buyer/login/qr")) {
    await page.goto(LOGIN_FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const fallback = page.locator('a[href="/buyer/login/qr"]');
    if ((await fallback.count()) > 0) {
      await fallback.first().click({ timeout: 5_000 }).catch(() => undefined);
    }
  }
}

function asBrowserCookies(cookies: Cookie[]): BrowserCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
  }));
}

async function dumpCookieNames(page: Page, dumpPath: string): Promise<void> {
  const cookies = await page.context().cookies();
  const dump = cookies
    .map((c) => `${c.domain}\t${c.name}`)
    .sort()
    .join("\n");
  await writeAtomic(dumpPath, `${dump}\n`);
}

async function bundleFromContext(context: BrowserContext): Promise<PasteBundle> {
  return toPasteBundle(asBrowserCookies(await context.cookies()));
}

async function waitForSession(
  context: BrowserContext,
  donePath: string,
  timeoutMs: number,
): Promise<{ outcome: "session" | "enter" | "done" | "timeout"; bundle: PasteBundle }> {
  return new Promise((resolve) => {
    let settled = false;
    let rl: ReturnType<typeof createInterface> | undefined;
    const finish = (outcome: "session" | "enter" | "done" | "timeout", bundle: PasteBundle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      rl?.close();
      resolve({ outcome, bundle });
    };
    const timer = setTimeout(() => {
      void bundleFromContext(context).then((bundle) => finish("timeout", bundle));
    }, timeoutMs);
    const poll = setInterval(() => {
      if (fs.existsSync(donePath)) {
        void bundleFromContext(context).then((bundle) => finish("done", bundle));
        return;
      }
      void bundleFromContext(context).then((bundle) => {
        if (hasSessionCookie(bundle)) finish("session", bundle);
      });
    }, 2000);
    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("", () => {
        void bundleFromContext(context).then((bundle) => finish("enter", bundle));
      });
    }
  });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.env.AUTH_HEADED !== "1") {
    process.stderr.write("auth.ts is Darwin headed (or AUTH_HEADED=1). Cloudflare Worker cannot run Chrome.\n");
    process.exitCode = 1;
    return;
  }

  const paths = await ensureRuntimeDirs();
  await acquireLock(paths.lockPath);
  let context: BrowserContext | undefined;
  try {
    await fsPromises.mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    try {
      await fsPromises.unlink(paths.operatorDonePath);
    } catch {
      // no sentinel
    }
    context = await chromium.launchPersistentContext(paths.profileDir, {
      headless: false,
      executablePath: chromiumExecutable(chromium.executablePath()),
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await openQrLogin(page);
    process.stdout.write(LOGIN_PROMPT);

    const { outcome, bundle } = await waitForSession(context, paths.operatorDonePath, 20 * 60 * 1000);
    await dumpCookieNames(page, paths.cookieNamesPath);

    if (outcome === "timeout") {
      process.stderr.write("Timed out waiting for login.\n");
      process.exitCode = 1;
      return;
    }
    if (!hasSessionCookie(bundle)) {
      process.stderr.write("Login was not detected (need SPC_EC or SPC_ST). Session not saved.\n");
      process.exitCode = 1;
      return;
    }

    await writeAtomic(paths.pastePath, `${JSON.stringify(bundle, null, 2)}\n`);
    await writeAtomic(
      paths.authMetaPath,
      `${JSON.stringify({ authenticatedAt: new Date().toISOString(), origin: "https://shopee.co.id" })}\n`,
    );
    process.stdout.write(
      `CAPTURED ${bundle.cookies.length} cookies: ${cookieNamesLine(bundle)}\n` +
        `Saved ${path.relative(process.cwd(), paths.pastePath)} (values not printed).\n`,
    );

    if (process.env.SHOPEE_AUTH_SKIP_PASTE === "1") {
      process.stdout.write("SHOPEE_AUTH_SKIP_PASTE=1 — not posting to Worker.\n");
      return;
    }

    const base = workerBase();
    try {
      const pasted = await pasteToWorker(bundle, base);
      process.stdout.write(`PASTE_OK ${base} source=${pasted.source} cookieCount=${pasted.cookieCount}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "paste failed";
      process.stderr.write(
        `Paste to ${base} failed: ${message}\n` +
          `Session file is on disk. Retry bun run auth, or set SHOPEE_MCP_BASE.\n`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "auth failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    releaseLock(paths.lockPath);
  }
}

void main();
