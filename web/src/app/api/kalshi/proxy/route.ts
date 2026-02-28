import { createServerClient } from "@/lib/supabase-server";
import { getSubscriptionStatus } from "@/lib/subscription";

const KALSHI_BASE = "https://api.elections.kalshi.com";

export async function POST(request: Request) {
  // 1. Authenticate the user
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Check active subscription
  const sub = await getSubscriptionStatus(supabase, user.id);
  if (!sub.active) {
    return Response.json(
      { error: "Active subscription required" },
      { status: 403 }
    );
  }

  // 3. Parse the pre-signed request
  let body: {
    method: string;
    path: string;
    query?: string;
    body?: unknown;
    kalshiKeyId: string;
    timestamp: string;
    signature: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { method, path, query, body: reqBody, kalshiKeyId, timestamp, signature } =
    body;

  // 4. Validate path to prevent SSRF
  if (!path || !path.startsWith("/trade-api/v2")) {
    return Response.json(
      { error: "Invalid path — must start with /trade-api/v2" },
      { status: 400 }
    );
  }

  // 5. Construct the Kalshi URL
  const kalshiUrl = query
    ? `${KALSHI_BASE}${path}?${query}`
    : `${KALSHI_BASE}${path}`;

  // 6. Forward with signed headers
  const headers: Record<string, string> = {
    "KALSHI-ACCESS-KEY": kalshiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (reqBody && method !== "GET") {
    fetchOptions.body =
      typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody);
  }

  try {
    const kalshiResp = await fetch(kalshiUrl, fetchOptions);
    const responseBody = await kalshiResp.text();

    return new Response(responseBody, {
      status: kalshiResp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Kalshi proxy error:", message);
    return Response.json(
      { error: `Failed to reach Kalshi API: ${message}` },
      { status: 502 }
    );
  }
}
