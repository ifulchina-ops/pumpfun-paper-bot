// Paper momentum bot for the pump.fun replay sprint.
//
// The harness speaks agent-fun/replay/v2: it sends one hello, then one batch
// of chain events per slot, and the bot answers each batch with its orders.
// Every order decided on the batch for slot s fills at slot s + latency_slots,
// so every decision here is made on data that is already two slots old by the
// time it executes. The bot is fully deterministic: it reads no clock, no
// environment and no randomness, so its two grading executions produce the
// same action log byte for byte.
//
// Strategy, in short: buy bonding curves that ALREADY show real buy pressure
// (net SOL flowing in, several distinct buyers, price rising and sitting near
// its recent high), hold them briefly, and exit fast on a stop loss, a
// take-profit, a trailing stop, a fade in flow, or a time limit. A separate
// probe mechanism keeps the run above the guardrail pace (at least 20 coins
// with a round trip of at least 0.01 SOL each) by opening tiny round trips on
// liquid curves whenever the bot's own entries lag the pace.
//
// Sizing: one buy per entry, at most 0.35 SOL, capped by the harness's
// 1%-of-real-reserve size cap. At most 4 momentum positions at once; the
// 5th position slot is reserved for probes. Buys go out at 1500 bps slippage,
// sells at 10000 bps so an exit is never refused for the price moving.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const CURVE_FEE = 0.0125; // protocol + creator fees, ~95 + ~30 bps, each way.

// --- entry signal ---------------------------------------------------------
const WINDOW = 40; // slots of tape the entry signal looks at
const MIN_AGE = 300; // slots since CreateEvent before an entry is allowed
const MIN_NET_SOL = 0.75; // net buy SOL (buys minus sells) over the window
const MIN_BUYS = 3; // buy trades in the window
const MIN_BUYERS = 4; // distinct buying wallets in the window
const MIN_PRICE_UP = 0.04; // price now vs window start, minus 1
const MAX_PRICE_UP = 1.2; // skip curves that already ran too far in one window
const NEAR_HIGH = 0.92; // price now must be at least this share of window high
const MAX_BUYER_SHARE = 0.6; // largest single wallet's share of window buy SOL
const MIN_RQ_SOL = 1.5; // curve real SOL bounds at entry
const MAX_RQ_SOL = 70;
const COOLDOWN = 150; // slots to wait after an exit before re-entering a curve
const MAX_ENTRIES = 2; // most entries per curve over the run

// --- sizing ---------------------------------------------------------------
const STAKE_LAMPORTS = (SOL * 35n) / 100n; // 0.35 SOL per position
const MIN_BUY_LAMPORTS = SOL / 50n; // 0.02 SOL: smallest buy worth sending
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;
const MAX_MAIN = 4; // momentum positions; the 5th slot is for probes

// --- exits ----------------------------------------------------------------
const STOP_LOSS = 0.82; // sell when close value falls under 82% of cost
const TAKE_PROFIT = 1.7; // sell when close value reaches 170% of cost
const TRAIL_ARM = 1.12; // trailing stop arms once value reaches 112% of cost
const TRAIL = 0.78; // ... then sells when value falls under 78% of its peak
const MAX_HOLD = 1800; // slots held before a forced exit
const FADE_WINDOW = 25; // slots of tape the fade exit looks at
const FADE_NET_SOL = -1.0; // sell when net SOL over the fade window is below this

// --- guardrail probes -----------------------------------------------------
const TARGET_COINS = 25; // coins to have traded by the end of the window
const RUN_SLOTS = 400_000; // expected length of the 24h replay, in slots
const PROBE_SOL = 0.02; // probe buy size (SOL); sold as soon as it lands
const PROBE_MIN_RQ_SOL = 2; // probes only on curves with at least this real SOL

const KEEP = Math.max(WINDOW, FADE_WINDOW) + 10; // slots of tape kept per curve

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number; // best close value seen (SOL), fees deducted
  exiting: boolean;
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

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** Mints with at least one filled buy of ours (harness closes excluded). */
const myCoins = new Set<Pubkey>();
let firstSlot = -1;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net SOL (buys minus sells) on a tape over the last `window` slots. */
function netSolOver(t: Tape, now: number, window: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i];
    if (tr.slot <= now - window) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  if (t.entries >= MAX_ENTRIES) return false;
  if (now - t.lastExit < COOLDOWN) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  const net = buySol - sellSol;
  if (net < MIN_NET_SOL) return false;
  if (netNew < netOld) return false; // inflow must be accelerating, not fading
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (high <= 0 || last < NEAR_HIGH * high) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (buySol > 0 && top / buySol > MAX_BUYER_SHARE) return false;
  return true;
}

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

    // --- fold this batch's fills into our own books ----------------------
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.client_id.startsWith('_')) continue; // harness close, not our order
      if (f.side === 'buy') {
        myCoins.add(f.mint);
        if (probes.get(f.mint) === false) probes.set(f.mint, true); // probe buy landed
      } else {
        const t = tapes.get(f.mint);
        if (t !== undefined) t.lastExit = now;
        held.delete(f.mint);
        probes.delete(f.mint);
      }
    }

    // --- fold this batch's events into the tapes -------------------------
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      seen.add(e.mint);
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') {
        if (t.created === null) t.created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const vt = Number(e.virtual_token_reserves);
        const price = vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / 1e9,
          user: e.user,
          price,
        });
      }
    }
    // Prune stale tape on the curves touched this batch (bounded memory).
    for (const mint of seen) {
      const t = tapes.get(mint);
      if (t === undefined) continue;
      const cut = now - KEEP;
      let drop = 0;
      while (drop < t.trades.length && t.trades[drop].slot <= cut) drop++;
      if (drop > 0) t.trades.splice(0, drop);
    }

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

    // --- sync held positions with the account ----------------------------
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint) && !probes.has(mint)) {
        held.set(mint, { opened: now, peakValue: 0, exiting: false });
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !hasBuyPending(mint)) {
        // Closed by the harness (curve completed) or sold already.
        held.delete(mint);
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = now;
      }
    }

    // --- exits first: stop loss, take profit, trailing stop, fade, age ---
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
        if (value > h.peakValue) h.peakValue = value;
        if (value < STOP_LOSS * cost) exit = true;
        else if (value >= TAKE_PROFIT * cost) exit = true;
        else if (h.peakValue >= TRAIL_ARM * cost && value < TRAIL * h.peakValue) exit = true;
        else if (now - h.opened >= MAX_HOLD) exit = true;
        else {
          const t = tapes.get(mint);
          if (t !== undefined && netSolOver(t, now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
        }
      }
      if (exit && orders.length < caps.max_orders_per_batch && free >= tx) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        free -= tx;
        if (h !== undefined) h.exiting = true;
      }
    }

    // --- entries: momentum on the curves touched by this batch -----------
    let mainOpen = 0;
    for (const mint of state.positions.keys()) if (!probes.has(mint)) mainOpen++;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && !probes.has(p.order.mint)) mainOpen++;
    }
    for (const mint of seen) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0 || mainOpen >= MAX_MAIN) break;
      if (state.positions.has(mint) || hasBuyPending(mint) || probes.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      const rqSol = Number(curve.real_quote_reserves) / 1e9;
      if (!entrySignal(t, now, rqSol)) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      slots -= 1;
      mainOpen += 1;
      t.entries += 1;
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
