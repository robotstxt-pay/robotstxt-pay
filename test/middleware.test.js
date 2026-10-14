'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayToCrawl, verifyReceipt } = require('..');
const { ROBOTS, PAY_TO, fakeSig, fakeTx, mockRpc, run } = require('../test-helpers');

const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

async function getQuote(mw, url = '/article') {
  const { res } = await run(mw, { url, headers: { 'user-agent': GPT } });
  return res;
}

test('402 issued with correct headers for GPTBot', async () => {
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc({}) });
  const { res, passed } = await run(mw, { url: '/article?x=1', headers: { 'user-agent': GPT } });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.headers['x-price'], '0.0005 SOL');
  assert.equal(res.headers['x-pay-to'], PAY_TO);
  assert.match(res.headers['x-quote-id'], /^q_[0-9a-z]{10}$/);
  assert.equal(res.headers['x-quote-expires'], '60');
  const body = JSON.parse(res.body);
  assert.equal(body.lamports, 500000);
  assert.equal(body.quoteId, res.headers['x-quote-id']);
  assert.equal(body.payTo, PAY_TO);
});

test('human UA passes through untouched', async () => {
  const rpc = mockRpc({});
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: rpc });
  const { passed, res } = await run(mw, { url: '/premium/x', headers: { 'user-agent': HUMAN } });
  assert.equal(passed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(rpc.calls.length, 0);
});

test('valid receipt passes and RPC called with correct params', async () => {
  const sig = fakeSig();
  const txs = {};
  const rpc = mockRpc(txs);
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: rpc, rpcUrl: 'http://rpc.test' });
  const q = await getQuote(mw);
  const quoteId = q.headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: quoteId });
  const req = { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } };
  const { passed, res } = await run(mw, req);
  assert.equal(passed, true);
  assert.equal(req.payment.signature, sig);
  assert.equal(res.headers['x-payment-accepted'], sig);
  assert.equal(rpc.calls[0].method, 'getTransaction');
  assert.deepEqual(rpc.calls[0].params[1], { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
});

test('wrong amount rejected', async () => {
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs) });
  const quoteId = (await getQuote(mw)).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 499999, memo: quoteId });
  const { passed, res } = await run(mw, { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 402);
  assert.match(res.headers['x-payment-error'], /transfer/);
});

test('wrong recipient rejected', async () => {
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs) });
  const quoteId = (await getQuote(mw)).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: quoteId, payTo: 'So11111111111111111111111111111111111111112' });
  const { passed } = await run(mw, { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.equal(passed, false);
});

test('wrong memo rejected', async () => {
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs) });
  const quoteId = (await getQuote(mw)).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: 'q_someother1' });
  const { passed, res } = await run(mw, { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.equal(passed, false);
  assert.match(res.headers['x-payment-error'], /memo/);
});

test('failed transaction (meta.err) rejected', async () => {
  const sig = fakeSig();
  const r = await verifyReceipt({ signature: sig, payTo: PAY_TO, lamports: 1, quoteId: 'q_x',
    fetch: mockRpc({ [sig]: fakeTx({ lamports: 5, memo: 'q_x', err: { InstructionError: [0, 'x'] } }) }) });
  assert.equal(r.ok, false);
});

test('expired quote rejected', async () => {
  let t = 1_000_000;
  const sig = fakeSig();
  const txs = {};
  const rpc = mockRpc(txs);
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: rpc, quoteTtl: 30, now: () => t });
  const q = await getQuote(mw);
  assert.equal(q.headers['x-quote-expires'], '30');
  const quoteId = q.headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: quoteId });
  t += 31_000;
  const { passed, res } = await run(mw, { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.equal(passed, false);
  assert.equal(res.headers['x-payment-error'], 'quote expired');
  assert.equal(rpc.calls.length, 0);
});

test('replayed signature rejected', async () => {
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs) });
  const quoteId = (await getQuote(mw)).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: quoteId });
  const h = { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId };
  assert.equal((await run(mw, { url: '/article', headers: h })).passed, true);

  // same signature + same quote
  const again = await run(mw, { url: '/article', headers: h });
  assert.equal(again.passed, false);
  assert.equal(again.res.statusCode, 402);

  // same signature against a fresh quote
  const quote2 = (await getQuote(mw)).headers['x-quote-id'];
  const third = await run(mw, { url: '/article', headers: { ...h, 'x-quote-id': quote2 } });
  assert.equal(third.passed, false);
  assert.equal(third.res.headers['x-payment-error'], 'payment already used');
});

test('pluggable store is used for replay protection', async () => {
  const used = new Set(['preused']);
  const store = { has: async (s) => used.has(s), add: async (s) => { used.add(s); } };
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs), store });
  const quoteId = (await getQuote(mw)).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 500000, memo: quoteId });
  await run(mw, { url: '/article', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.ok(used.has(sig));
});

test('quote is bound to its path (cheap quote cannot unlock premium path)', async () => {
  const sig = fakeSig();
  const txs = {};
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc(txs) });
  const quoteId = (await getQuote(mw, '/premium/free-sample/1')).headers['x-quote-id'];
  txs[sig] = fakeTx({ lamports: 100000, memo: quoteId });
  const { passed } = await run(mw, { url: '/premium/report', headers: { 'user-agent': GPT, 'x-payment': sig, 'x-quote-id': quoteId } });
  assert.equal(passed, false);
});

test('unknown quote id rejected without RPC call', async () => {
  const rpc = mockRpc({});
  const mw = createPayToCrawl({ robotsTxt: ROBOTS, fetch: rpc });
  const { passed, res } = await run(mw, { url: '/a', headers: { 'user-agent': GPT, 'x-payment': fakeSig(), 'x-quote-id': 'q_forged0000' } });
  assert.equal(passed, false);
  assert.equal(res.headers['x-payment-error'], 'unknown quote');
  assert.equal(rpc.calls.length, 0);
});
