'use strict';

const PAY_TO = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const ROBOTS = `
# ROBOTSTXT pay-to-crawl
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /private
Price: 0.0005 SOL
Pay-To: ${PAY_TO}
Receipt: x402
Price-Path: /premium/* 0.002 SOL
Price-Path: /premium/free-sample* 0.0001 SOL

User-agent: *
Allow: /
`;

let sigCounter = 0;
function fakeSig() {
  sigCounter += 1;
  return ('5' + 'K'.repeat(86) + String(sigCounter).replace(/0/g, 'z')).slice(0, 88);
}

function fakeTx({ payTo = PAY_TO, lamports, memo, err = null }) {
  return {
    slot: 1,
    meta: { err, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [
          { program: 'system', programId: '11111111111111111111111111111111',
            parsed: { type: 'transfer', info: { source: 'Payer1111111111111111111111111111111111111', destination: payTo, lamports } } },
          { program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: memo },
        ],
      },
    },
  };
}

/** Mock fetch that answers getTransaction from a map of signature -> tx. */
function mockRpc(txs) {
  const calls = [];
  const fn = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const tx = txs[req.params[0]] || null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: tx }) };
  };
  fn.calls = calls;
  return fn;
}

/** Minimal res object compatible with the middleware. */
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null, ended: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b; res.ended = true; };
  return res;
}

function run(mw, req) {
  return new Promise((resolve, reject) => {
    const res = mockRes();
    const origEnd = res.end;
    res.end = (b) => { origEnd(b); resolve({ res, passed: false }); };
    mw(req, res, (err) => (err ? reject(err) : resolve({ res, passed: true })));
  });
}

module.exports = { PAY_TO, ROBOTS, fakeSig, fakeTx, mockRpc, mockRes, run };
