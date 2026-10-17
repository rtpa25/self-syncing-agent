import { tool } from "ai";
import { z } from "zod";
import Parallel, {
  APIError,
  AuthenticationError,
  RateLimitError
} from "parallel-web";
import type { ChatAgent } from "../../../server";
import { searchParallelMcp } from "../../../integrations/parallel-search-mcp";

const DEFAULT_MODE = "agentic" as const;
const DEFAULT_EXCERPT_CHARS = 4000;

export function webSearchTool(agent: ChatAgent) {
  return tool({
    description:
      "Search the web for current information via Parallel AI. Uses free Search MCP when no Parallel API key is configured, or authenticated agentic search with a configured key. Use for: verifying an integration's API/webhook shape, looking up error-code meanings, researching recent API changes, fact-checking. Returns relevant URLs, titles and excerpts.",
    inputSchema: z.object({
      objective: z
        .string()
        .describe(
          "Natural-language description of what you're trying to find. Keep it focused on ONE concrete question — this drives quality more than keyword queries."
        ),
      search_queries: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe(
          "(optional) Up to 5 keyword queries (≤200 chars each) to seed the search. Without queries, keyless search uses the objective as its query; a configured API key uses SDK agentic defaults."
        )
    }),
    execute: async ({ objective, search_queries }, { abortSignal }) => {
      try {
        const apiKey = agent.env.PARALLEL_API_KEY;
        // A configured key always selects the existing SDK path. In
        // particular, an invalid key must not silently switch providers.
        const result = apiKey
          ? await new Parallel({ apiKey }).beta.search(
              {
                objective,
                search_queries: search_queries ?? null,
                mode: DEFAULT_MODE,
                excerpts: { max_chars_per_result: DEFAULT_EXCERPT_CHARS }
              },
              { signal: abortSignal }
            )
          : await searchParallelMcp({
              objective,
              searchQueries: search_queries,
              signal: abortSignal
            });
        if ("error" in result) return result;
        return {
          objective,
          search_id: result.search_id,
          result_count: result.results.length,
          results: result.results.map((r) => ({
            url: r.url,
            title: r.title ?? null,
            excerpts: r.excerpts ?? [],
            publish_date: r.publish_date ?? null
          }))
        };
      } catch (e) {
        abortSignal?.throwIfAborted();
        // Narrow error surface so the agent can decide how to respond:
        // back off on rate-limit vs. surface "key is bad" to the user vs.
        // treat a generic 5xx as retryable. All three branches extend
        // APIError, so order matters — check specific types first.
        if (e instanceof RateLimitError) {
          return { error: "parallel_ai_rate_limit", detail: e.message };
        }
        if (e instanceof AuthenticationError) {
          return { error: "parallel_ai_auth_failed", detail: e.message };
        }
        if (e instanceof APIError) {
          return {
            error: "parallel_ai_request_failed",
            status: e.status,
            detail: e.message
          };
        }
        throw e;
      }
    }
  });
}
