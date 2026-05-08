import { Market } from "../types";

export type OpenClawDecision =
  | { type: "BUY_UP"; reason: string }
  | { type: "BUY_DOWN"; reason: string }
  | { type: "CLOSE_POSITION"; reason: string }
  | { type: "HOLD"; reason: string };

export interface OpenClawConfig {
  enabled: boolean;
  /** Minimum edge (basis points) required before acting. 50 bps = 0.50%. */
  min_edge_bps: number;
  /**
   * Max tolerated "pricing inconsistency" between UP/DOWN (basis points).
   * Used as a safety gate to avoid trading when the sum of mid prices drifts too far from 1.00.
   */
  max_spread_bps: number;
  /** How many recent points to keep in memory for deterministic trend/velocity heuristics. */
  lookback_points: number;
}

export type OpenClawPosition = "UP" | "DOWN" | "FLAT";

export interface OpenClawPriceSnapshot {
  ts: number; // epoch ms
  up_buy: number;
  up_sell: number;
  down_buy: number;
  down_sell: number;
}

export interface OpenClawContext {
  /** Latest quotes. */
  prices: OpenClawPriceSnapshot;
  /** Last N snapshots, most-recent last. */
  history: ReadonlyArray<OpenClawPriceSnapshot>;
  /** Seconds remaining in the market window (best-effort). */
  timeToExpirySec?: number;
  /** Current held position. */
  position: OpenClawPosition;
  /** Existing bot trend signal (UP/DOWN/FLAT) for deterministic tie-breaking. */
  trend: Market;
  /** Tunables from `trade.toml`. */
  config: Pick<OpenClawConfig, "min_edge_bps" | "max_spread_bps" | "lookback_points">;
}

/**
 * Placeholder interface for external reference pricing.
 * Not used by the initial deterministic implementation, but kept here so the decision engine
 * can be extended without coupling to a specific feed vendor.
 */
export interface ExternalPriceFeed {
  getBtcPrice(): Promise<number>;
}

/**
 * A tiny ring buffer for recent price snapshots.
 * Intentionally simple so it remains testable and dependency-free.
 */
export class PriceRingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}

  push(value: T) {
    if (this.capacity <= 0) return;
    if (this.buf.length >= this.capacity) this.buf.shift();
    this.buf.push(value);
  }

  values(): ReadonlyArray<T> {
    return this.buf;
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function isValidPrice(p: number): boolean {
  return Number.isFinite(p) && p > 0 && p < 1.01;
}

function bps(x: number): number {
  return x * 10_000;
}

function positionFromMarket(m: Market): OpenClawPosition {
  if (m === Market.Up) return "UP";
  if (m === Market.Down) return "DOWN";
  return "FLAT";
}

function inferredDirectionFromHistory(
  history: ReadonlyArray<OpenClawPriceSnapshot>
): Market {
  if (history.length < 4) return Market.None;
  const a = history[history.length - 4];
  const b = history[history.length - 1];
  const midUpA = (a.up_buy + a.up_sell) / 2;
  const midUpB = (b.up_buy + b.up_sell) / 2;
  if (!Number.isFinite(midUpA) || !Number.isFinite(midUpB)) return Market.None;
  const delta = midUpB - midUpA;
  if (Math.abs(delta) < 0.002) return Market.None; // ~20 bps
  return delta > 0 ? Market.Up : Market.Down;
}

/**
 * OpenClaw-style deterministic decision engine.
 *
 * Inputs:
 * - Latest UP/DOWN quotes + optional recent history (in-memory ring buffer)
 * - Time-to-expiry and current position/trend
 * - Config thresholds (min edge, max spread)
 *
 * Output:
 * - A single high-level action with an explicit, operator-friendly reason string.
 *
 * How to extend:
 * - Add new heuristics (e.g. external BTC reference) as additional "signals"
 * - Keep each signal deterministic + explainable (produce intermediate metrics in reason)
 * - Keep this function pure (no network calls); inject external data into `OpenClawContext`
 */
export function decideWithOpenClaw(ctx: OpenClawContext): OpenClawDecision {
  const { prices, history, trend } = ctx;

  const upBuy = clamp01(prices.up_buy);
  const upSell = clamp01(prices.up_sell);
  const downBuy = clamp01(prices.down_buy);
  const downSell = clamp01(prices.down_sell);

  if (
    !isValidPrice(upBuy) ||
    !isValidPrice(upSell) ||
    !isValidPrice(downBuy) ||
    !isValidPrice(downSell)
  ) {
    return { type: "HOLD", reason: "invalid price(s) in context" };
  }

  const midUp = (upBuy + upSell) / 2;
  const midDown = (downBuy + downSell) / 2;
  const sumMid = midUp + midDown;
  const overroundBps = bps(sumMid - 1.0);

  const maxSpreadBps = ctx.config.max_spread_bps;
  if (Math.abs(overroundBps) > maxSpreadBps) {
    return {
      type: "HOLD",
      reason: `pricing inconsistency: midSum=${sumMid.toFixed(4)} (overround=${overroundBps.toFixed(
        0
      )} bps) > max_spread_bps ${maxSpreadBps}`,
    };
  }

  const minEdgeBps = ctx.config.min_edge_bps;

  // When the pair is "expensive" relative to 1.00, prefer de-risking (close) if we hold a position.
  if (ctx.position !== "FLAT" && overroundBps >= minEdgeBps) {
    return {
      type: "CLOSE_POSITION",
      reason: `close: midSum=${sumMid.toFixed(4)} overround=${overroundBps.toFixed(
        0
      )} bps >= min_edge_bps ${minEdgeBps}`,
    };
  }

  // When the pair is "cheap" relative to 1.00, look for a directional entry.
  if (ctx.position === "FLAT" && overroundBps <= -minEdgeBps) {
    const histTrend = inferredDirectionFromHistory(history);
    const bias = histTrend !== Market.None ? histTrend : trend;

    const preferred =
      bias === Market.Up
        ? Market.Up
        : bias === Market.Down
          ? Market.Down
          : midUp <= midDown
            ? Market.Up
            : Market.Down;

    if (preferred === Market.Up) {
      return {
        type: "BUY_UP",
        reason: `buy_up: midSum=${sumMid.toFixed(4)} overround=${overroundBps.toFixed(
          0
        )} bps <= -min_edge_bps ${minEdgeBps}; bias=${Market[preferred] ?? "Up"}`,
      };
    }
    return {
      type: "BUY_DOWN",
      reason: `buy_down: midSum=${sumMid.toFixed(4)} overround=${overroundBps.toFixed(
        0
      )} bps <= -min_edge_bps ${minEdgeBps}; bias=${Market[preferred] ?? "Down"}`,
    };
  }

  // Default: no strong edge detected.
  return {
    type: "HOLD",
    reason: `hold: midSum=${sumMid.toFixed(4)} overround=${overroundBps.toFixed(
      0
    )} bps within thresholds`,
  };
}

export function openClawPositionFromHoldingStatus(holdingStatus: Market): OpenClawPosition {
  return positionFromMarket(holdingStatus);
}

