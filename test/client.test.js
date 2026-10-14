'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPayToCrawl } = require('..');
const { fetchWithPayment } = require('../client');
const { ROBOTS, PAY_TO, fakeSig, fakeTx, mockRpc } = require('../test-helpers');

test('fetchWithPayment: 402 -> pay -> retry -> 200 against a local http server', async (t) => {
  const txs = {};
  const rpc = mockRpc(txs);
  const pay = createPayToCrawl({ robotsTxt: ROBOTS, fetch: rpc });
  const server = http.createServer((req, res) => {
    pay(req, res, () => {
      res.setHeader('content-type', 'text/plain');
      res.end('hello ' + (req.payment ? 'paid' : 'free'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/article`;

  const payments = [];
  const payer = async ({ payTo, lamports, quoteId }) => {
    payments.push({ payTo, lamports, quoteId });
    const sig = fakeSig();
    txs[sig] = fakeTx({ payTo, lamports, memo: quoteId });
    return sig;
  };

  const res = await fetchWithPayment(url, { payer, userAgent: 'GPTBot/1.2' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello paid');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].payTo, PAY_TO);
  assert.equal(payments[0].lamports, 500000);
  assert.match(payments[0].quoteId, /^q_/);

  // humans: no payment
  const human = await fetchWithPayment(url, { payer, userAgent: 'Mozilla/5.0 Firefox/130' });
  assert.equal(human.status, 200);
  assert.equal(await human.text(), 'hello free');
  assert.equal(payments.length, 1);
});

test('fetchWithPayment without payer returns the 402', async (t) => {
  const pay = createPayToCrawl({ robotsTxt: ROBOTS, fetch: mockRpc({}) });
  const server = http.createServer((req, res) => pay(req, res, () => res.end('ok')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const res = await fetchWithPayment(`http://127.0.0.1:${server.address().port}/`, { userAgent: 'ClaudeBot' });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get('x-price'), '0.0005 SOL');
});
