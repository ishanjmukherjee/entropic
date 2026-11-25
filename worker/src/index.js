// Scoring proxy for the entropic page. Holds the Featherless key, accepts only
// the one request shape the page needs, and bounds how much can be spent.
const MODELS = ["moonshotai/Kimi-K3", "moonshotai/Kimi-K2.6"];
const UPSTREAM = "https://api.featherless.ai/v1/completions";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGINS.split(",").includes(origin);
    const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    const fail = (status, code, message) => new Response(JSON.stringify({ error: { code, message } }), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
    });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }
    if (!allowed) return fail(403, "forbidden_origin", "This endpoint only serves the entropic page.");
    if (request.method !== "POST" || new URL(request.url).pathname !== "/score") return fail(404, "not_found", "Not found.");

    let body;
    try { body = await request.json(); } catch (e) { return fail(400, "bad_request", "Expected a JSON body."); }
    const { prompt, model } = body || {};
    if (typeof prompt !== "string" || !prompt.length) return fail(400, "bad_request", "Missing text.");
    if (prompt.length > Number(env.MAX_PROMPT_CHARS)) return fail(413, "too_long", "Text is too long for one request.");
    if (!MODELS.includes(model)) return fail(400, "bad_model", "Unknown model.");

    const visitor = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.PER_VISITOR.limit({ key: visitor });
    if (!success) return fail(429, "visitor_limit", "Too many requests. Wait a minute and try again.");

    // Approximate daily budget in characters, shared by all visitors. Counted
    // before the upstream call, so it errs toward stopping early. If the
    // counter cannot be written the request is refused.
    const day = `chars:${new Date().toISOString().slice(0, 10)}`;
    const used = Number(await env.USAGE.get(day)) || 0;
    if (used + prompt.length > Number(env.DAILY_CHAR_BUDGET)) {
      return fail(429, "daily_cap", "The shared scoring budget for today is used up.");
    }
    try {
      await env.USAGE.put(day, String(used + prompt.length), { expirationTtl: 3 * 86400 });
    } catch (e) {
      return fail(429, "daily_cap", "The shared scoring budget for today is used up.");
    }

    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.FEATHERLESS_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, max_tokens: 1, temperature: 0, logprobs: 5, echo: true, stream: true }),
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return fail(502, "proxy_key_rejected", "The scoring service rejected the shared key.");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/event-stream", "Cache-Control": "no-store", ...cors },
    });
  },
};
