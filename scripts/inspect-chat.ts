/** One-shot: inspect Shopee DOM for chat, click first "chat" button, list new targets. */
const DEBUG_PORT = 9333;

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{
    type: string;
    url: string;
    title?: string;
    webSocketDebuggerUrl?: string;
  }>;
}

async function withPage<T>(
  wsUrl: string,
  fn: (call: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp ws")), { once: true });
  });
  let seq = 0;
  const call = (method: string, params?: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 12_000);
      const on = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener("message", on);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

async function evalJson(wsUrl: string, expression: string): Promise<unknown> {
  return withPage(wsUrl, async (call) => {
    await call("Runtime.enable");
    const r = (await call("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    return r.result?.value;
  });
}

async function main() {
  const list = await pages();
  const page = list.find((p) => p.type === "page" && /shopee\.co\.id\/user\/purchase/.test(p.url) && p.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("no purchase tab");
  console.log("tab", page.url);

  const scan = await evalJson(
    page.webSocketDebuggerUrl,
    `(() => {
      const html = document.documentElement.outerHTML;
      const urls = html.match(/https?:\\/\\/[^"'\\s<>]*chat[^"'\\s<>]*/gi) || [];
      const webchat = html.includes("webchat");
      const iframes = [...document.querySelectorAll("iframe")].map((f) => f.src);
      return { webchat, urls: [...new Set(urls)].slice(0, 20), iframes, title: document.title };
    })()`,
  );
  console.log("scan", JSON.stringify(scan));

  const box = (await evalJson(
    page.webSocketDebuggerUrl,
    `(() => {
      const btn = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim().toLowerCase() === "chat");
      if (!btn) return null;
      btn.scrollIntoView({ block: "center", inline: "center" });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`,
  )) as { x: number; y: number } | null;
  console.log("box", JSON.stringify(box));
  if (box) {
    await withPage(page.webSocketDebuggerUrl, async (call) => {
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await call("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
      await call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    });
    console.log("clicked_mouse");
  }
  await Bun.sleep(4000);

  const after = await pages();
  console.log("targets");
  for (const p of after) {
    if (p.type === "page" || p.type === "iframe" || /chat/i.test(p.url) || /chat/i.test(p.title || "")) {
      console.log(`  ${p.type} ${(p.title || "").slice(0, 50)} ${p.url.slice(0, 180)}`);
    }
  }

  const afterScan = await evalJson(
    page.webSocketDebuggerUrl,
    `(() => {
      const iframes = [...document.querySelectorAll("iframe")].map((f) => ({ src: f.src, id: f.id, cls: String(f.className).slice(0, 80) }));
      const dialogs = [...document.querySelectorAll("[role=dialog], .chat, [class*=chat]")].slice(0, 10).map((el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 100),
        text: (el.textContent || "").trim().slice(0, 60),
      }));
      return { iframes, dialogs, href: location.href };
    })()`,
  );
  console.log("after", JSON.stringify(afterScan, null, 2).slice(0, 4000));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
