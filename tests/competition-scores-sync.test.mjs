import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const STORE_SOURCE = await fs.readFile(
  new URL('../competition-scores-store.js', import.meta.url),
  'utf8',
);

const CURRENT_KEY = 'gymnastics-class-routine-scoring-combined-v1';
const TEAM_KEY = 'gymnastics-class-routine-scoring-team-points-v1';
const INDIVIDUAL_KEY = 'gymnastics-class-routine-scoring-v2';
const EVENT_IDS = ['floor', 'mushroom', 'rings', 'vault', 'p-bars', 'highbar'];

const fixtureText = ({
  profile = false,
  athlete = false,
  comparisonRaw = '',
} = {}) => {
  const athletes = athlete
    ? [{
      id: 'athlete-1',
      name: 'Ryan',
      scores: Object.fromEntries(EVENT_IDS.map(eventId => [
        eventId,
        { startValue: 10, startConfirmed: false, tenths: 0 },
      ])),
    }]
    : [];
  const savedClasses = profile
    ? [{
      id: 'class-1',
      name: 'Level 4',
      athletes: ['Ryan'],
      updatedAt: '2026-07-28T12:00:00.000Z',
    }]
    : [];
  return JSON.stringify({
    className: profile ? 'Level 4' : '',
    meetName: '',
    scoringMode: 'individual',
    date: '2026-07-28',
    activeAthleteId: athlete ? 'athlete-1' : null,
    activeClassProfileId: profile ? 'class-1' : null,
    judgingEventId: 'floor',
    athletes,
    completedEventIds: [],
    competition: {
      active: false,
      eventId: 'floor',
      queue: [],
      completedIds: [],
    },
    comparison: {
      name: '',
      raw: comparisonRaw,
    },
    savedClasses,
    teamPoints: {
      teamCount: 2,
      mode: 'shuffle',
      teams: [
        {
          id: 'team-points-1',
          name: 'team 1',
          points: 0,
          tally: 0,
          members: [],
        },
        {
          id: 'team-points-2',
          name: 'team 2',
          points: 0,
          tally: 0,
          members: [],
        },
      ],
      shuffleWins: [],
    },
  });
};

const makeHarness = () => {
  const values = new Map();
  const listeners = new Map();
  const changes = [];
  const lockRequests = [];
  let dirty = false;
  let editorResolver = null;

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const window = {
    localStorage,
    crypto: webcrypto,
    navigator: {
      locks: {
        request: (name, _options, task) => {
          lockRequests.push(name);
          return Promise.resolve().then(task);
        },
      },
    },
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event) {
      changes.push(event);
      (listeners.get(event.type) || []).forEach(listener => listener(event));
      return true;
    },
  };
  const context = vm.createContext({
    window,
    CustomEvent: FakeCustomEvent,
    TextEncoder,
    Date,
  });
  new vm.Script(STORE_SOURCE, {
    filename: 'competition-scores-store.js',
  }).runInContext(context);

  const inRealm = text => new vm.Script(`(${text})`).runInContext(context);
  const bridge = {
    defaultState: () => inRealm(fixtureText()),
    hasDirtyEditor: () => dirty,
    whenEditorsIdle: () => (
      dirty
        ? new Promise(resolve => { editorResolver = resolve; })
        : Promise.resolve()
    ),
    replaceState: value => {
      bridge.replaced = value;
    },
    replaced: null,
  };
  window.CompetitionScoresAppBridge = bridge;

  return {
    window,
    store: window.CompetitionScoresStore,
    values,
    changes,
    lockRequests,
    inRealm,
    bridge,
    setDirty(next) {
      dirty = next;
      if (!dirty && editorResolver) {
        const resolve = editorResolver;
        editorResolver = null;
        resolve();
      }
    },
  };
};

