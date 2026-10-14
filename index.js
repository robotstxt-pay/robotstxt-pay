'use strict';

const fs = require('fs');
const crypto = require('crypto');

const LAMPORTS_PER_SOL = 1000000000n;
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/**
 * Convert "0.0005" (SOL, decimal string) to lamports as a Number without float error.
 * Returns null for malformed input.
 */
function solToLamports(amount) {
  const m = /^\s*(\d+)(?:\.(\d{1,9}))?\s*$/.exec(String(amount));
  if (!m) return null;
  const whole = BigInt(m[1]) * LAMPORTS_PER_SOL;
  const frac = BigInt((m[2] || '').padEnd(9, '0') || '0');
  const total = whole + frac;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(total);
}

function lamportsToSol(lamports) {
  const n = BigInt(lamports);
  const whole = n / LAMPORTS_PER_SOL;
  const frac = (n % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parse "<amount> SOL" -> lamports, or null. */
function parseAmount(str) {
  const m = /^\s*([\d.]+)\s*(SOL)?\s*$/i.exec(str || '');
  if (!m) return null;
  return solToLamports(m[1]);
}

/**
 * Parse robots.txt into groups. Consecutive User-agent lines open a group;
 * a User-agent line following any other directive starts a new group.
 */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], price: null, payTo: null, receipt: null, pricePaths: [] };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // directives outside a group (e.g. Sitemap) are ignored

    switch (key) {
      case 'allow':
      case 'disallow':
        current.rules.push({ type: key, path: value });
        break;
      case 'price': {
        const lamports = parseAmount(value);
        if (lamports !== null) current.price = { amount: value, lamports };
        break;
      }
      case 'pay-to':
        current.payTo = value;
        break;
      case 'receipt':
        current.receipt = value.toLowerCase();
        break;
      case 'price-path': {
        const m = /^(\S+)\s+(.+)$/.exec(value);
        if (!m) break;
        const lamports = parseAmount(m[2]);
        if (lamports !== null) current.pricePaths.push({ pattern: m[1], amount: m[2].trim(), lamports });
        break;
      }
      default:
        if (!current.extra) current.extra = {};
        current.extra[key] = value;
    }
  }
  return groups;
}

/** robots.txt-style glob: '*' = any chars, trailing '$' anchors end. Prefix match otherwise. */
function globToRegExp(pattern) {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const body = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

function pathMatches(pattern, path) {
  return globToRegExp(pattern).test(path);
}

/**
 * Pick the group for a user-agent: the most specific (longest) agent token
 * contained in the UA (case-insensitive) wins; '*' is the fallback.
 */
function selectGroup(groups, userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      const token = a.toLowerCase();
      if (token === '*') {
        if (bestLen < 0) { best = g; bestLen = 0; }
      } else if (token && ua.includes(token) && token.length > bestLen) {
        best = g;
        bestLen = token.length;
      }
    }
  }
  return best;
}

/**
 * Price for a request. Returns { lamports, payTo, amount, receipt } or null when free.
 * Price-Path entries override the group default; longest pattern wins.
 */
function priceFor(groups, userAgent, path) {
  const g = selectGroup(groups, userAgent);
  if (!g || !g.payTo) return null;
  const p = path || '/';
  let chosen = null;
  for (const pp of g.pricePaths) {
    if (pathMatches(pp.pattern, p) && (!chosen || pp.pattern.length > chosen.pattern.length)) chosen = pp;
  }
  const lamports = chosen ? chosen.lamports : g.price ? g.price.lamports : null;
  if (lamports === null || lamports <= 0) return null;
  return { lamports, payTo: g.payTo, amount: `${lamportsToSol(lamports)} SOL`, receipt: g.receipt || 'x402' };
}

async function rpc(fetchImpl, rpcUrl, method, params) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

function allInstructions(tx) {
  const out = [];
  const msg = tx && tx.transaction && tx.transaction.message;
  if (msg && Array.isArray(msg.instructions)) out.push(...msg.instructions);
  const inner = tx && tx.meta && tx.meta.innerInstructions;
  if (Array.isArray(inner)) for (const set of inner) if (Array.isArray(set.instructions)) out.push(...set.instructions);
  return out;
}

/**
 * Verify a Solana payment receipt on-chain.
 * Resolves { ok: true, tx } or { ok: false, reason }. Never throws for verification failures.
 */
