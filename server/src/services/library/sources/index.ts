import { createArxivClient } from "./arxiv.js";
import { createCrossrefClient } from "./crossref.js";
import { createOpenAlexClient } from "./openalex.js";
import type { SourceClients } from "./types.js";

let defaultClients: SourceClients | null = null;

export function getSourceClients(): SourceClients {
  if (!defaultClients) {
    defaultClients = {
      crossref: createCrossrefClient(),
      openalex: createOpenAlexClient(),
      arxiv: createArxivClient(),
    };
  }
  return defaultClients;
}

/** Test hook — inject mocks. */
export function setSourceClientsForTests(clients: SourceClients | null): void {
  defaultClients = clients;
}

export type { SourceClients, ResolvedPaper } from "./types.js";
export { createArxivClient, createCrossrefClient, createOpenAlexClient };
