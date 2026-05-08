import { GLOBAL_TX_PROCESS, TxProcess } from "../constant";
import { Market } from "../types";
import {
    openClawPositionFromHoldingStatus,
} from "./openclawDecision";
import { getOpenClawDecision } from "./openclawStrategy";
import { divider } from "../utils";

// Declare module augmentation to add cancel method to Trade class
declare module "./index" {
    interface Trade {
        make_trading_decision(): void;
    }
}

// Function to attach methods to Trade class (called from index.ts)
export function attachDecisionMethods(TradeClass: new (...args: any[]) => any) {
    TradeClass.prototype.make_trading_decision = async function (): Promise<void> {

        let remaining_time_ratio =
            (this.marketTime - this.remainingTime) / this.marketTime;

        let up_price_ratio = Math.abs(this.upBuyPrice - 0.5) / 0.5;

        if (this.prevUpBuyPrice[0] || this.prevUpBuyPrice[1]) {
            Market.None;
        }

        if (GLOBAL_TX_PROCESS.current === TxProcess.Working) {
            console.log("Trading is already in progress");
            return;
        };

        const openclawEnabled = Boolean(globalThis.__CONFIG__?.openclaw?.enabled);
        const openclawContext = {
            prices: {
                ts: Date.now(),
                up_buy: this.upBuyPrice,
                up_sell: this.upSellPrice,
                down_buy: this.downBuyPrice,
                down_sell: this.downSellPrice,
            },
            history: this.openclawHistory?.values?.() ?? [],
            timeToExpirySec: this.remainingTime,
            position: openClawPositionFromHoldingStatus(this.holdingStatus),
            trend: this.trending(),
            config: {
                min_edge_bps: globalThis.__CONFIG__.openclaw.min_edge_bps,
                max_spread_bps: globalThis.__CONFIG__.openclaw.max_spread_bps,
                lookback_points: globalThis.__CONFIG__.openclaw.lookback_points,
            },
        };

        const openclawDecisionResult = openclawEnabled
            ? await getOpenClawDecision(openclawContext, globalThis.__CONFIG__.openclaw as unknown as any)
            : null;
        const openclawDecision = openclawDecisionResult?.decision ?? null;

        if (openclawEnabled && openclawDecision) {
            const source = openclawDecisionResult?.source ?? "deterministic";
            const tag = openclawDecision.type === "HOLD" ? "OpenClaw" : "OpenClaw SIGNAL";
            console.log(divider(tag));
            console.log(`🧠 source=${source} | action=${openclawDecision.type}`);
            console.log(`reason: ${openclawDecision.reason}`);
        }

        switch (globalThis.__CONFIG__.strategy) {
            case "trade_1": {
                const exitTime = remaining_time_ratio > globalThis.__CONFIG__.trade_1.exit_time_ratio;
                const exitPrice = up_price_ratio > globalThis.__CONFIG__.trade_1.exit_price_ratio;
                const openclawWantsClose = openclawDecision?.type === "CLOSE_POSITION";
                if (exitTime || exitPrice || openclawWantsClose) {
                    switch (this.holdingStatus) {
                        case Market.Up:
                            await this.sellUpToken();
                            break;
                        case Market.Down:
                            await this.sellDownToken();
                            break;
                        default:
                            break;
                    }
                }
                break;
            }

            case "trade_2":
                const exitRanges = globalThis.__CONFIG__.trade_2.exit_price_ratio_range;
                const inExitRange = exitRanges.some(([min, max]) => up_price_ratio >= min && up_price_ratio <= max);
                const [entry_price_ratio_min, entry_price_ratio_max] = globalThis.__CONFIG__.trade_2.entry_price_ratio;
                const entry_time_ratio = globalThis.__CONFIG__.trade_2.entry_time_ratio;
                const inEntryPriceRange = up_price_ratio >= entry_price_ratio_min && up_price_ratio <= entry_price_ratio_max;

                switch (this.holdingStatus) {
                    case Market.Up:
                        if (inExitRange || openclawDecision?.type === "CLOSE_POSITION") {
                            const sellSuccess = await this.sellUpToken();

                            if (sellSuccess) {
                                // Check if in emergency swap price range to immediately buy opposite token
                                const emergencySwapPrice = globalThis.__CONFIG__.trade_2.emergency_swap_price;
                                if (emergencySwapPrice) {
                                    const [emergencyMin, emergencyMax] = emergencySwapPrice;
                                    const inEmergencySwapRange = up_price_ratio >= emergencyMin && up_price_ratio <= emergencyMax;
                                    if (inEmergencySwapRange) {
                                        console.log("🔄 Emergency swap: buying down token after successful sell");
                                        await this.buyDownToken();
                                    }
                                }
                            } else {
                                console.warn("⚠️  Sell failed, skipping emergency swap buy");
                            }
                        }
                        break;
                    case Market.Down:
                        if (inExitRange || openclawDecision?.type === "CLOSE_POSITION") {
                            const sellSuccess = await this.sellDownToken();

                            // Only proceed with emergency buy if sell was successful
                            if (sellSuccess) {
                                // Check if in emergency swap price range to immediately buy opposite token
                                const emergencySwapPrice = globalThis.__CONFIG__.trade_2.emergency_swap_price;
                                if (emergencySwapPrice) {
                                    const [emergencyMin, emergencyMax] = emergencySwapPrice;
                                    const inEmergencySwapRange = up_price_ratio >= emergencyMin && up_price_ratio <= emergencyMax;
                                    if (inEmergencySwapRange) {
                                        console.log("🔄 Emergency swap: buying up token after successful sell");
                                        await this.buyUpToken();
                                    }
                                }
                            } else {
                                console.warn("⚠️  Sell failed, skipping emergency swap buy");
                            }
                        }
                        break;

                    default: {
                        const cooldownDone = Date.now() >= this.entryBuyCooldownUntil;
                        // Only buy if we haven't bought yet
                        // Check if price ratio is within entry range and time ratio is met
                        if (
                            !this.hasBought &&
                            cooldownDone &&
                            remaining_time_ratio > entry_time_ratio &&
                            inEntryPriceRange
                        ) {
                            if (openclawDecision?.type === "BUY_UP") {
                                await this.buyUpToken();
                            } else if (openclawDecision?.type === "BUY_DOWN") {
                                await this.buyDownToken();
                            } else {
                                // Preserve existing behavior when OpenClaw is disabled or has no strong signal.
                                if (this.upBuyPrice > this.downBuyPrice) {
                                    await this.buyUpToken();
                                } else {
                                    await this.buyDownToken();
                                }
                            }
                        } else if (openclawEnabled && (openclawDecision?.type === "BUY_UP" || openclawDecision?.type === "BUY_DOWN")) {
                            const reasons: string[] = [];
                            if (this.hasBought) reasons.push("hasBought=true");
                            if (!cooldownDone) reasons.push("cooldown active");
                            if (!(remaining_time_ratio > entry_time_ratio)) reasons.push("entry_time gate");
                            if (!inEntryPriceRange) reasons.push("entry_price gate");
                            if (reasons.length) {
                                console.log(`🛑 OpenClaw suggestion rejected by gates: ${reasons.join(", ")}`);
                            }
                        }
                        break;
                    }
                }



                break;
            default:
                break;
        }


    };
}