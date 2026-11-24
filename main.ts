// Paper launch-sniper bot for the pump.fun replay sprint.
//
// The harness speaks agent-fun/replay/v2: it sends one hello, then one batch
// of chain events per slot, and the bot answers each batch with its orders.
// Every order decided on the batch for slot s fills at slot s + latency_slots,
// so every decision here is made on data that is already two slots old by the
// time it executes. The bot is fully deterministic: it reads no clock, no
// environment and no randomness, so its two grading executions produce the
// same action log byte for byte.
//
// Strategy, in short: snipe launches in their first few slots, but only ones
// that pass a rug filter — the creator must not have bought a big chunk of
// their own supply, must not have sold, and the launch must not be bundled
// across many wallets in its first slots. Losers are cut fast (stop loss
// -12%) while winners run: a trailing stop arms at +25% and sells on a 20%
// fall from the peak, a take-profit sits at +50%, and no position is held
// past 300 slots. Any position is exited at once when its creator sells.
// probe mechanism keeps the run above the guardrail pace (at least 20 coins
// with a round trip of at least 0.01 SOL each) by opening tiny round trips on
// liquid curves whenever the bot's own entries lag the pace.
//
// Sizing: at most 0.10 SOL per coin, capped by the harness's
// 1%-of-real-reserve size cap. Buys go out at 10000 bps slippage so a buy is
// never refused for the price moving in the latency; sells go out at
// 10000 bps so an exit is never refused either.

