'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRobots, priceFor, solToLamports, lamportsToSol } = require('..');
const { ROBOTS, PAY_TO } = require('../test-helpers');

test('parses multiple groups with shared agents', () => {
  const groups = parseRobots(ROBOTS);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].agents, ['GPTBot', 'ClaudeBot']);
  assert.equal(groups[0].price.lamports, 500000);
  assert.equal(groups[0].payTo, PAY_TO);
  assert.equal(groups[0].receipt, 'x402');
  assert.equal(groups[0].pricePaths.length, 2);
  assert.deepEqual(groups[0].rules, [{ type: 'disallow', path: '/private' }]);
  assert.deepEqual(groups[1].agents, ['*']);
  assert.equal(groups[1].price, null);
});

test('default price, Price-Path longest match wins', () => {
  const g = parseRobots(ROBOTS);
  assert.deepEqual(priceFor(g, 'Mozilla/5.0 (compatible; GPTBot/1.2)', '/blog/x'),
    { lamports: 500000, payTo: PAY_TO, amount: '0.0005 SOL', receipt: 'x402' });
  assert.equal(priceFor(g, 'GPTBot', '/premium/report').lamports, 2000000);
  assert.equal(priceFor(g, 'GPTBot', '/premium/free-sample/1').lamports, 100000);
  assert.equal(priceFor(g, 'claudebot/1.0', '/').lamports, 500000);
});

test('wildcard * group without price is free; human UA is free', () => {
  const g = parseRobots(ROBOTS);
  assert.equal(priceFor(g, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', '/premium/x'), null);
  assert.equal(priceFor(g, 'SomeOtherBot', '/'), null);
});

test('wildcard * group can carry a price; specific group beats *', () => {
  const g = parseRobots(`User-agent: *\nPrice: 0.001 SOL\nPay-To: ${PAY_TO}\n\nUser-agent: Googlebot\nAllow: /\n`);
  assert.equal(priceFor(g, 'AnyBot', '/').lamports, 1000000);
  assert.equal(priceFor(g, 'Googlebot/2.1', '/'), null);
});

test('glob wildcards inside Price-Path and $ anchor', () => {
  const g = parseRobots(`User-agent: GPTBot\nPrice: 0.0005 SOL\nPay-To: ${PAY_TO}\nPrice-Path: /*.pdf$ 0.01 SOL\n`);
  assert.equal(priceFor(g, 'GPTBot', '/docs/a.pdf').lamports, 10000000);
  assert.equal(priceFor(g, 'GPTBot', '/docs/a.pdf.html').lamports, 500000);
});

test('SOL <-> lamports conversion is exact', () => {
  assert.equal(solToLamports('0.0005'), 500000);
  assert.equal(solToLamports('1'), 1e9);
  assert.equal(solToLamports('0.000000001'), 1);
  assert.equal(solToLamports('abc'), null);
  assert.equal(lamportsToSol(500000), '0.0005');
});
