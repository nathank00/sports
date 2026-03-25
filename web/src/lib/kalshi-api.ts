import { signKalshiRequest, loadCryptoKey, loadKeyId } from "./kalshi-crypto";
import type {
  KalshiMarket,
  OrderResult,
  PositionItem,
  SettlementItem,
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
 * Shape returned by Kalshi positions endpoints.
 * Kalshi uses _fp (string) suffixed fields for decimal values,
 * e.g. position_fp: "3.00" instead of position: 3.
 */
interface KalshiMarketPosition {
  ticker: string;
  // Kalshi returns BOTH integer cents and string dollar fields.
  // The _fp / _dollars string fields are the reliable ones.
  position?: number;
  position_fp?: string;
  market_exposure?: number;
  market_exposure_dollars?: string;
  market_exposure_fp?: string;
  total_traded?: number;
  total_traded_dollars?: string;
  total_traded_fp?: string;
  realized_pnl?: number;
  realized_pnl_dollars?: string;
  realized_pnl_fp?: string;
  fees_paid?: number;
  fees_paid_dollars?: string;
  fees_paid_fp?: string;
  resting_orders_count?: number;
}

function mapPositions(raw: KalshiMarketPosition[]): PositionItem[] {
  return raw.map((p) => ({
    ticker: p.ticker,
    // position_fp is the source of truth (e.g. "3.00")
    position: p.position_fp
      ? parseFloat(p.position_fp)
      : (p.position ?? 0),
    exposure: p.market_exposure_fp
      ? parseFloat(p.market_exposure_fp)
      : p.market_exposure_dollars
        ? parseFloat(p.market_exposure_dollars)
        : (p.market_exposure ?? 0) / 100,
    totalTraded: p.total_traded_fp
      ? parseFloat(p.total_traded_fp)
      : p.total_traded_dollars
        ? parseFloat(p.total_traded_dollars)
        : (p.total_traded ?? 0) / 100,
    realizedPnl: p.realized_pnl_fp
      ? parseFloat(p.realized_pnl_fp)
      : p.realized_pnl_dollars
        ? parseFloat(p.realized_pnl_dollars)
        : (p.realized_pnl ?? 0) / 100,
    feesPaid: p.fees_paid_fp
      ? parseFloat(p.fees_paid_fp)
      : p.fees_paid_dollars
        ? parseFloat(p.fees_paid_dollars)
        : (p.fees_paid ?? 0) / 100,
    restingOrders: p.resting_orders_count ?? 0,
  }));
}

/**
 * Fetch the user's positions.
 * count_filter=position,total_traded is REQUIRED — without it Kalshi
 * does not populate the position field.
 * This is the same query the terminal dashboard uses successfully.
 */
export async function fetchPositions(): Promise<PositionItem[]> {
  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/portfolio/positions",
    "limit=200&count_filter=position,total_traded"
  )) as { market_positions?: KalshiMarketPosition[] };

  if (!data.market_positions) return [];
  return mapPositions(data.market_positions);
}

/**
 * Fetch settlements (closed positions) within a date range.
 * @param minTs - Unix epoch seconds (integer string) for the start of the range
 * @param maxTs - Unix epoch seconds (integer string) for the end of the range
 */
export async function fetchSettlements(
  minTs?: string,
  maxTs?: string
): Promise<SettlementItem[]> {
  const params = new URLSearchParams({ limit: "200" });
  if (minTs) params.set("min_ts", minTs);
  if (maxTs) params.set("max_ts", maxTs);

  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/portfolio/settlements",
    params.toString()
  )) as {
    settlements?: Array<{
      ticker: string;
      event_ticker: string;
      market_result: string;
      yes_count?: number;
      no_count?: number;
      // revenue is in cents (integer)
      revenue?: number;
      // fee_cost is a dollar string (e.g., "0.0500")
      fee_cost?: string;
      settled_time: string;
      // Additional fields from API
      yes_total_cost?: number;
      no_total_cost?: number;
      value?: number;
    }>;
  };

  if (!data.settlements) return [];

  return data.settlements.map((s) => {
    // revenue = gross payout (cents), yes/no_total_cost = what was paid (cents)
    // Net P&L = payout - cost
    const payout = s.revenue ?? 0;
    const cost = (s.yes_total_cost ?? 0) + (s.no_total_cost ?? 0);
    const netPnl = (payout - cost) / 100;

    return {
      ticker: s.ticker,
      eventTicker: s.event_ticker,
      marketResult: s.market_result,
      yesCount: s.yes_count ?? 0,
      noCount: s.no_count ?? 0,
      // Net P&L in dollars (negative for losses)
      revenue: netPnl,
      // fee_cost is a dollar string → parse directly
      feesPaid: s.fee_cost ? parseFloat(s.fee_cost) : 0,
      settledTime: s.settled_time,
    };
  });
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
 * Fetch open MLB game markets from Kalshi.
 * Same as fetchNbaMarkets but for MLB series ticker.
 */
export async function fetchMlbMarkets(): Promise<KalshiMarket[]> {
  const data = (await kalshiRequest(
    "GET",
    "/trade-api/v2/markets",
    "series_ticker=KXMLBGAME&status=open&limit=200"
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
 * Place a limit order on Kalshi with a 30-second expiration.
 * The expiration prevents resting orders from accumulating if the market moves.
 *
 * @param action - "buy" to open a position, "sell" to close an existing one
 */
export async function placeOrder(
  ticker: string,
  side: "yes" | "no",
  count: number,
  priceDollars: string,
  action: "buy" | "sell" = "buy"
): Promise<OrderResult> {
  const priceField =
    side === "yes" ? "yes_price_dollars" : "no_price_dollars";

  // Expire the order after 30 seconds so it doesn't sit as a resting order
  const expirationTs = Math.floor(Date.now() / 1000) + 30;

  const data = (await kalshiRequest(
    "POST",
    "/trade-api/v2/portfolio/orders",
    undefined,
    {
      ticker,
      side,
      action,
      count,
      [priceField]: priceDollars,
      type: "limit",
      expiration_ts: expirationTs,
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

/**
 * Place a sell order to close an existing position.
 * Convenience wrapper around placeOrder with action="sell".
 */
export async function sellOrder(
  ticker: string,
  side: "yes" | "no",
  count: number,
  priceDollars: string
): Promise<OrderResult> {
  return placeOrder(ticker, side, count, priceDollars, "sell");
}

