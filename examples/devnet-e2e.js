// Real end-to-end on Solana devnet: middleware server + client paying with a real devnet wallet.
// Usage: PAYER_SEED='[..32 numbers..]' PAY_TO=<address> node examples/devnet-e2e.js
const http = require('http');
const { createPayToCrawl } = require('..');
const { fetchWithPayment } = require('../client');
const payer = require(process.env.SOLANA_HELPER); // a module exporting pay(rpc, keypair, to, lamports, memo) and keypairFromSeed(seed)
const RPC = 'https://api.devnet.solana.com';
const robotsTxt = `User-agent: GPTBot\nPrice: 0.0005 SOL\nPay-To: ${process.env.PAY_TO}\nReceipt: x402\n`;
const mw = createPayToCrawl({ robotsTxt, rpcUrl: RPC });
const srv = http.createServer((req, res) => mw(req, res, () => { res.end('paid content'); })).listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/article`;
  const kp = payer.keypairFromSeed(Buffer.from(JSON.parse(process.env.PAYER_SEED)).subarray(0, 32));
  try {
    const r = await fetchWithPayment(url, { userAgent: 'GPTBot/1.0', payer: ({ payTo, lamports, quoteId }) => payer.pay(RPC, kp, payTo, lamports, quoteId) });
    console.log('status', r.status, 'body', await r.text(), 'accepted', r.headers.get('x-payment-accepted'));
  } catch (e) { console.log('ERR', e.message); }
  srv.close();
});
