import { READ_OPERATIONS } from "./ops/reads";
import type { ApiOperation } from "./types";

/** Exposed Code Mode operations (captured buyer reads, evidence `observed`). */
export const OPERATIONS: ApiOperation[] = [...READ_OPERATIONS];

export function getOperation(operationId: string): ApiOperation | undefined {
  return OPERATIONS.find((o) => o.operationId === operationId);
}

export function listExposedOperations(): ApiOperation[] {
  return OPERATIONS.filter((o) => o.exposed);
}

export function listReadOperations(): ApiOperation[] {
  return listExposedOperations().filter((o) => o.safety === "read");
}

export function listMutationOperations(): ApiOperation[] {
  return listExposedOperations().filter((o) => o.safety === "write" || o.safety === "destructive");
}
