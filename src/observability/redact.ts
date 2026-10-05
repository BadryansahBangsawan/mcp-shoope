const SECRET_KEYS =
  /^(authorization|cookie|x-csrf-token|x-csrftoken|csrftoken|xsrf-token|password|pin|otp|vcode|token|api[_-]?token|partner_key|access_token|refresh_token|sign|code|bearer)$/i;

const TOKENISH =
  /\b(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[A-Fa-f0-9]{32}|[A-Za-z0-9_-]{40,})\b/g;

export function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.replace(TOKENISH, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactText(text: string): string {
  return text.replace(TOKENISH, "[REDACTED]");
}

/** Fields whose sample values are personal data in order/recipient captures. */
const PERSON_FIELDS: ReadonlySet<string> = new Set([
  "fullname",
  "fullName",
  "displayName",
  "name",
  "mobile",
  "phone",
  "email",
  "username",
  "address",
  "recipient_name",
  "recipient_address",
  "buyer_username",
  "phone_number",
]);

const PERSON_CONTEXT = /recipient|buyer|customer|address|phone|email|user/i;

const PII_PLACEHOLDER = "<PII_REDACTED>";
const PERSON_JSON_FIELD = new RegExp(`"(${[...PERSON_FIELDS].join("|")})"(\\s*:\\s*)"[^"\\n]+"`, "gi");
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Strip sample PII, emails, tokens and signed query params from markdown before exposing as MCP resources. */
export function sanitizeDocMarkdown(md: string): string {
  return redactStructuredPii(md)
    .replace(PERSON_JSON_FIELD, `"$1"$2"${PII_PLACEHOLDER}"`)
    .replace(UUID, "<UUID>")
    .replace(/\+?\b62\d{8,13}\b/g, "<PHONE_REDACTED>")
    .replace(/\b08\d{7,12}\b/g, "<PHONE_REDACTED>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<EMAIL_REDACTED>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <TOKEN>")
    .replace(/([?&])(sign|access_token|refresh_token|partner_key)=[^&\s"'`]+/gi, "$1$2=<REDACTED>")
    .replace(/([?&])code=[^&\s"'`]+/gi, "$1code=<REDACTED>")
    .replace(/Cookie:\s*[^\n]+/gi, "Cookie: <COOKIE>")
    .replace(TOKENISH, "[REDACTED]");
}

function redactStructuredPii(md: string): string {
  const out: string[] = [];
  const headings: string[] = [];
  let fence: string[] | null = null;
  let header: string[] | null = null;

  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (fence) {
        out.push(redactJsonNames(fence.join("\n"), headings), line);
        fence = null;
      } else {
        out.push(line);
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const heading = /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading) {
      headings.length = (heading[1]?.length ?? 2) - 2;
      headings.push(heading[2] ?? "");
    }
    const cells = splitRow(line);
    if (!cells) {
      header = null;
      out.push(line);
      continue;
    }
    if (!header) {
      header = cells.map((c) => c.replace(/`/g, "").toLowerCase());
      out.push(line);
      continue;
    }
    out.push(redactRow(line, cells, header, isPersonHeading(headings)));
  }
  if (fence) out.push(fence.join("\n"));
  return out.join("\n");
}

function isPersonHeading(headings: string[]): boolean {
  const last = headings[headings.length - 1] ?? "";
  const segment = last.replace(/`/g, "").split(/\s/, 1)[0]?.split(".").pop() ?? "";
  return PERSON_CONTEXT.test(last.includes(".") ? segment : last);
}

function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function redactRow(line: string, cells: string[], header: string[], personContext: boolean): string {
  if (cells.every((c) => /^:?-+:?$/.test(c))) return line;
  const isPersonKey = (k: string) =>
    PERSON_FIELDS.has(k) || (personContext && /\bname\b/.test(k));
  const field = /^`([^`]+)`$/.exec(cells[0] ?? "")?.[1]?.toLowerCase() ?? "";
  const sampleCol = header.findIndex((h) => /^(sample|example)$/.test(h));
  const redactCols = new Set<number>();
  const rowForm = sampleCol > 0 && (PERSON_FIELDS.has(field) || (personContext && field === "name"));
  if (rowForm) redactCols.add(sampleCol);
  if (sampleCol === -1) {
    header.forEach((h, i) => {
      if (isPersonKey(h)) redactCols.add(i);
    });
  }
  if (redactCols.size === 0) return line;
  const parts = line.split("|");
  for (const i of redactCols) parts[i + 1] = redactCodeSpans(parts[i + 1] ?? "", !rowForm);
  return parts.join("|");
}

function redactCodeSpans(cell: string, keepNumeric: boolean): string {
  return cell.replace(/`([^`]*)`/g, (whole, inner: string) => {
    const v = inner.trim();
    const keep = v === "" || v === '""' || (keepNumeric && /^"?\d+"?$/.test(v));
    return keep ? whole : `\`${PII_PLACEHOLDER}\``;
  });
}

interface Frame {
  key: string;
  names: Array<[number, number]>;
  personal: boolean;
}

function redactJsonNames(text: string, headings: string[]): string {
  const spans: Array<[number, number]> = [];
  const stack: Frame[] = [];
  const contextPersonal = isPersonHeading(headings);
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)];
  let pendingKey = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]?.[0] ?? "";
    const nextTok = tokens[i + 1]?.[0];
    if (tok === "{" || tok === "[") {
      const key = pendingKey || stack[stack.length - 1]?.key || "";
      const personal = key ? PERSON_CONTEXT.test(key) : contextPersonal;
      stack.push({ key, names: [], personal });
      pendingKey = "";
    } else if (tok === "}" || tok === "]") {
      const frame = stack.pop();
      if (frame?.personal) spans.push(...frame.names);
    } else if (tok.startsWith('"') && nextTok === ":") {
      pendingKey = tok.slice(1, -1);
      i++;
      const value = tokens[i + 1];
      if (value?.[0].startsWith('"') && value[0].length > 2 && tokens[i + 2]?.[0] !== ":") {
        const range: [number, number] = [value.index ?? 0, (value.index ?? 0) + value[0].length];
        const frame = stack[stack.length - 1];
        if (PERSON_FIELDS.has(pendingKey.toLowerCase())) {
          spans.push(range);
          if (frame) frame.personal = true;
        } else if (pendingKey === "name" && frame) {
          frame.names.push(range);
        }
      }
    } else {
      pendingKey = "";
    }
  }
  let result = text;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    result = `${result.slice(0, start)}"${PII_PLACEHOLDER}"${result.slice(end)}`;
  }
  return result;
}
