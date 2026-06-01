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
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Auth ──────────────────────────────────────────────────────────────────
  async authenticate(): Promise<void> {
    const res = await this.post('/auth/accesstokenrequest', {
      name:       config.tradovate.username,
      password:   config.tradovate.password,
      appId:      config.tradovate.appId,
      appVersion: config.tradovate.appVersion,
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
  // Finds the front-month contract for a root symbol (e.g. "MNQ" → "MNQM6")
  async findContract(root: string): Promise<TradovateContract> {
    await this.ensureAuth();
    // suggest returns active contracts sorted by expiry
    const suggestions = await this.get(`/contract/suggest?t=${encodeURIComponent(root)}&l=10`) as TradovateContract[];
    const active = suggestions.filter(c => c.status === 'Active');
    if (!active.length) throw new Error(`No active contract found for ${root}`);
    return active[0]!;
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
      timeInForce: 'DAY',
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
      orderType:   'StopMarket',
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

  async getOrderStatus(orderId: number): Promise<{ status: string; avgPx?: number } | null> {
    await this.ensureAuth();
    const res = await this.get(`/order/item?id=${orderId}`);
    if (!res) return null;
    return { status: res.ordStatus as string, avgPx: res.avgPx as number | undefined };
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
          // Authorize the WebSocket session
          ws.send(wsFrame('authorize', { token: this.accessToken }));
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
        setTimeout(() => this.connectWebSocket().catch(e => logger.error({ e }, 'WS reconnect failed')), 5_000);
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
