import WebSocket from 'ws';
import { config, type TraderMode } from '../config.js';
import { logger } from '../logger.js';

// ── Base URLs ──────────────────────────────────────────────────────────────────
function restBase(mode: TraderMode) {
  return mode === 'live'
    ? 'https://live.tradovateapi.com/v1'
    : 'https://demo.tradovateapi.com/v1';
}
function wsBase(mode: TraderMode) {
  return mode === 'live'
    ? 'wss://live.tradovateapi.com/v1/websocket'
    : 'wss://demo.tradovateapi.com/v1/websocket';
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AuthResponse {
  accessToken: string;
  expirationTime: string;
  userId: number;
  userStatus: string;
  name: string;
  hasLive: boolean;
}

export interface TradovateAccount {
  id: number;
  name: string;
  userId: number;
  accountType: string;
  active: boolean;
  clearingHouseId: number;
  riskCategoryId: number;
}

export interface TradovateContract {
  id: number;
  name: string;
  contractMaturityId: number;
  status: string;
}

export interface OrderResult {
  orderId: number;
  failureReason?: string;
  failureText?: string;
}

// ── Front-month resolution (roll-aware) ───────────────────────────────────────
// Quarterly index futures (NQ/ES) roll ~8 days before expiry. /contract/suggest
// is sorted by NEAREST expiry, so after a roll its first entry is the EXPIRING
// month (e.g. MNQM6 two days out) rather than the liquid front month (MNQU6).
// We parse the month code from the contract name, compute its 3rd-Friday expiry,
// skip anything within the roll buffer, and take the nearest survivor.
const MONTH_CODE: Record<string, number> = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
const ROLL_BUFFER_DAYS = 8;

function thirdFridayMs(year: number, month1: number): number {
  const firstDow = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - firstDow + 7) % 7);
  return Date.UTC(year, month1 - 1, firstFriday + 14);
}

// "MNQU6" / "MESM6" (root + monthCode + 1–2 digit year) → expiry ms, or null.
function contractExpiryMs(name: string, root: string): number | null {
  if (!name.startsWith(root)) return null;
  const rest = name.slice(root.length);
  const month = MONTH_CODE[rest[0] ?? ''];
  const yStr = rest.slice(1);
  if (!month || !/^\d{1,2}$/.test(yStr)) return null;
  const year = yStr.length === 1 ? 2020 + Number(yStr) : 2000 + Number(yStr);
  return thirdFridayMs(year, month);
}

export interface FillEvent {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  tradeDate: { year: number; month: number; day: number };
  action: 'Buy' | 'Sell';
  qty: number;
  price: number;
  active: boolean;
}

// ── WS message protocol ────────────────────────────────────────────────────────
// Tradovate WS: each frame is "op\nseqId\n\nbody"
// Response frames: "a[{...}]" or "o" (open) or "h" (heartbeat)

let _wsSeq = 1;
function wsFrame(op: string, body: object | string = {}): string {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return `${op}\n${_wsSeq++}\n\n${bodyStr}`;
}

// ── Tradovate client ──────────────────────────────────────────────────────────
export class TradovateClient {
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private accountId: number | null = null;
  private accountName: string | null = null;
  private userId: number | null = null;
  private ws: WebSocket | null = null;
  private wsReady = false;
  private fillListeners: Array<(fill: FillEvent) => void> = [];
  private orderUpdateListeners: Array<(orderId: number, status: string) => void> = [];
  private positionListeners: Array<(pos: { id: number; contractId: number; netPos: number; netPrice: number | null; accountId: number; timestamp?: string }) => void> = [];
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Auth ──────────────────────────────────────────────────────────────────
  async authenticate(): Promise<void> {
    const res = await this.post('/auth/accesstokenrequest', {
      name:       config.tradovate.username,
      password:   config.tradovate.password,
      appId:      config.tradovate.appId,
      appVersion: config.tradovate.appVersion,
      deviceId:   config.tradovate.deviceId,
      cid:        config.tradovate.cid,
      sec:        config.tradovate.secret,
    }, { skipAuth: true });

    if (!res.accessToken) {
      throw new Error(`Tradovate auth failed: ${JSON.stringify(res)}`);
    }

    this.accessToken = res.accessToken as string;
    this.userId = res.userId as number;
    this.tokenExpiry = Date.now() + 20 * 60_000; // refresh 20min before expiry
    logger.info({ userId: this.userId, mode: config.mode }, 'tradovate authenticated');
  }

