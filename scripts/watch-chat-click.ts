/** Enable Network on the purchase tab, click Chat, print unique URLs (no cookie values). */
const DEBUG_PORT = 9333;

const pages = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}>;
const page = pages.find((p) => p.type === "page" && /\/user\/purchase\/?$/.test(new URL(p.url).pathname) && p.webSocketDebuggerUrl);
if (!page?.webSocketDebuggerUrl) throw new Error("no purchase tab");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("ws")), { once: true });
});

let seq = 0;
const call = (method: string, params?: Record<string, unknown>) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000);
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

const seen = new Set<string>();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data)) as { method?: string; params?: Record<string, unknown> };
  if (msg.method === "Network.requestWillBeSent") {
    const req = msg.params?.request as { method?: string; url?: string } | undefined;
    if (!req?.url) return;
    if (!/webchat|chateasy|chat|socket\.io/i.test(req.url)) return;
    try {
      const u = new URL(req.url);
      const line = `${(req.method || "GET").toUpperCase()} ${u.origin}${u.pathname} keys=${[...u.searchParams.keys()].sort().join(",")}`;
      if (!seen.has(line)) {
        seen.add(line);
        console.log(line);
      }
    } catch {
      /* ignore */
    }
  }
  if (msg.method === "Network.webSocketCreated") {
    console.log("WS", String(msg.params?.url || "").split("?")[0]);
  }
});

await call("Network.enable");
const box = (await call("Runtime.evaluate", {
  expression: `(() => {
    const btn = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim().toLowerCase() === "chat");
    if (!btn) return null;
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`,
  returnByValue: true,
})) as { result?: { value?: { x: number; y: number } | null } };
const xy = box.result?.value;
console.log("box", JSON.stringify(xy));
if (xy) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: xy.x, y: xy.y });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: xy.x, y: xy.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: xy.x, y: xy.y, button: "left", clickCount: 1 });
  console.log("clicked");
}
await Bun.sleep(6000);
console.log("done unique", seen.size);
ws.close();
