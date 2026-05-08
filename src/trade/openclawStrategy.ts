import { Market } from "../types";
import {
  decideWithOpenClaw,
  type OpenClawConfig,
  type OpenClawContext,
  type OpenClawDecision,
} from "./openclawDecision";

export type OpenClawMode = "deterministic" | "http";

export type OpenClawHttpConfig = {
  /** Full URL to an OpenClaw-compatible decision endpoint. */
  url: string;
  /** Optional bearer token; if omitted, request is sent unauthenticated. */
  bearer_token?: string;
  /** Request timeout in milliseconds. */
  timeout_ms: number;
};

export type OpenClawRuntimeConfig = OpenClawConfig & {
  mode: OpenClawMode;
  http?: OpenClawHttpConfig;
};

type OpenClawHttpResponse =
  | { type: "BUY_UP" | "BUY_DOWN" | "CLOSE_POSITION" | "HOLD"; reason?: string; confidence?: number }
  | { action: "BUY_UP" | "BUY_DOWN" | "CLOSE_POSITION" | "HOLD"; reason?: string; confidence?: number };

function normalizeDecision(payload: OpenClawHttpResponse): OpenClawDecision | null {
  const type = ("type" in payload ? payload.type : payload.action) as OpenClawDecision["type"];
  if (!type) return null;
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : "no reason provided";
  switch (type) {
    case "BUY_UP":
      return { type: "BUY_UP", reason };
    case "BUY_DOWN":
      return { type: "BUY_DOWN", reason };
    case "CLOSE_POSITION":
      return { type: "CLOSE_POSITION", reason };
    case "HOLD":
      return { type: "HOLD", reason };
    default:
      return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`OpenClaw HTTP timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((v) => {
        clearTimeout(id);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(id);
        reject(e);
      });
  });
}

/**
 * OpenClaw decision entrypoint used by the bot.
 *
 * - deterministic: always uses local explainable rules (no network).
 * - http: tries an external service; falls back to deterministic on any error.
 *
 * The bot stays safe-by-default: unless enabled + configured, this returns deterministic decisions only.
 */
export async function getOpenClawDecision(
  ctx: OpenClawContext,
  cfg: OpenClawRuntimeConfig
): Promise<{ decision: OpenClawDecision; source: "deterministic" | "http" | "fallback" }> {
  if (!cfg.enabled) {
    return { decision: { type: "HOLD", reason: "openclaw disabled" }, source: "deterministic" };
  }

  if (cfg.mode !== "http") {
    return { decision: decideWithOpenClaw(ctx), source: "deterministic" };
  }

  const http = {
    url: process.env.OPENCLAW_HTTP_URL?.trim() || cfg.http?.url || "",
    bearer_token:
      process.env.OPENCLAW_HTTP_BEARER_TOKEN?.trim() || cfg.http?.bearer_token,
    timeout_ms: Number(process.env.OPENCLAW_HTTP_TIMEOUT_MS ?? "") || cfg.http?.timeout_ms || 2500,
  } satisfies OpenClawHttpConfig;
  if (!http?.url) {
    return { decision: decideWithOpenClaw(ctx), source: "fallback" };
  }

  try {
    const body = {
      version: "openclaw.v1",
      market: {
        // Useful for multi-process setups (5m vs 15m, etc.)
        period_sec: ctx.timeToExpirySec,
      },
      context: {
        position: ctx.position,
        trend: Market[ctx.trend] ?? String(ctx.trend),
        timeToExpirySec: ctx.timeToExpirySec,
      },
      quotes: ctx.prices,
      history: ctx.history,
      thresholds: ctx.config,
      // The service can ignore anything it doesn't use.
    };

    const res = await withTimeout(
      fetch(http.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(http.bearer_token ? { authorization: `Bearer ${http.bearer_token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      http.timeout_ms
    );

    if (!res.ok) {
      throw new Error(`OpenClaw HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as OpenClawHttpResponse;
    const normalized = normalizeDecision(json);
    if (!normalized) {
      throw new Error("OpenClaw HTTP response could not be normalized");
    }
    return { decision: normalized, source: "http" };
  } catch {
    // Never allow OpenClaw network errors to break the market loop; always fall back.
    return { decision: decideWithOpenClaw(ctx), source: "fallback" };
  }
}

