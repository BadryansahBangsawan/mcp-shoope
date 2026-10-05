import { buildOpenApiDocument, buildOperationCatalog } from "../registry/openapi";
import { listExposedOperations } from "../registry/operations";

export interface CodemodeSpecBundle {
  openapi: Record<string, unknown>;
  catalog: Array<Record<string, unknown>>;
  examples: string[];
}

export function createSpecBundle(): CodemodeSpecBundle {
  return {
    openapi: buildOpenApiDocument(),
    catalog: buildOperationCatalog(),
    examples: [
      `async () => {
  const spec = await codemode.spec();
  return spec.catalog.map(o => ({ id: o.operationId, method: o.method, path: o.path, tags: o.tags }));
}`,
      `async () => {
  const spec = await codemode.spec();
  return { count: spec.catalog.length, ids: spec.catalog.map(o => o.operationId) };
}`,
    ],
  };
}

export function searchCatalog(
  bundle: CodemodeSpecBundle,
  query: string,
): Array<Record<string, unknown>> {
  const q = query.toLowerCase().trim();
  if (!q) return bundle.catalog.slice(0, 25);
  return bundle.catalog
    .filter((o) => {
      const hay = JSON.stringify(o).toLowerCase();
      return q.split(/\s+/).every((term) => hay.includes(term));
    })
    .slice(0, 40);
}

export function exposedReadIds(): string[] {
  return listExposedOperations()
    .filter((o) => o.safety === "read")
    .map((o) => o.operationId);
}
