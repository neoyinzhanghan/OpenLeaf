/**
 * Benchmark graph build + a synthetic 3k/6k layout budget check.
 */
import { performance } from "node:perf_hooks";

async function main() {
  const { buildKnowledgeGraph } = await import("../server/src/services/knowledge/graph.ts");
  const t0 = performance.now();
  const graph = await buildKnowledgeGraph(true);
  const buildMs = performance.now() - t0;

  // Synthetic force step budget (no DOM): 3000 nodes / 6000 edges adjacency walk
  const N = 3000;
  const E = 6000;
  const nodes = Array.from({ length: N }, (_, i) => ({ id: i, x: Math.random(), y: Math.random() }));
  const edges = Array.from({ length: E }, (_, i) => ({
    from: i % N,
    to: (i * 7) % N,
  }));
  const t1 = performance.now();
  for (let iter = 0; iter < 30; iter += 1) {
    for (const e of edges) {
      const a = nodes[e.from]!;
      const b = nodes[e.to]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      a.x += dx * 0.01;
      a.y += dy * 0.01;
      b.x -= dx * 0.01;
      b.y -= dy * 0.01;
    }
  }
  const synthMs = performance.now() - t1;

  const report = {
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    fullRebuildMs: Math.round(buildMs),
    synthetic3000x6000_30itersMs: Math.round(synthMs),
    targetRebuildUnderMs: 1000,
    note: "Client pan/zoom fps must be measured in Playwright/browser; this script times graph build + a synthetic layout step.",
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