async function verifyReceipt({ rpcUrl = DEFAULT_RPC, signature, payTo, lamports, quoteId, fetch: fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (!signature || !SIG_RE.test(signature)) return { ok: false, reason: 'malformed signature' };
  let tx;
  try {
    tx = await rpc(f, rpcUrl, 'getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
  } catch (err) {
    return { ok: false, reason: `rpc failure: ${err.message}` };
  }
  if (!tx) return { ok: false, reason: 'transaction not found' };
  if (!tx.meta || tx.meta.err !== null) return { ok: false, reason: 'transaction failed' };

  const ixs = allInstructions(tx);
  const paid = ixs.some((ix) =>
    ix && ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer' &&
    ix.parsed.info && ix.parsed.info.destination === payTo &&
    Number(ix.parsed.info.lamports) >= Number(lamports));
  if (!paid) return { ok: false, reason: 'no matching transfer to pay-to address' };

  const memo = ixs.some((ix) => ix && ix.program === 'spl-memo' && ix.parsed === quoteId);
  if (!memo) return { ok: false, reason: 'memo does not match quote id' };

  return { ok: true, tx };
}

/** Default in-memory replay store. Any object with async has(sig)/add(sig) works (Redis, DB...). */
function memoryStore() {
  const used = new Set();
  return {
    has: async (sig) => used.has(sig),
    add: async (sig) => { used.add(sig); },
  };
}

function newQuoteId() {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return 'q_' + s;
}

function header(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Create a (req, res, next) middleware. Works with node:http and Express/Connect.
 * Options: robotsTxt | robotsPath, rpcUrl, quoteTtl (seconds, default 60), store, fetch, now.
 */
function createPayToCrawl(opts = {}) {
  let text = opts.robotsTxt;
  if (text === undefined && opts.robotsPath) text = fs.readFileSync(opts.robotsPath, 'utf8');
  if (text === undefined) throw new Error('robotstxt-pay: robotsTxt or robotsPath is required');
  const groups = parseRobots(text);
  for (const g of groups) {
    if ((g.price || g.pricePaths.length) && g.payTo && !BASE58_RE.test(g.payTo)) {
      throw new Error(`robotstxt-pay: invalid Pay-To address "${g.payTo}"`);
    }
  }
  const rpcUrl = opts.rpcUrl || DEFAULT_RPC;
  const ttl = opts.quoteTtl || 60;
  const store = opts.store || memoryStore();
  const fetchImpl = opts.fetch;
  const now = opts.now || (() => Date.now());
  const quotes = new Map(); // quoteId -> { lamports, payTo, path, expires }
  const pending = new Set(); // signatures being verified right now

  function sweep() {
    const t = now();
    for (const [id, q] of quotes) if (q.expires < t) quotes.delete(id);
  }

  function sendQuote(res, price, path, error) {
    sweep();
    const quoteId = newQuoteId();
    const expires = now() + ttl * 1000;
    quotes.set(quoteId, { lamports: price.lamports, payTo: price.payTo, path, expires });
    const body = {
      error: 'payment_required',
      price: price.amount,
      lamports: price.lamports,
      payTo: price.payTo,
      quoteId,
      expiresIn: ttl,
      receipt: price.receipt,
      network: 'solana',
    };
    if (error) body.reason = error;
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Price', price.amount);
    res.setHeader('X-Pay-To', price.payTo);
    res.setHeader('X-Quote-Id', quoteId);
    res.setHeader('X-Quote-Expires', String(ttl));
    if (error) res.setHeader('X-Payment-Error', error);
    res.end(JSON.stringify(body));
  }

  async function handle(req, res, next) {
    const rawUrl = req.originalUrl || req.url || '/';
    const path = rawUrl.split('?')[0] || '/';
    const price = priceFor(groups, header(req, 'user-agent'), path);
    if (!price) return next();

    const signature = header(req, 'x-payment');
    const quoteId = header(req, 'x-quote-id');
    if (!signature || !quoteId) return sendQuote(res, price, path);

    const quote = quotes.get(quoteId);
    if (!quote) return sendQuote(res, price, path, 'unknown quote');
    if (quote.expires < now()) {
      quotes.delete(quoteId);
      return sendQuote(res, price, path, 'quote expired');
    }
    if (quote.path !== path) return sendQuote(res, price, path, 'quote not valid for this path');
    if (pending.has(signature) || (await store.has(signature))) {
      return sendQuote(res, price, path, 'payment already used');
    }

    pending.add(signature);
    try {
      const result = await verifyReceipt({
        rpcUrl, signature, payTo: quote.payTo, lamports: quote.lamports, quoteId, fetch: fetchImpl,
      });
      if (!result.ok) return sendQuote(res, price, path, result.reason);
      if (await store.has(signature)) return sendQuote(res, price, path, 'payment already used');
      await store.add(signature);
      quotes.delete(quoteId);
      req.payment = { signature, quoteId, lamports: quote.lamports, payTo: quote.payTo };
      res.setHeader('X-Payment-Accepted', signature);
      return next();
    } finally {
      pending.delete(signature);
    }
  }

  const middleware = function payToCrawl(req, res, next) {
    const done = typeof next === 'function' ? next : () => {};
    handle(req, res, done).catch((err) => {
      if (typeof next === 'function') return next(err);
      if (!res.headersSent) { res.statusCode = 500; res.end('payment verification error'); }
    });
  };
  middleware.groups = groups;
  return middleware;
}

module.exports = {
  parseRobots,
  priceFor,
  createPayToCrawl,
  verifyReceipt,
  memoryStore,
  solToLamports,
  lamportsToSol,
  DEFAULT_RPC,
};
