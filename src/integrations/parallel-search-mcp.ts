import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT =
  "self-syncing-agent/0.1.0 (+https://github.com/rtpa25/self-syncing-agent)";
const TIMEOUT_MS = 30_000;

// Keep the same search result contract as the authenticated SDK tool.
const searchResponse = z.object({
  search_id: z.string(),
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      excerpts: z.array(z.string()).default([]),
      publish_date: z.string().nullish()
    })
  )
});

export async function searchParallelMcp({
  objective,
  searchQueries,
  signal
}: {
  objective: string;
  searchQueries?: string[];
  signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  const client = new Client({ name: "self-syncing-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { "User-Agent": USER_AGENT } },
    // Apply the deadline to discovery as well as execution, including the
    // transport's background SSE connection. Never send ambient credentials.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, requestSignal])
          : requestSignal
      })
  });

  try {
    await client.connect(transport);
    const result = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: "web_search",
          arguments: {
            objective,
            // The existing tool makes queries optional; MCP requires one.
            search_queries: searchQueries?.length
              ? searchQueries
              : [objective.slice(0, 200)]
          }
        },
        undefined,
        { signal: requestSignal }
      )
    );
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (result.isError) {
      return { error: "parallel_ai_request_failed", detail: text } as const;
    }
    return searchResponse.parse(result.structuredContent ?? JSON.parse(text));
  } catch (error) {
    // Cancellation belongs to the caller; a deadline is a tool error the
    // model can explain or retry. Neither triggers a provider fallback.
    signal?.throwIfAborted();
    if (timeout.signal.aborted) {
      return {
        error: "parallel_ai_timeout",
        detail: "Parallel Search MCP timed out after 30 seconds."
      } as const;
    }
    const status =
      error instanceof StreamableHTTPError ? error.code : undefined;
    return {
      error:
        status === 429
          ? "parallel_ai_rate_limit"
          : status === 401 || status === 403
            ? "parallel_ai_auth_failed"
            : "parallel_ai_request_failed",
      ...(status === undefined ? {} : { status }),
      detail: error instanceof Error ? error.message : "Parallel search failed."
    };
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
