import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { buildTools } from "../src/agent/tools";
import type { ChatAgent } from "../src/server";

const MCP_URL = "https://search.parallel.ai/mcp";
const USER_AGENT =
  "self-syncing-agent/0.1.0 (+https://github.com/rtpa25/self-syncing-agent)";
const SEARCH_RESULT = {
  search_id: "search_fixture",
  results: [
    {
      url: "https://docs.stripe.com/webhooks?version=latest#verify",
      title: "Verify Stripe signatures",
      excerpts: ["Verify the Stripe-Signature header against the raw body."],
      publish_date: null
    }
  ]
};

function tools(apiKey?: string) {
  // The registry only reads the agent's bindings when this tool executes.
  return buildTools({ env: { PARALLEL_API_KEY: apiKey } } as ChatAgent);
}

async function search(
  apiKey?: string,
  args = { objective: "Stripe webhook signatures" } as {
    objective: string;
    search_queries?: string[];
  },
  abortSignal?: AbortSignal
) {
  return await tools(apiKey).web_search.execute!(args, {
    toolCallId: "search-test",
    messages: [],
    abortSignal
  });
}

type RpcRequest = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

function mockMcp(
  callResult: unknown = {
    content: [{ type: "text", text: JSON.stringify(SEARCH_RESULT) }],
    structuredContent: SEARCH_RESULT
  }
) {
  const requests: { request: Request; rpc?: RpcRequest }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(MCP_URL);
    expect(request.headers.get("user-agent")).toBe(USER_AGENT);
    expect(request.headers.has("authorization")).toBe(false);
    const entry: (typeof requests)[number] = { request };
    requests.push(entry);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const rpc = (await request.json()) as RpcRequest;
    entry.rpc = rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Parallel fixture", version: "1.0.0" }
          }
        : callResult;
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  return requests;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("web_search through the tool registry", () => {
  it("returns excerpts to the next model step in a scripted tool loop", async () => {
    mockMcp();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        const first = step++ === 0;
        if (!first) {
          const toolMessage = prompt.find((message) => message.role === "tool");
          expect(toolMessage).toBeDefined();
          expect(JSON.stringify(toolMessage)).toContain(
            SEARCH_RESULT.results[0].url
          );
          expect(JSON.stringify(toolMessage)).toContain(
            SEARCH_RESULT.results[0].excerpts[0]
          );
        }
        return {
          content: first
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: "search-loop",
                  toolName: "web_search",
                  input: JSON.stringify({
                    objective: "Stripe webhook signatures"
                  })
                }
              ]
            : [
                {
                  type: "text" as const,
                  text: "Verify the raw body using Stripe-Signature."
                }
              ],
          finishReason: {
            unified: first ? ("tool-calls" as const) : ("stop" as const),
            raw: undefined
          },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 }
          },
          warnings: []
        };
      }
    });
    const result = await generateText({
      model,
      prompt: "Find Stripe signature verification docs.",
      tools: tools(),
      stopWhen: stepCountIs(2)
    });
    expect(step).toBe(2);
    expect(result.text).toContain("Stripe-Signature");
  });

  it.each([undefined, ""])(
    "uses anonymous MCP with key %s and preserves useful results",
    async (key) => {
      const requests = mockMcp();
      const result = await search(key);
      expect(result).toEqual({
        objective: "Stripe webhook signatures",
        ...SEARCH_RESULT,
        result_count: 1
      });
      expect(requests.some((r) => r.rpc?.method === "initialize")).toBe(true);
      expect(
        requests.find((r) => r.rpc?.method === "tools/call")?.rpc?.params
      ).toEqual({
        name: "web_search",
        arguments: {
          objective: "Stripe webhook signatures",
          search_queries: ["Stripe webhook signatures"]
        }
      });
    }
  );

  it("preserves explicit queries and supports text-only MCP responses", async () => {
    const requests = mockMcp({
      content: [{ type: "text", text: JSON.stringify(SEARCH_RESULT) }]
    });
    const result = await search(undefined, {
      objective: "Find signing docs",
      search_queries: ["Stripe raw body verification", "Stripe signing secret"]
    });
    expect(result).toHaveProperty("result_count", 1);
    expect(
      requests.find((r) => r.rpc?.method === "tools/call")?.rpc?.params
    ).toHaveProperty("arguments.search_queries", [
      "Stripe raw body verification",
      "Stripe signing secret"
    ]);
  });

  it("keeps configured credentials on SDK agentic search", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.url).toBe("https://api.parallel.ai/v1beta/search");
      expect(request.headers.get("x-api-key")).toBe("configured-key");
      expect(await request.json()).toEqual({
        objective: "Stripe webhook signatures",
        search_queries: null,
        mode: "agentic",
        excerpts: { max_chars_per_result: 4000 }
      });
      return Response.json(SEARCH_RESULT);
    });
    expect(await search("configured-key")).toHaveProperty("result_count", 1);
    expect(requests).toHaveLength(1);
  });

  it("does not fall back after an explicitly configured key fails", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://api.parallel.ai/v1beta/search");
        return Response.json(
          { error: { message: "Invalid API key" } },
          { status: 401 }
        );
      });
    expect(await search("bad-key")).toHaveProperty(
      "error",
      "parallel_ai_auth_failed"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("passes cancellation to the configured SDK request", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
          setTimeout(() => controller.abort(new Error("Stopped")), 0);
        })
    );
    await expect(
      search("configured-key", undefined, controller.signal)
    ).rejects.toThrow("Stopped");
  });

  it.each([
    [429, "parallel_ai_rate_limit"],
    [401, "parallel_ai_auth_failed"],
    [503, "parallel_ai_request_failed"]
  ])("reports MCP HTTP %s", async (status, error) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service unavailable", { status: status as number })
    );
    expect(await search()).toMatchObject({ error, status });
  });

  it("surfaces MCP tool errors and rejects malformed success results", async () => {
    mockMcp({
      isError: true,
      content: [{ type: "text", text: "Quota exceeded" }]
    });
    expect(await search()).toEqual({
      error: "parallel_ai_request_failed",
      detail: "Quota exceeded"
    });
    vi.restoreAllMocks();
    mockMcp({ content: [{ type: "text", text: "not JSON" }] });
    expect(await search()).toHaveProperty(
      "error",
      "parallel_ai_request_failed"
    );
  });

  it("propagates cancellation during discovery and during search", async () => {
    for (const duringSearch of [false, true]) {
      vi.restoreAllMocks();
      const controller = new AbortController();
      const success = mockMcp();
      const fixtureFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const rpc =
          request.method === "POST"
            ? ((await request.json()) as RpcRequest)
            : undefined;
        if (
          (rpc?.method === "tools/call") === duringSearch &&
          rpc?.id !== undefined
        ) {
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true }
            );
            setTimeout(
              () => controller.abort(new DOMException("Stopped", "AbortError")),
              0
            );
          });
        }
        return fixtureFetch(input, init);
      });
      await expect(
        search(undefined, undefined, controller.signal)
      ).rejects.toThrow("Stopped");
      if (duringSearch)
        expect(success.some((r) => r.rpc?.method === "initialize")).toBe(true);
    }
  });

  it("returns a bounded timeout even if discovery stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
        })
    );
    const pending = search();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ error: "parallel_ai_timeout" });
  });

  it("does no network work for an already cancelled call and keeps write approvals", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(
      search(undefined, undefined, AbortSignal.abort(new Error("Stopped")))
    ).rejects.toThrow("Stopped");
    expect(fetcher).not.toHaveBeenCalled();
    const registry = tools();
    expect(registry.web_search.needsApproval).toBeUndefined();
    expect(registry.create_sync.needsApproval).toBe(true);
    expect(registry.update_sync.needsApproval).toBe(true);
    expect(registry.delete_sync.needsApproval).toBe(true);
    expect(registry.run_in_sync.needsApproval).toBe(true);
  });
});