test('decomposes only explicit bounded Competition Scores records', async () => {
  const harness = makeHarness();
  const state = harness.inRealm(fixtureText({ profile: true, athlete: true }));
  const parts = await harness.store.decompose(state);

  assert.deepEqual(Object.keys(parts), [
    'preferences',
    'workspace',
    'comparison',
    'profiles',
  ]);
  assert.equal(parts.preferences.scoringMode, 'individual');
  assert.equal(parts.workspace.athletes.length, 1);
  assert.equal(parts.profiles.length, 1);
  assert.match(parts.profiles[0].recordId, /^class-[a-f0-9]{64}$/);
  assert.ok(harness.store.jsonBytes(parts.workspace) <= 128 * 1024);
  assert.ok(harness.store.jsonBytes(parts.profiles[0].value) <= 128 * 1024);
});

test('stable class IDs do not expose class names or source IDs', async () => {
  const harness = makeHarness();
  const first = await harness.store.recordIdFor('classProfile', 'class-1');
  const second = await harness.store.recordIdFor('classProfile', 'class-1');
  const other = await harness.store.recordIdFor('classProfile', 'class-2');

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(first.includes('class-1'), false);
  assert.equal(first.length, 70);
});

test('raw backup contains exactly the current and two app-owned legacy keys', () => {
  const harness = makeHarness();
  harness.values.set(CURRENT_KEY, '{"current":true}');
  harness.values.set(TEAM_KEY, '{"team-secret":"kept"}');
  harness.values.set(INDIVIDUAL_KEY, '{"individual-secret":"kept"}');
  harness.values.set('unrelated-key', 'must-not-be-read');

  const backup = harness.store.rawBackup();
  assert.equal(
    Array.from(backup.records, record => record.key).join('\n'),
    [CURRENT_KEY, TEAM_KEY, INDIVIDUAL_KEY].join('\n'),
  );
  assert.equal(backup.records[1].rawValue, '{"team-secret":"kept"}');
  assert.equal(JSON.stringify(backup).includes('unrelated-key'), false);
});

test('legacy blobs are never decomposed into upload records', async () => {
  const harness = makeHarness();
  harness.values.set(TEAM_KEY, JSON.stringify({ password: 'legacy-team-value' }));
  harness.values.set(INDIVIDUAL_KEY, JSON.stringify({ password: 'legacy-individual-value' }));
  const state = harness.inRealm(fixtureText());
  const parts = await harness.store.decompose(state);
  const uploadText = JSON.stringify(parts);

  assert.equal(uploadText.includes('legacy-team-value'), false);
  assert.equal(uploadText.includes('legacy-individual-value'), false);
});

test('strict validation rejects malformed, legacy, prototype, and oversized records', async () => {
  const harness = makeHarness();
  assert.equal(harness.store.__test.parseRaw('{').status, 'malformed');
  assert.equal(
    harness.store.__test.parseRaw(JSON.stringify({ className: 'old' })).status,
    'legacy',
  );

  const poisoned = harness.inRealm(fixtureText());
  new vm.Script('Object.setPrototypeOf(candidate, { polluted: true })')
    .runInContext(vm.createContext({ candidate: poisoned }));
  assert.equal(harness.store.validState(poisoned), false);

  const tooLarge = harness.inRealm(fixtureText({
    comparisonRaw: 'x'.repeat(130 * 1024),
  }));
  assert.equal(harness.store.validState(tooLarge), true);
  await assert.rejects(
    harness.store.decompose(tooLarge),
    /exceeds 128 KiB/,
  );
});

test('local save happens before queue events and stale local verification fails', async () => {
  const harness = makeHarness();
  const first = harness.inRealm(fixtureText());
  await harness.store.saveCurrent(first);
  const firstParts = await harness.store.decompose(first);
  const change = harness.changes.find(
    event => event.type === harness.store.changeEvent,
  );

  assert.ok(change);
  assert.ok(
    harness.lockRequests.includes('competition-scores:aggregate-state-v1'),
  );
  assert.equal(
    harness.values.get(CURRENT_KEY),
    change.detail.newRaw,
  );

  const second = harness.inRealm(fixtureText());
  second.scoringMode = 'team';
  await harness.store.saveCurrent(second);
  await assert.rejects(
    harness.store.verifyCurrentRecord(
      'preferences',
      'current',
      firstParts.preferences,
      { source: 'local' },
    ),
    /newer local Competition Scores edit/,
  );
});