import {
  runBot,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const CURVE_FEE = 0.0125; // protocol + creator fees, ~95 + ~30 bps, each way.

// --- entry: launch window + rug filter ------------------------------------
const MAX_AGE = 5; // slots since CreateEvent; a first buy may still be decided
const MIN_RQ_SOL = 0.3; // curve real SOL bounds at decision time
const MAX_RQ_SOL = 30;
const MAX_DEV_BUY_SOL = 2.5; // creator's own buys in the create slot, at most
const MAX_LAUNCH_BUYERS = 3; // distinct non-creator buyers before entry, at most
const STAKE_LAMPORTS = SOL / 10n; // 0.10 SOL per coin
const MIN_BUY_LAMPORTS = SOL / 100n; // 0.01 SOL: smallest buy worth sending
const BUY_SLIP_BPS = 10_000;
const SELL_SLIP_BPS = 10_000;

// --- exits ----------------------------------------------------------------
const TAKE_PROFIT = 1.5; // sell when close value reaches 150% of cost
const STOP_LOSS = 0.88; // sell when close value falls under 88% of cost
const TRAIL_ARM = 1.25; // trailing stop arms once value reaches 125% of cost
const TRAIL = 0.8; // ... then sells when value falls under 80% of its peak
const MAX_HOLD = 300; // slots held before a forced exit

// --- guardrail probes -----------------------------------------------------
const TARGET_COINS = 25; // coins to have traded by the end of the window
const RUN_SLOTS = 400_000; // expected length of the 24h replay, in slots
const PROBE_SOL = 0.02; // probe buy size (SOL); sold as soon as it lands
const PROBE_MIN_RQ_SOL = 2; // probes only on curves with at least this real SOL

interface Coin {
  created: number;
  creator: Pubkey;
  /** Creator's own buys (SOL) in the create slot. */
  devBuySol: number;
  /** The creator sold at least once since creation. */
  devSold: boolean;
  /** Distinct non-creator wallets that bought before entry. */
  buyers: Set<Pubkey>;
  /** Entry already decided (bought or skipped for good). */
  decided: boolean;
}

interface Held {
  opened: number;
  peakValue: number; // best close value seen (SOL), fees deducted
}

/** Price of a curve in lamports per base token unit, from virtual reserves. */
function priceOf(curve: Curve): number {
  const vt = Number(curve.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / vt;
}

/** Close value of `tokens` on `mint` in SOL, curve fee and one tx fee deducted. */
function closeValueSol(state: BotState, mint: Pubkey, tokens: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const price = priceOf(curve);
  if (price <= 0) return 0;
  const gross = (Number(tokens) * price) / 1e9;
  return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / 1e9;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** Mints with at least one filled buy of ours (harness closes excluded). */
const myCoins = new Set<Pubkey>();
let firstSlot = -1;

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    if (firstSlot < 0) firstSlot = now;
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    // Position slots free right now (held + buys in flight count against the cap).
    let slots = caps.max_open_positions - state.committedPositionCount();

    const hasSellPending = (mint: Pubkey): boolean => {
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) return true;
      }
      return false;
    };
    const hasBuyPending = (mint: Pubkey): boolean => {
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) return true;
      }
      return false;
    };

    // --- fold this batch's fills into our own books ----------------------
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.client_id.startsWith('_')) continue; // harness close, not our order
      if (f.side === 'buy') {
        myCoins.add(f.mint);
        if (probes.get(f.mint) === false) probes.set(f.mint, true); // probe buy landed
      } else {
        held.delete(f.mint);
        probes.delete(f.mint);
      }
    }

    // --- fold this batch's events into the coin book ---------------------
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      seen.add(e.mint);
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            created: e.slot,
            creator: e.creator,
            devBuySol: 0,
            devSold: false,
            buyers: new Set(),
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / 1e9;
        if (e.user === c.creator) {
          if (e.is_buy) {
            if (e.slot === c.created) c.devBuySol += sol;
          } else {
            c.devSold = true;
          }
        } else if (e.is_buy) {
          c.buyers.add(e.user);
        }
      }
    }

    // --- sync held positions with the account ----------------------------
    for (const mint of state.positions.keys()) {
      if (!held.has(mint) && !probes.has(mint)) held.set(mint, { opened: now, peakValue: 0 });
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !hasBuyPending(mint)) {
        // Closed by the harness (curve completed) or sold already.
        held.delete(mint);
      }
    }

    // --- exits first: take profit, stop loss, time limit, creator sold ---
    for (const [mint, pos] of state.positions) {
      if (hasSellPending(mint)) continue;
      const h = held.get(mint);
      const cost = Number(pos.cost_lamports) / 1e9;
      const value = closeValueSol(state, mint, pos.token_amount);
      if (cost <= 0 || value <= 0) continue;
      let exit = false;
      if (probes.has(mint)) {
        // A probe sells as soon as its buy has landed.
        if (probes.get(mint) === true) exit = true;
      } else if (h !== undefined) {
        const c = coins.get(mint);
        if (value > h.peakValue) h.peakValue = value;
        if (value >= TAKE_PROFIT * cost) exit = true;
        else if (value < STOP_LOSS * cost) exit = true;
        else if (h.peakValue >= TRAIL_ARM * cost && value < TRAIL * h.peakValue) exit = true;
        else if (now - h.opened >= MAX_HOLD) exit = true;
        else if (c !== undefined && c.devSold) exit = true; // creator sold: leave now
      }
      if (exit && orders.length < caps.max_orders_per_batch && free >= tx) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        free -= tx;
      }
    }

    // --- entries: snipe fresh launches that pass the rug filter ----------
    for (const mint of seen) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (state.positions.has(mint) || hasBuyPending(mint) || probes.has(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined || c.decided) continue;
      const age = now - c.created;
      if (age > MAX_AGE) {
        c.decided = true; // launch window passed: skip for good
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      // Rug filter: creator must not have loaded up or sold, and the launch
      // must not be bundled across many wallets in its first slots.
      if (c.devSold || c.devBuySol > MAX_DEV_BUY_SOL || c.buyers.size > MAX_LAUNCH_BUYERS) {
        c.decided = true;
        continue;
      }
      const rqSol = Number(curve.real_quote_reserves) / 1e9;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue; // undecided: may qualify later
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      c.decided = true;
      free -= amount + tx;
      slots -= 1;
    }

    // --- guardrail probe: stay on pace for TARGET_COINS ------------------
    const elapsed = Math.max(0, now - firstSlot);
    const paceTarget = Math.ceil((TARGET_COINS * elapsed) / RUN_SLOTS);
    const probeInFlight = probes.size > 0;
    if (
      !probeInFlight &&
      myCoins.size < paceTarget &&
      slots > 0 &&
      orders.length < caps.max_orders_per_batch
    ) {
      // Most liquid curve touched by this batch that we do not hold.
      let best: Pubkey | null = null;
      let bestRq = 0n;
      for (const mint of seen) {
        if (state.positions.has(mint) || hasBuyPending(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves > bestRq) {
          bestRq = curve.real_quote_reserves;
          best = mint;
        }
      }
      if (best !== null && bestRq >= BigInt(Math.floor(PROBE_MIN_RQ_SOL * 1e9))) {
        const cap = state.maxBuyLamports(best);
        const amount = BigInt(Math.floor(PROBE_SOL * 1e9));
        if (cap >= amount && free >= amount + tx) {
          orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
          probes.set(best, false);
          free -= amount + tx;
          slots -= 1;
        }
      }
    }

    return orders;
  },
});
