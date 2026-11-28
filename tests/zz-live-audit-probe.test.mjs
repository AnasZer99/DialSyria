import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSources } from '../scripts/discovery-runtime.mjs';

test('RSS catalog entries are well-formed, HTTPS and documented', async () => {
  const { RSS_SOURCES, enabledSources, MAX_ITEMS_PER_FEED, MAX_ITEMS_HARD_CAP } = await loadSources();
  assert.ok(RSS_SOURCES.length >= 7);
  const ids = new Set();
  for (const s of RSS_SOURCES) {
    assert.ok(!ids.has(s.id), 'duplicate id ' + s.id);
    ids.add(s.id);
    assert.ok(/^https:\/\//.test(s.url), 'https URL expected for ' + s.id);
    assert.ok(['syria', 'global'].includes(s.scope));
    assert.ok(['politics', 'economy', 'tech', 'sports', 'health', 'culture'].includes(s.topic));
    if (!s.enabled) assert.ok(s.note && s.note.length > 20, 'disabled source needs a reason: ' + s.id);
    if (s.maxItems !== undefined) assert.ok(s.maxItems > MAX_ITEMS_PER_FEED && s.maxItems <= MAX_ITEMS_HARD_CAP, 'invalid maxItems for ' + s.id);
  }
  assert.ok(enabledSources().length >= 5);
  assert.ok(enabledSources().every((s) => s.enabled));
  assert.equal(MAX_ITEMS_PER_FEED, 100);
  assert.equal(MAX_ITEMS_HARD_CAP, 200);
  const raised = RSS_SOURCES.filter((s) => s.maxItems !== undefined).map((s) => s.id);
  assert.deepEqual(raised, ['sana']);
  assert.equal(RSS_SOURCES.find((s) => s.id === 'sana').maxItems, 200);
});