test('compare-and-set rejects an external write during remote apply', async () => {
  const harness = makeHarness();
  const first = harness.inRealm(fixtureText());
  await harness.store.saveCurrent(first);
  const remoteWorkspace = (await harness.store.decompose(first)).workspace;
  remoteWorkspace.meetName = 'Remote meet';

  const originalGet = harness.window.localStorage.getItem;
  let injected = false;
  harness.window.localStorage.getItem = key => {
    const value = originalGet(key);
    if (!injected && key === CURRENT_KEY) {
      injected = true;
      queueMicrotask(() => {
        const external = JSON.parse(value);
        external.meetName = 'External tab meet';
        harness.values.set(CURRENT_KEY, JSON.stringify(external));
      });
    }
    return value;
  };

  await assert.rejects(
    harness.store.applyWorkspace(remoteWorkspace, {
      source: 'remote',
      deleted: false,
    }),
    /changed during remote apply/,
  );
  assert.equal(
    JSON.parse(harness.values.get(CURRENT_KEY)).meetName,
    'External tab meet',
  );
});

test('editor deferral plus mutation fencing preserves a newer local edit', async () => {
  const harness = makeHarness();
  const first = harness.inRealm(fixtureText());
  await harness.store.saveCurrent(first);
  harness.setDirty(true);

  const remote = harness.store.applyPreferences(
    harness.inRealm('{"scoringMode":"team"}'),
    { source: 'remote', deleted: false },
  );
  await Promise.resolve();

  const newer = harness.inRealm(fixtureText());
  newer.meetName = 'New local meet';
  await harness.store.saveCurrent(newer);
  harness.setDirty(false);

  await assert.rejects(remote, /newer local Competition Scores edit/);
  assert.equal(
    JSON.parse(harness.values.get(CURRENT_KEY)).meetName,
    'New local meet',
  );
});

test('cross-tab state waits for an active editor to become idle', async () => {
  const harness = makeHarness();
  const first = harness.inRealm(fixtureText());
  await harness.store.saveCurrent(first);
  harness.setDirty(true);

  const external = JSON.parse(fixtureText());
  external.meetName = 'Other tab meet';
  const externalRaw = JSON.stringify(external);
  harness.values.set(CURRENT_KEY, externalRaw);
  harness.window.dispatchEvent({
    type: 'storage',
    key: CURRENT_KEY,
    newValue: externalRaw,
  });

  assert.equal(harness.bridge.replaced, null);
  harness.setDirty(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.bridge.replaced.meetName, 'Other tab meet');
});

test('fixed tombstones fail and class tombstones are idempotent and safe', async () => {
  const harness = makeHarness();
  const state = harness.inRealm(fixtureText({ profile: true, athlete: true }));
  await harness.store.saveCurrent(state);
  const parts = await harness.store.decompose(state);
  const recordId = parts.profiles[0].recordId;

  assert.throws(
    () => harness.store.applyPreferences(null, {
      source: 'remote',
      deleted: true,
    }),
    /fixed record/,
  );

  await harness.store.applyProfile(recordId, null, {
    source: 'remote',
    deleted: true,
  });
  let saved = JSON.parse(harness.values.get(CURRENT_KEY));
  assert.equal(saved.savedClasses.length, 0);
  assert.equal(saved.activeClassProfileId, null);

  await harness.store.applyProfile(recordId, null, {
    source: 'remote',
    deleted: true,
  });
  saved = JSON.parse(harness.values.get(CURRENT_KEY));
  assert.equal(saved.savedClasses.length, 0);
});

test('migration gate requires zero writes, zero remote, and zero orphaned', () => {
  const { store } = makeHarness();
  assert.equal(
    Array.from(store.migrationBlockers({
      writesPerformed: 0,
      remoteCount: 0,
      orphanedCount: 0,
    })).length,
    0,
  );
  assert.equal(
    store.migrationBlockers({
      writesPerformed: 1,
      remoteCount: 2,
      orphanedCount: 3,
    }).length,
    3,
  );
  assert.equal(store.migrationBlockers({}).length, 1);
});
