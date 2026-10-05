import { redactValue } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export function log(
  level: LogLevel,
  message: string,
  fields?: LogFields,
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redactValue(fields) as LogFields) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
