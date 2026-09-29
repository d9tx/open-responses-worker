import assert from 'node:assert/strict';
import test from 'node:test';
import { utf8Length } from '../src/utils/runtime';

test('utf8Length matches TextEncoder, including lone surrogates', () => {
  const encoder = new TextEncoder();
  for (const value of ['', 'ascii', 'é', '中文', '😀', 'a😀b', '\ud800', '\udc00x', 'x\ud83d', '\ud83d😀']) {
    assert.equal(utf8Length(value), encoder.encode(value).length, JSON.stringify(value));
  }
});
