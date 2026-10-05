/** Dump performance resource URLs that look like chat, from every Shopee tab. */
const DEBUG_PORT = 9333;

async function callOn(wsUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws")), { once: true });
  });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { result?: { value?: unknown } }; error?: { message: string } };
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return result;
}

const expr = `(() => {
  const perf = performance.getEntries().map((e) => e.name).filter((n) => /chat|socket\\.io|webchat|conversation|chateasy|buyer-chat|chat-ws/i.test(n));
  const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /chat|webchat|pesan/i.test(h));
  return { href: location.href, perf: [...new Set(perf)].slice(0, 40), hrefs: [...new Set(hrefs)].slice(0, 20) };
})()`;

const pages = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}>;

for (const p of pages.filter((x) => x.type === "page" && x.webSocketDebuggerUrl && /shopee\.co\.id/.test(x.url))) {
  try {
    const v = await callOn(p.webSocketDebuggerUrl!, expr);
    console.log(JSON.stringify(v));
  } catch (err) {
    console.log("fail", p.url, err instanceof Error ? err.message : err);
  }
}
