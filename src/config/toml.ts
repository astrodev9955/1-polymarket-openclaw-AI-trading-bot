import * as fs from "fs";
import * as TOML from "@iarna/toml";
import { z } from "zod";

const ConfigSchema = z.object({
  strategy: z.enum(["trade_1", "trade_2"]),
  trade_usd: z.number(),
  max_retries: z.number().default(3),
  /** After a failed entry buy, wait this many seconds before trying entry again (same market window). */
  entry_buy_cooldown_sec: z.number().min(0).default(25),
  openclaw: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Decision source:
       * - deterministic: local explainable rules (default)
       * - http: call external OpenClaw/LLM service (falls back to deterministic on any error)
       */
      mode: z.enum(["deterministic", "http"]).default("deterministic"),
      min_edge_bps: z.number().min(0).default(50),
      max_spread_bps: z.number().min(0).default(200),
      lookback_points: z.number().int().min(1).default(12),
      http: z
        .object({
          url: z.string().min(1),
          bearer_token: z.string().min(1).optional(),
          timeout_ms: z.number().int().min(250).default(2500),
        })
        .optional(),
    })
    .default({
      enabled: false,
      mode: "deterministic",
      min_edge_bps: 50,
      max_spread_bps: 200,
      lookback_points: 12,
    }),
  market: z.object({
    market_coin: z.enum(["btc", "eth", "sol", "xrp"]),
    market_period: z.enum(["5", "15", "60", "240", "1440"]),
  }),
  trade_1: z.object({
    entry_price_range: z.tuple([z.number(), z.number()]),
    swap_price_range: z.tuple([z.number(), z.number()]),
    take_profit: z.number(),
    stop_loss: z.number(),
    exit_time_ratio: z.number(),
    exit_price_ratio: z.number(),
  }),
  trade_2: z.object({
    entry_price_ratio: z.tuple([z.number(), z.number()]),
    entry_time_ratio: z.number(),
    exit_price_ratio_range: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
    emergency_swap_price: z.tuple([z.number(), z.number()]).optional(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

declare global {
  // makes config globally accessible
  var __CONFIG__: Config;
}

export function loadConfig(path = "trade.toml"): Config {
  if (!globalThis.__CONFIG__) {
    const raw = TOML.parse(fs.readFileSync(path, "utf-8"));
    globalThis.__CONFIG__ = ConfigSchema.parse(raw);
  }
  return globalThis.__CONFIG__;
}