import { getCollector } from "@/collector/collector";
import { config } from "@/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-sent events: the collector tells the browser when a cycle produced
 * new data, and the client re-fetches.
 *
 * SSE rather than websockets because the traffic is one-way and this is a
 * single-instance self-hosted app — no need for a broker, and it reconnects
 * on its own. The payload is deliberately just a ping: sending the rows here
 * would duplicate the filtering logic that already lives in /api/pools.
 */
export async function GET(req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("hello", { at: Date.now(), collectorEnabled: config.collector.enabled });

      const unsubscribe = config.collector.enabled
        ? getCollector().onUpdate(() => send("update", { at: Date.now() }))
        : () => {};

      // Keeps intermediaries from closing an idle connection.
      const keepAlive = setInterval(() => send("ping", { at: Date.now() }), 25_000);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already torn down by the runtime.
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
