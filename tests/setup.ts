import { vi } from "vitest";
import { FAKE_OPS } from "./stubs/fake-ops";

vi.mock("../src/registry/operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/registry/operations")>();
  return {
    ...actual,
    getOperation: (id: string) => FAKE_OPS[id] ?? actual.getOperation(id),
  };
});
