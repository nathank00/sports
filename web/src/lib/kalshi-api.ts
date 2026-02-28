import { signKalshiRequest, loadCryptoKey, loadKeyId } from "./kalshi-crypto";
import type {
  KalshiMarket,
  OrderResult,
  PositionItem,
} from "./types";

// ── Internal helper ────────────────────────────────────────────────────

/**
 * Make a signed request to the Kalshi API through our proxy.
 *
 * 1. Load CryptoKey from IndexedDB + keyId from localStorage
 * 2. Sign the request client-side (RSA-PSS SHA-256)
 * 3. Send pre-signed request to /api/kalshi/proxy
 */
async function kalshiRequest(
  method: string,
  path: string,
  query?: string,
  body?: unknown
): Promise<unknown> {
  const cryptoKey = await loadCryptoKey();
  const keyId = loadKeyId();

  if (!cryptoKey || !keyId) {
    throw new Error("Kalshi API keys not configured. Go to Settings to set up your keys.");
  }

  const timestamp = Date.now().toString();
  const signature = await signKalshiRequest(cryptoKey, timestamp, method, path);

  const resp = await fetch("/api/kalshi/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method,
      path,
      query: query || undefined,
      body: body || undefined,
      kalshiKeyId: keyId,
      timestamp,
      signature,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Kalshi API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

// ── Public API functions ───────────────────────────────────────────────

/**
 * Test connection by fetching balance.
 * Returns a human-readable message on success, or throws on failure.
 */
export async function testConnection(): Promise<string> {
  const data = await fetchBalance();
  return `Connected. Balance: $${data.balance.toFixed(2)}`;
}

/**
 * Fetch the user's cash balance and portfolio value.
 */
export async function fetchBalance(): Promise<{
  balance: number;
  portfolioValue: number;
}> {
  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/portfolio/balance"
  )) as {
    balance?: number;
    balance_dollars?: string;
    portfolio_value?: number;
    portfolio_value_dollars?: string;
  };

  // Prefer the _dollars string field, fall back to cents integer
  const balance = data.balance_dollars
    ? parseFloat(data.balance_dollars)
    : (data.balance ?? 0) / 100;

  const portfolioValue = data.portfolio_value_dollars
    ? parseFloat(data.portfolio_value_dollars)
    : (data.portfolio_value ?? 0) / 100;

  return { balance, portfolioValue };
}

/**
 * Fetch the user's open positions.
 */
export async function fetchPositions(): Promise<PositionItem[]> {
  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/portfolio/positions",
    "limit=200"
  )) as {
    market_positions?: Array<{
      ticker: string;
      market_exposure?: number;
      market_exposure_dollars?: string;
      total_traded?: number;
      total_traded_dollars?: string;
      resting_orders_count?: number;
    }>;
  };

  if (!data.market_positions) return [];

  return data.market_positions.map((p) => ({
    ticker: p.ticker,
    exposure: p.market_exposure_dollars
      ? parseFloat(p.market_exposure_dollars)
      : (p.market_exposure ?? 0) / 100,
    totalTraded: p.total_traded_dollars
      ? parseFloat(p.total_traded_dollars)
      : (p.total_traded ?? 0) / 100,
    restingOrders: p.resting_orders_count ?? 0,
  }));
}

/**
 * Fetch open NBA game markets from Kalshi.
 * Parses the _dollars string fields to numbers (matching Rust `into_market()`).
 */
export async function fetchNbaMarkets(): Promise<KalshiMarket[]> {
  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/markets",
    "series_ticker=KXNBAGAME&status=open&limit=200"
  )) as {
    markets?: Array<{
      ticker: string;
      title: string;
      subtitle?: string;
      event_ticker: string;
      status: string;
      yes_bid_dollars?: string;
      yes_ask_dollars?: string;
      no_bid_dollars?: string;
      no_ask_dollars?: string;
      last_price_dollars?: string;
      volume?: number;
      open_interest?: number;
    }>;
  };

  if (!data.markets) return [];

  return data.markets.map((m) => ({
    ticker: m.ticker,
    title: m.title,
    subtitle: m.subtitle,
    eventTicker: m.event_ticker,
    status: m.status,
    yesBid: m.yes_bid_dollars ? parseFloat(m.yes_bid_dollars) : undefined,
    yesAsk: m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : undefined,
    noBid: m.no_bid_dollars ? parseFloat(m.no_bid_dollars) : undefined,
    noAsk: m.no_ask_dollars ? parseFloat(m.no_ask_dollars) : undefined,
    lastPrice: m.last_price_dollars
      ? parseFloat(m.last_price_dollars)
      : undefined,
    volume: m.volume,
    openInterest: m.open_interest,
  }));
}

/**
 * Place a limit order on Kalshi.
 */
export async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  count: number,
  priceDollars: string
): Promise<OrderResult> {
  const priceField =
    side === "yes" ? "yes_price_dollars" : "no_price_dollars";

  const data = (await kalshiRequest(
    "POST",
    "/trade-api/v2/portfolio/orders",
    undefined,
    {
      ticker,
      side,
      action: "buy",
      count,
      [priceField]: priceDollars,
      type: "limit",
    }
  )) as {
    order: {
      order_id: string;
      ticker: string;
      status: string;
      side: string;
      action: string;
      fill_count?: number;
      remaining_count?: number;
    };
  };

  return {
    orderId: data.order.order_id,
    ticker: data.order.ticker,
    status: data.order.status,
    side: data.order.side,
    action: data.order.action,
    fillCount: data.order.fill_count ?? null,
    remainingCount: data.order.remaining_count ?? null,
  };
}
