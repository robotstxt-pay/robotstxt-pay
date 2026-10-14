# robotstxt-pay

Pay-to-crawl middleware for Node. Declare a price in `robots.txt`; AI crawlers that match a priced
`User-agent` group get an **HTTP 402 Payment Required** quote, pay it in SOL on Solana, and retry
with the transaction signature as a receipt. Humans and unpriced agents pass through untouched.

Implements the ROBOTSTXT pay-to-crawl spec. Zero runtime dependencies, CommonJS, Node >= 18.

```sh
npm install https://github.com/robotstxt-pay/robotstxt-pay/tarball/main
```

## robots.txt

```txt
User-agent: GPTBot
User-agent: ClaudeBot
Price: 0.0005 SOL
Pay-To: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin
Receipt: x402
Price-Path: /premium/* 0.002 SOL
Price-Path: /premium/free-sample* 0.0001 SOL

User-agent: *
Allow: /
```

- `Price` — default price per page for the group.
- `Pay-To` — Solana address receiving payment.
- `Receipt: x402` — receipt scheme.
- `Price-Path: <glob> <amount> SOL` — per-path override; `*` wildcard, trailing `$` anchors; longest pattern wins.

The most specific `User-agent` token contained in the request's User-Agent selects the group; `*` is the fallback.

## Express

```js
const express = require('express');
const { createPayToCrawl } = require('robotstxt-pay');

const app = express();
app.use(createPayToCrawl({
  robotsPath: './public/robots.txt',
  rpcUrl: 'https://api.devnet.solana.com',
  quoteTtl: 60,
}));
app.get('*', (req, res) => res.send(req.payment ? 'paid content' : 'content'));
app.listen(3000);
```

## Plain `http`

```js
const http = require('http');
const fs = require('fs');
const { createPayToCrawl } = require('robotstxt-pay');

const pay = createPayToCrawl({ robotsTxt: fs.readFileSync('robots.txt', 'utf8') });

http.createServer((req, res) => {
  pay(req, res, () => res.end('hello'));
}).listen(3000);
```

After a successful payment `req.payment = { signature, quoteId, lamports, payTo }`.

## Crawler side

```js
const { fetchWithPayment } = require('robotstxt-pay/client');

const res = await fetchWithPayment('https://example.com/article', {
  userAgent: 'GPTBot/1.2',
  // Send `lamports` to `payTo` in one tx that includes an SPL Memo whose text is `quoteId`.
  payer: async ({ payTo, lamports, quoteId }) => wallet.payWithMemo(payTo, lamports, quoteId), // -> tx signature
});
console.log(res.status, await res.text());
```

`fetchWithPayment` does a GET; on 402 it calls `payer` once and retries with `X-Payment` / `X-Quote-Id`.

## Protocol

402 response headers (also mirrored in a small JSON body):

| Header            | Example                                          | Meaning                                  |
| ----------------- | ------------------------------------------------ | ---------------------------------------- |
| `X-Price`         | `0.0005 SOL`                                     | Amount to pay for this path              |
| `X-Pay-To`        | `9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`   | Recipient Solana address                 |
| `X-Quote-Id`      | `q_k3j9x0a1bz`                                   | Must be the SPL Memo text of the payment |
| `X-Quote-Expires` | `60`                                             | Seconds until the quote expires          |
| `X-Payment-Error` | `memo does not match quote id`                   | Present when a submitted receipt failed  |

Retry request headers: `X-Payment: <tx signature>`, `X-Quote-Id: <id>`.

Verification (`verifyReceipt`) calls `getTransaction` with `jsonParsed`, commitment `confirmed`,
`maxSupportedTransactionVersion: 0`, and requires: the tx exists, `meta.err === null`, a system
`transfer` to `Pay-To` with `lamports >=` the quote, and an `spl-memo` instruction equal to the quote id.

## API

- `parseRobots(text)` → `[{ agents, rules, price, payTo, receipt, pricePaths }]`
- `priceFor(groups, userAgent, path)` → `{ lamports, payTo, amount, receipt } | null`
- `createPayToCrawl({ robotsTxt | robotsPath, rpcUrl, quoteTtl, store })` → `(req, res, next)`
- `verifyReceipt({ rpcUrl, signature, payTo, lamports, quoteId })` → `{ ok, reason? }`
- `memoryStore()` — default replay store

## Security notes

- **Replay:** each signature is accepted once. The default store is an in-memory `Set` — it resets on
  restart and is per-process. In production pass `store: { has: async sig => ..., add: async sig => ... }`
  backed by Redis or a database shared by all instances.
- **Quote binding:** the server remembers each quote (amount, recipient, path). The payment must carry
  the quote id in its memo, pay at least the quoted amount, and be redeemed on the same path it was
  quoted for — a cheap quote cannot unlock a pricier path, and forged quote ids are rejected without an RPC call.
- **Expiry:** quotes expire after `quoteTtl` seconds (default 60). Quotes are also in-memory, so behind a
  load balancer use sticky sessions or a single verifier.
- Verification uses `confirmed` commitment; use `finalized` semantics on your own RPC if you need stronger guarantees.
- Only native SOL transfers are checked; SPL-token payments are not supported in 0.1.

## Status

v0.1.0 — targets Solana devnet by default (`https://api.devnet.solana.com`). Covered by unit tests with a
mocked JSON-RPC (`npm test`) and verified end-to-end on Solana devnet with `examples/devnet-e2e.js`
(example tx: https://solscan.io/tx/AMfrgA6FmXv78FuE5B2JjDpkxzNPdd52CnnJrmxuEN4WnPah9c2dQtUiZEmNPRi83x74B4AbkuhNDRu2q5cEzfj?cluster=devnet).
Not yet audited; use on mainnet at your own risk.

## License

MIT © 2026 ROBOTSTXT contributors
