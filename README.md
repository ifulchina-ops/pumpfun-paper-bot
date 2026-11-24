# pumpfun-paper-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ifulchina-ops/pumpfun-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ifulchina-ops/pumpfun-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Momentum entries with fast exits. The bot buys a curve only once it already shows real buy pressure: net SOL flowing in over the last 40 slots, at least 3 buys from at least 4 distinct wallets, price up and sitting near its window high, with inflow accelerating. Each position is at most 0.35 SOL, one buy per entry, capped by the harness's 1%-of-real-reserve size cap.

Exits are fast: a stop loss at 82% of cost, a take-profit at 170%, a trailing stop that arms at 112% of cost, a fade exit when net flow turns negative, and a 1,800-slot time limit. A separate probe mechanism keeps the run above the guardrail pace (20+ coins with a round trip of at least 0.01 SOL each) by opening tiny 0.02 SOL round trips on liquid curves whenever entries lag the pace.

The bot is fully deterministic — no clock, no environment, no randomness — so its two grading executions produce identical action logs.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. The bot speaks agent-fun/replay/v2 on stdin/stdout via the vendored SDK shim in `vendor/makefun-bot.ts` (a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

## Layout

- `main.ts` — the entrypoint: tape tracking, entry signal, exits, probes.
- `vendor/makefun-bot.ts` — the kit's bot shim (protocol, state, order validation).
- `.makefun/owner.json` — the claim file naming the payout wallet.

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).</sub>