  private async ensureAuth(): Promise<void> {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this.authenticate();
    }
  }

  // ── Account ───────────────────────────────────────────────────────────────
  async loadAccount(): Promise<void> {
    await this.ensureAuth();
    const accounts = await this.get('/account/list') as TradovateAccount[];
    if (!accounts.length) throw new Error('No Tradovate accounts found');
    // Prefer the first active account
    const account = accounts.find(a => a.active) ?? accounts[0]!;
    this.accountId = account.id;
    this.accountName = account.name;
    logger.info({ accountId: this.accountId, accountName: this.accountName }, 'tradovate account loaded');
  }

  get account() {
    if (!this.accountId || !this.accountName) throw new Error('Account not loaded');
    return { id: this.accountId, name: this.accountName };
  }

  // ── Contract lookup ───────────────────────────────────────────────────────
  // Finds the front-month contract for a root symbol (e.g. "MNQ" → "MNQM6").
  // Tradovate marks tradeable contracts with status="DefinitionChecked" or
  // "Active" — accept both. Empirically demo returns DefinitionChecked.
  async findContract(root: string): Promise<TradovateContract> {
    await this.ensureAuth();
    // suggest returns contracts sorted by NEAREST expiry — NOT roll-aware.
    const suggestions = await this.get(`/contract/suggest?t=${encodeURIComponent(root)}&l=10`) as TradovateContract[];
    const tradeable = suggestions.filter(c => c.status === 'Active' || c.status === 'DefinitionChecked');
    if (!tradeable.length) {
      throw new Error(`No tradeable contract found for ${root} (got: ${suggestions.map(c => `${c.name}/${c.status}`).join(', ')})`);
    }
    // Roll-aware front month: skip contracts within ROLL_BUFFER_DAYS of expiry,
    // pick the nearest survivor (the liquid front month after a roll).
    const now = Date.now();
    const bufMs = ROLL_BUFFER_DAYS * 86_400_000;
    const dated = tradeable
      .map(c => ({ c, exp: contractExpiryMs(c.name, root) }))
      .filter((x): x is { c: TradovateContract; exp: number } => x.exp !== null)
      .sort((a, b) => a.exp - b.exp);
    const front = dated.find(x => x.exp - now >= bufMs)?.c   // nearest not-about-to-expire
      ?? dated[0]?.c                                          // else nearest parseable
      ?? tradeable[0]!;                                       // else original fallback
    logger.info({
      root, chosen: front.name,
      candidates: dated.map(x => `${x.c.name}:${Math.round((x.exp - now) / 86_400_000)}d`),
    }, 'front-month resolved (roll-aware)');
    return front;
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  async placeMarketOrder(params: {
    contractName: string;
    action: 'Buy' | 'Sell';
    qty: number;
  }): Promise<number> {
    await this.ensureAuth();
    const { id: accountId, name: accountSpec } = this.account;
    const res = await this.post('/order/placeorder', {
      accountSpec,
      accountId,
      action:      params.action,
      symbol:      params.contractName,
      orderQty:    params.qty,
      orderType:   'Market',
      timeInForce: 'Day',
      isAutomated: true,
    });

    const orderId = res.orderId ?? res.id;
    if (!orderId) throw new Error(`placeMarketOrder failed: ${JSON.stringify(res)}`);
    logger.info({ orderId, ...params }, 'market order placed');
    return orderId as number;
  }

  async placeStopOrder(params: {
    contractName: string;
    action: 'Buy' | 'Sell';
    qty: number;
    stopPrice: number;
  }): Promise<number> {
    await this.ensureAuth();
    const { id: accountId, name: accountSpec } = this.account;
    const res = await this.post('/order/placeorder', {
      accountSpec,
      accountId,
      action:      params.action,
      symbol:      params.contractName,
      orderQty:    params.qty,
      orderType:   'Stop',
      stopPrice:   params.stopPrice,
      timeInForce: 'GTC',
      isAutomated: true,
    });

    const orderId = res.orderId ?? res.id;
    if (!orderId) throw new Error(`placeStopOrder failed: ${JSON.stringify(res)}`);
    logger.info({ orderId, ...params }, 'stop order placed');
    return orderId as number;
  }

  async placeLimitOrder(params: {
    contractName: string;
    action: 'Buy' | 'Sell';
    qty: number;
    limitPrice: number;
  }): Promise<number> {
    await this.ensureAuth();
    const { id: accountId, name: accountSpec } = this.account;
    const res = await this.post('/order/placeorder', {
      accountSpec,
      accountId,
      action:      params.action,
      symbol:      params.contractName,
      orderQty:    params.qty,
      orderType:   'Limit',
      price:       params.limitPrice,
      timeInForce: 'GTC',
      isAutomated: true,
    });

    const orderId = res.orderId ?? res.id;
    if (!orderId) throw new Error(`placeLimitOrder failed: ${JSON.stringify(res)}`);
    logger.info({ orderId, ...params }, 'limit order placed');
    return orderId as number;
  }

  async cancelOrder(orderId: number): Promise<void> {
    await this.ensureAuth();
    await this.post('/order/cancelorder', { orderId });
    logger.info({ orderId }, 'order cancelled');
  }

  // Fetch the most recent fill of a given action on a contract.
  // Used by position-watcher to find the actual close fill price after a
  // flat transition. Without this, the watcher computes PnL from the net-
  // position snapshot (the entry price for a 1-qty trade) and reports 0.
  async getMostRecentFill(contractId: number, action: 'Buy' | 'Sell'): Promise<{ price: number; timestamp: string } | null> {
    await this.ensureAuth();
    const fills = await this.get('/fill/list') as Array<{ contractId: number; action: string; price: number; timestamp: string }> | null;
    if (!Array.isArray(fills)) return null;
    let best: { price: number; timestamp: string } | null = null;
    for (const f of fills) {
      if (f.contractId !== contractId) continue;
      if (f.action !== action) continue;
      if (!best || f.timestamp > best.timestamp) best = { price: f.price, timestamp: f.timestamp };
    }
    return best;
  }

  async getOrderStatus(orderId: number): Promise<{ status: string; avgPx?: number } | null> {
    await this.ensureAuth();
    const res = await this.get(`/order/item?id=${orderId}`);
    if (!res) return null;
    // 2026-06-04 fix: /order/item does NOT include avgPx — the fill price lives
    // in /fill/deps?masterid=. If the order is Filled, fetch fills explicitly
    // and compute volume-weighted average price. Without this, waitForFill's
    // REST fallback could never confirm a fill, causing the trader to throw
    // even though the broker had filled the order in milliseconds.
    const status = res.ordStatus as string;
    if (status === 'Filled') {
      try {
        const fills = await this.get(`/fill/deps?masterid=${orderId}`) as Array<{ qty: number; price: number }> | null;
        if (Array.isArray(fills) && fills.length > 0) {
          let qty = 0, weightedPx = 0;
          for (const f of fills) { qty += f.qty; weightedPx += f.qty * f.price; }
          if (qty > 0) return { status, avgPx: weightedPx / qty };
        }
      } catch { /* fall through to no-avgPx case */ }
    }
    return { status, avgPx: undefined };
  }

  // ── WebSocket (fill events) ───────────────────────────────────────────────
  async connectWebSocket(): Promise<void> {
    const url = wsBase(config.mode);
    logger.info({ url }, 'connecting tradovate WebSocket');

    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 15_000);

      ws.on('open', () => {
        // Tradovate WS sends "o" on open, then we must authorize
        logger.info('tradovate WS opened');
      });

      ws.on('message', async (raw: Buffer) => {
        const msg = raw.toString();

        // "o" = socket open confirmation
        if (msg === 'o') {
          // Authorize the WebSocket session — Tradovate expects the raw access
          // token as the body, NOT a {token: ...} JSON wrapper.
          ws.send(wsFrame('authorize', this.accessToken!));
          return;
        }

        // "h" = server heartbeat
        if (msg === 'h') {
          ws.send('[]'); // pong
          return;
        }

        // "a[...]" = array of events
        if (msg.startsWith('a')) {
          try {
            const events = JSON.parse(msg.slice(1)) as Array<{ e: string; d?: any; i?: number; s?: number }>;
            for (const ev of events) {
              // Authorization response
              if (ev.e === 'authorize' || (ev.i === 1 && ev.s === 200)) {
                // Subscribe to account updates after auth
                const acct = this.account;
                ws.send(wsFrame('user/syncrequest', { users: [this.userId] }));
                clearTimeout(timeout);
                this.wsReady = true;
                resolve();
                continue;
              }

              // Fill events
              if (ev.e === 'props' && ev.d?.entityType === 'fill') {
                const fill = ev.d.entity as FillEvent;
                this.fillListeners.forEach(fn => fn(fill));
              }

              // Order status updates
              if (ev.e === 'props' && ev.d?.entityType === 'order') {
                const order = ev.d.entity as { id: number; ordStatus: string };
                this.orderUpdateListeners.forEach(fn => fn(order.id, order.ordStatus));
              }

              // Position updates — needed for the orphan-bracket watcher
              if (ev.e === 'props' && ev.d?.entityType === 'position') {
                const pos = ev.d.entity as {
                  id: number; contractId: number; netPos: number;
                  netPrice: number | null; accountId: number; timestamp?: string;
                };
                this.positionListeners.forEach(fn => fn(pos));
              }
            }
          } catch (err) {
            logger.warn({ err, msg }, 'WS parse error');
          }
        }
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'tradovate WS error');
        if (!this.wsReady) reject(err);
      });

      ws.on('close', () => {
        logger.warn('tradovate WS closed — will reconnect in 5s');
        this.wsReady = false;
        if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer);
        // Refresh access token before reconnecting. Without this, an expired
        // or server-invalidated token causes Tradovate to silently close every
        // reconnect attempt — a hard loop with no way out. ensureAuth() no-ops
        // when the cached token is still valid, so this is cheap.
        setTimeout(async () => {
          try {
            await this.ensureAuth();
            await this.connectWebSocket();
          } catch (e) {
            logger.error({ e }, 'WS reconnect failed');
          }
        }, 5_000);
      });
    });

    // Client-side heartbeat every 2.5s (Tradovate disconnects idle sockets)
    this.wsHeartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('[]');
    }, 2_500);
  }

  onFill(fn: (fill: FillEvent) => void): () => void {
    this.fillListeners.push(fn);
    return () => { this.fillListeners = this.fillListeners.filter(f => f !== fn); };
  }

  onOrderUpdate(fn: (orderId: number, status: string) => void): () => void {
    this.orderUpdateListeners.push(fn);
    return () => { this.orderUpdateListeners = this.orderUpdateListeners.filter(f => f !== fn); };
  }

  onPositionUpdate(fn: (pos: { id: number; contractId: number; netPos: number; netPrice: number | null; accountId: number; timestamp?: string }) => void): () => void {
    this.positionListeners.push(fn);
    return () => { this.positionListeners = this.positionListeners.filter(f => f !== fn); };
  }

  // List currently-Working orders for a given contractId (used by orphan-watcher).
  async getWorkingOrdersForContract(contractId: number): Promise<Array<{ id: number; ordStatus: string; action: string }>> {
    await this.ensureAuth();
    const all = await this.get('/order/list') as Array<{ id: number; ordStatus: string; contractId: number; action: string }>;
    return all.filter(o => o.contractId === contractId && o.ordStatus === 'Working');
  }

  // Wait for an order to fill (or fail) with REST polling fallback
  async waitForFill(orderId: number, timeoutMs = 30_000): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Order ${orderId} fill timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // WebSocket path
      const unsub = this.onFill((fill) => {
        if (fill.orderId === orderId) {
          clearTimeout(timer);
          clearInterval(poll);
          unsub();
          resolve(fill.price);
        }
      });

      // REST fallback — poll every second in case WS misses the fill
      const poll = setInterval(async () => {
        try {
          const status = await this.getOrderStatus(orderId);
          if (status?.status === 'Filled' && status.avgPx) {
            clearTimeout(timer);
            clearInterval(poll);
            unsub();
            resolve(status.avgPx);
          } else if (status?.status === 'Cancelled' || status?.status === 'Rejected') {
            clearTimeout(timer);
            clearInterval(poll);
            unsub();
            reject(new Error(`Order ${orderId} ${status.status}`));
          }
        } catch { /* network hiccup, continue polling */ }
      }, 1_000);
    });
  }

  // ── REST helpers ──────────────────────────────────────────────────────────
  private async get(path: string): Promise<any> {
    await this.ensureAuth();
    const res = await fetch(`${restBase(config.mode)}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async post(path: string, body: object, opts: { skipAuth?: boolean } = {}): Promise<any> {
    if (!opts.skipAuth) await this.ensureAuth();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken && !opts.skipAuth) headers['Authorization'] = `Bearer ${this.accessToken}`;
    const res = await fetch(`${restBase(config.mode)}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
