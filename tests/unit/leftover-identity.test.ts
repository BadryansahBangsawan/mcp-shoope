import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

/** Names from sibling products that must not leak into this Worker. */
const LEFTOVER =
  /qasir|manujujaya|binus|\bmj_|bm_|QASIR_|BINUS_|createManujujayaServer|Toko Manuju|purchases\.confirmation|MERCHANT_SLUG/i;

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  ".wrangler",
  "coverage",
]);

const TEXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".txt",
  ".example",
  ".toml",
]);

const ROOT_FILES = ["README.md", "package.json", "wrangler.jsonc", ".dev.vars.example"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    const ext = path.extname(name);
    if (TEXT.has(ext) || name.startsWith(".dev.vars")) out.push(full);
  }
  return out;
}

describe("leftover product identity", () => {
  it("src, docs, scripts, and root files do not mention sibling products", () => {
    const files = [
      ...walk(path.join(root, "src")),
      ...walk(path.join(root, "docs")),
      ...walk(path.join(root, "scripts")),
      ...ROOT_FILES.map((f) => path.join(root, f)).filter((f) => {
        try {
          statSync(f);
          return true;
        } catch {
          return false;
        }
      }),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (LEFTOVER.test(text)) hits.push(path.relative(root, file));
    }
    expect(hits).toEqual([]);
  });
});
