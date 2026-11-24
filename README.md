# pumpfun-paper-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ifulchina-ops/pumpfun-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ifulchina-ops/pumpfun-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Launch sniper with a rug filter and fast exits. The bot watches every coin from its CreateEvent and buys in its first few slots — but only launches that pass the filter: the creator must not have bought a big chunk of their own supply, must not have sold, and the launch must not be bundled across many wallets in its first slots. Each coin gets at most 0.10 SOL, capped by the harness's 1%-of-real-reserve size cap.

Exits are fast: take-profit at 115% of cost, stop loss at 88%, at most 15 slots held, and an immediate exit when the coin's creator sells. A separate probe mechanism keeps the run above the guardrail pace (20+ coins with a round trip of at least 0.01 SOL each) by opening tiny 0.02 SOL round trips on liquid curves whenever entries lag the pace.

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
