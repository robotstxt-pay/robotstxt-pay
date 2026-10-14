'use strict';

/**
 * GET a URL; on 402, pay the quote via `payer` and retry once with the receipt.
 * payer: async ({ payTo, lamports, quoteId, price, url }) => txSignature
 */
async function fetchWithPayment(url, { payer, userAgent, fetch: fetchImpl, headers = {} } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const base = { ...headers };
  if (userAgent) base['User-Agent'] = userAgent;

  const first = await f(url, { method: 'GET', headers: base });
  if (first.status !== 402) return first;
  if (typeof payer !== 'function') return first;

  const quoteId = first.headers.get('x-quote-id');
  const payTo = first.headers.get('x-pay-to');
  const price = first.headers.get('x-price');
  let lamports;
  try {
    const body = await first.json();
    lamports = Number(body.lamports);
  } catch (_) { /* fall back to header */ }
  if (!Number.isFinite(lamports)) {
    const m = /^([\d.]+)/.exec(price || '');
    lamports = m ? Math.round(Number(m[1]) * 1e9) : NaN;
  }
  if (!quoteId || !payTo || !Number.isFinite(lamports)) {
    throw new Error('robotstxt-pay: malformed 402 quote');
  }

  const signature = await payer({ payTo, lamports, quoteId, price, url });
  return f(url, {
    method: 'GET',
    headers: { ...base, 'X-Payment': signature, 'X-Quote-Id': quoteId },
  });
}

module.exports = { fetchWithPayment };
