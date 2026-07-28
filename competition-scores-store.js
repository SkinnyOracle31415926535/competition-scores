(() => {
  'use strict';

  const APP_ID = 'competition-scores';
  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'gymnastics-class-routine-scoring-combined-v1';
  const RAW_BACKUP_KEYS = Object.freeze([
    STORAGE_KEY,
    'gymnastics-class-routine-scoring-team-points-v1',
    'gymnastics-class-routine-scoring-v2',
  ]);
  const CHANGE_EVENT = 'competition-scores-storage-change';
  const ERROR_EVENT = 'competition-scores-storage-error';
  const LOCK_NAME = 'competition-scores:aggregate-state-v1';
  const MAX_LOCAL_BYTES = 8 * 1024 * 1024;
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_ATHLETES = 1000;
  const MAX_PROFILES = 1000;
  const MAX_TEXT = 120_000;
  const EVENT_IDS = Object.freeze([
    'floor',
    'mushroom',
    'rings',
    'vault',
    'p-bars',
    'highbar',
  ]);
  const EVENT_LABELS = Object.freeze({
    floor: 'Floor',
    mushroom: 'Mushroom',
    rings: 'Rings',
    vault: 'Vault',
    'p-bars': 'P Bars',
    highbar: 'Highbar',
  });
  const EVENT_SET = new Set(EVENT_IDS);
  const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
  const STATE_KEYS = Object.freeze([
    'className',
    'meetName',
    'scoringMode',
    'date',
    'activeAthleteId',
    'activeClassProfileId',
    'judgingEventId',
    'athletes',
    'completedEventIds',
    'competition',
    'comparison',
    'savedClasses',
    'teamPoints',
  ]);
  const WORKSPACE_KEYS = Object.freeze([
    'className',
    'meetName',
    'date',
    'activeAthleteId',
    'activeClassProfileId',
    'judgingEventId',
    'athletes',
    'completedEventIds',
    'competition',
    'teamPoints',
  ]);
  const root = window;

  let mutationFence = 0;
  let pendingLocalWrites = 0;
  let fallbackLock = Promise.resolve();

  const clone = value => JSON.parse(JSON.stringify(value));
  const jsonBytes = value => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const dataObjectDescriptors = value => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch {
      return null;
    }
  };

  const plainObject = value => Boolean(dataObjectDescriptors(value));

  const safeKeys = value => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const safeEntries = value => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map(key => [key, descriptors[key].value])
      : null;
  };

  const safeArray = (value, maximum) => {
    try {
      if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string')
        || keys.length !== value.length + 1
        || !descriptors.length
        || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch {
      return null;
    }
  };

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    if (!keys || keys.length !== expected.length) return false;
    const sorted = keys.slice().sort();
    const wanted = expected.slice().sort();
    return sorted.every((key, index) => key === wanted[index]);
  };

  const validText = (value, maximum = MAX_TEXT, allowEmpty = true) => (
    typeof value === 'string'
    && value.length <= maximum
    && !value.includes('\u0000')
    && (allowEmpty || value.trim().length > 0)
  );

  const validId = (value, allowNull = false) => (
    (allowNull && value === null)
    || (
      validText(value, 160, false)
      && !RESERVED_IDS.has(value)
    )
  );

  const validNumber = (value, maximum = 1_000_000_000) => (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= maximum
  );

  const validInteger = (value, maximum = 1_000_000_000) => (
    Number.isInteger(value)
    && value >= 0
    && value <= maximum
  );

  const validStringArray = (
    value,
    maximumItems,
    maximumLength,
    unique = false,
    allowed = null,
  ) => {
    const items = safeArray(value, maximumItems);
    return Boolean(items
      && (!unique || new Set(items).size === items.length)
      && items.every(item => (
        validText(item, maximumLength, false)
        && (!allowed || allowed.has(item))
      )));
  };

  const validScore = value => (
    exactKeys(value, ['startValue', 'startConfirmed', 'tenths'])
    && validNumber(value.startValue)
    && typeof value.startConfirmed === 'boolean'
    && validInteger(value.tenths)
  );

  const validScores = value => (
    exactKeys(value, EVENT_IDS)
    && EVENT_IDS.every(eventId => validScore(value[eventId]))
  );

  const validAthlete = value => (
    exactKeys(value, ['id', 'name', 'scores'])
    && validId(value.id)
    && validText(value.name, 500, false)
    && validScores(value.scores)
  );

  const validCompetition = (value, athleteIds) => {
    if (!exactKeys(value, ['active', 'eventId', 'queue', 'completedIds'])
      || typeof value.active !== 'boolean'
      || !EVENT_SET.has(value.eventId)
      || !validStringArray(value.queue, MAX_ATHLETES, 160, true)
      || !validStringArray(value.completedIds, MAX_ATHLETES, 160, true)) {
      return false;
    }
    if (!value.queue.every(id => athleteIds.has(id))
      || !value.completedIds.every(id => athleteIds.has(id))) {
      return false;
    }
    return value.queue.every(id => !value.completedIds.includes(id));
  };

  const validTeam = value => (
    exactKeys(value, ['id', 'name', 'points', 'tally', 'members'])
    && validId(value.id)
    && validText(value.name, 500, false)
    && validInteger(value.points)
    && validInteger(value.tally)
    && validStringArray(value.members, MAX_ATHLETES, 500, true)
  );

  const validRankedScore = value => (
    exactKeys(value, ['name', 'score'])
    && validText(value.name, 500, false)
    && validNumber(value.score)
  );

  const validShuffleTeam = value => {
    if (!exactKeys(value, ['id', 'name', 'total', 'members', 'counted', 'dropped'])
      || !validId(value.id)
      || !validText(value.name, 500, false)
      || !validNumber(value.total)
      || !validStringArray(value.members, MAX_ATHLETES, 500, true)) {
      return false;
    }
    const counted = safeArray(value.counted, MAX_ATHLETES);
    const dropped = safeArray(value.dropped, MAX_ATHLETES);
    return Boolean(counted
      && dropped
      && counted.every(validRankedScore)
      && dropped.every(validRankedScore));
  };

  const validShuffleWin = value => {
    if (!exactKeys(value, [
      'eventId',
      'eventLabel',
      'teams',
      'winners',
      'awardedNames',
    ])
      || !EVENT_SET.has(value.eventId)
      || value.eventLabel !== EVENT_LABELS[value.eventId]
      || !validStringArray(value.awardedNames, MAX_ATHLETES, 500, true)) {
      return false;
    }
    const teams = safeArray(value.teams, 12);
    const winners = safeArray(value.winners, 12);
    return Boolean(teams
      && winners
      && teams.every(validShuffleTeam)
      && winners.every(validShuffleTeam));
  };

  const validTeamPoints = value => {
    if (!exactKeys(value, ['teamCount', 'mode', 'teams', 'shuffleWins'])
      || !Number.isInteger(value.teamCount)
      || value.teamCount < 2
      || value.teamCount > 12
      || !['shuffle', 'keep'].includes(value.mode)) {
      return false;
    }
    const teams = safeArray(value.teams, 12);
    const wins = safeArray(value.shuffleWins, EVENT_IDS.length);
    if (!teams
      || teams.length !== value.teamCount
      || !teams.every(validTeam)
      || new Set(teams.map(team => team.id)).size !== teams.length
      || !wins
      || !wins.every(validShuffleWin)) {
      return false;
    }
    return new Set(wins.map(record => record.eventId)).size === wins.length;
  };

  const validProfile = value => (
    exactKeys(value, ['id', 'name', 'athletes', 'updatedAt'])
    && validId(value.id)
    && validText(value.name, 500, false)
    && validStringArray(value.athletes, MAX_ATHLETES, 500)
    && validText(value.updatedAt, 100)
  );

  const validComparison = value => (
    exactKeys(value, ['name', 'raw'])
    && validText(value.name, 1000)
    && validText(value.raw, MAX_LOCAL_BYTES)
  );

  const validWorkspaceValue = (value, requireRecordSize = true) => {
    if (!exactKeys(value, WORKSPACE_KEYS)
      || !validText(value.className, 1000)
      || !validText(value.meetName, 1000)
      || !(value.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.date))
      || !validId(value.activeAthleteId, true)
      || !validId(value.activeClassProfileId, true)
      || !EVENT_SET.has(value.judgingEventId)
      || !validStringArray(
        value.completedEventIds,
        EVENT_IDS.length,
        20,
        true,
        EVENT_SET,
      )
      || !validTeamPoints(value.teamPoints)) {
      return false;
    }
    const athletes = safeArray(value.athletes, MAX_ATHLETES);
    if (!athletes || !athletes.every(validAthlete)) return false;
    const athleteIds = athletes.map(athlete => athlete.id);
    const athleteIdSet = new Set(athleteIds);
    if (athleteIdSet.size !== athleteIds.length
      || (value.activeAthleteId !== null && !athleteIdSet.has(value.activeAthleteId))
      || !validCompetition(value.competition, athleteIdSet)) {
      return false;
    }
    if (value.competition.active
      && (!value.competition.queue.length
        || value.activeAthleteId !== value.competition.queue[0]
        || value.judgingEventId !== value.competition.eventId)) {
      return false;
    }
    return !requireRecordSize || jsonBytes(value) <= MAX_RECORD_BYTES;
  };

  const validPreferencesValue = value => (
    exactKeys(value, ['scoringMode'])
    && ['individual', 'team'].includes(value.scoringMode)
    && jsonBytes(value) <= MAX_RECORD_BYTES
  );

  const validComparisonValue = value => (
    validComparison(value)
    && jsonBytes(value) <= MAX_RECORD_BYTES
  );

  const validProfileValue = value => (
    exactKeys(value, ['classId', 'position', 'profile'])
    && validId(value.classId)
    && Number.isInteger(value.position)
    && value.position >= 0
    && value.position < MAX_PROFILES
    && validProfile(value.profile)
    && value.classId === value.profile.id
    && jsonBytes(value) <= MAX_RECORD_BYTES
  );

  const validState = value => {
    if (!exactKeys(value, STATE_KEYS)
      || !['individual', 'team'].includes(value.scoringMode)
      || !validComparison(value.comparison)
      || jsonBytes(value) > MAX_LOCAL_BYTES) {
      return false;
    }
    const workspace = {};
    WORKSPACE_KEYS.forEach(key => {
      workspace[key] = value[key];
    });
    if (!validWorkspaceValue(workspace, false)) return false;
    const profiles = safeArray(value.savedClasses, MAX_PROFILES);
    if (!profiles || !profiles.every(validProfile)) return false;
    return new Set(profiles.map(profile => profile.id)).size === profiles.length;
  };

  const parseRaw = raw => {
    if (raw === null) return { status: 'absent', state: null, error: '' };
    if (typeof raw !== 'string'
      || new TextEncoder().encode(raw).byteLength > MAX_LOCAL_BYTES) {
      return {
        status: 'malformed',
        state: null,
        error: 'Competition Scores data is too large. Its exact browser value was preserved.',
      };
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        status: 'malformed',
        state: null,
        error: 'Competition Scores data is not valid JSON. Its exact browser value was preserved.',
      };
    }
    if (validState(value)) {
      return { status: 'current', state: clone(value), error: '' };
    }
    const keys = safeKeys(value) || [];
    const recognizable = keys.some(key => STATE_KEYS.includes(key));
    return {
      status: recognizable ? 'legacy' : 'malformed',
      state: null,
      error: recognizable
        ? 'Competition Scores data uses an older shape. Back it up before migration; it was not overwritten.'
        : 'Competition Scores data has an unsupported shape. Its exact browser value was preserved.',
    };
  };

  const inspection = () => {
    try {
      return parseRaw(root.localStorage.getItem(STORAGE_KEY));
    } catch {
      return {
        status: 'unavailable',
        state: null,
        error: 'Browser storage is unavailable. Competition Scores data was not changed.',
      };
    }
  };

  const initialInspection = inspection();

  const dispatchError = message => {
    root.dispatchEvent(new CustomEvent(ERROR_EVENT, {
      detail: Object.freeze({
        message: String(message || 'Competition Scores data was not changed.'),
      }),
    }));
  };

  const dispatchChange = (source, oldRaw, newRaw) => {
    root.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: Object.freeze({
        source,
        oldRaw,
        newRaw,
        key: STORAGE_KEY,
      }),
    }));
  };

  const withLock = task => {
    if (root.navigator?.locks?.request) {
      return root.navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, task);
    }
    const run = fallbackLock.then(task, task);
    fallbackLock = run.catch(() => {});
    return run;
  };

  const bridge = () => root.CompetitionScoresAppBridge || null;

  const defaultState = () => {
    const value = bridge()?.defaultState?.();
    if (!validState(value)) {
      throw new Error('Competition Scores defaults are unavailable or invalid.');
    }
    return clone(value);
  };

  const stateFromRawOrDefault = raw => {
    const parsed = parseRaw(raw);
    if (parsed.status === 'current') return clone(parsed.state);
    if (parsed.status === 'absent') return defaultState();
    throw new Error(parsed.error || 'The exact local Competition Scores value was preserved.');
  };

  const writeState = (
    nextState,
    source,
    expectedFence,
    expectedRaw,
    allowRecoveryReplacement = false,
  ) => {
    if (!validState(nextState)) {
      throw new Error('Competition Scores data has an invalid shape and was not written.');
    }
    if (jsonBytes(nextState) > MAX_LOCAL_BYTES) {
      throw new Error('Competition Scores data is too large and was not written.');
    }
    if (expectedFence !== undefined && mutationFence !== expectedFence) {
      throw new Error('A newer local Competition Scores edit was preserved.');
    }
    const actualRaw = root.localStorage.getItem(STORAGE_KEY);
    if (expectedRaw !== undefined && actualRaw !== expectedRaw) {
      throw new Error('Competition Scores changed during an atomic update. The newer value was preserved.');
    }
    const before = parseRaw(actualRaw);
    if (!allowRecoveryReplacement && !['absent', 'current'].includes(before.status)) {
      throw new Error(before.error || 'The exact local Competition Scores value was preserved.');
    }
    const nextRaw = JSON.stringify(nextState);
    root.localStorage.setItem(STORAGE_KEY, nextRaw);
    if (root.localStorage.getItem(STORAGE_KEY) !== nextRaw) {
      throw new Error('Competition Scores could not verify its local save.');
    }
    dispatchChange(source, actualRaw, nextRaw);
    return clone(nextState);
  };

  const saveCurrent = value => {
    if (!validState(value)) {
      const error = new Error('Competition Scores data has an invalid shape and was not saved.');
      dispatchError(error.message);
      return Promise.reject(error);
    }
    const snapshot = clone(value);
    const fence = ++mutationFence;
    pendingLocalWrites += 1;
    return withLock(() => {
      if (fence !== mutationFence) return clone(snapshot);
      const raw = root.localStorage.getItem(STORAGE_KEY);
      return writeState(snapshot, 'local', fence, raw);
    }).catch(error => {
      dispatchError(error.message);
      throw error;
    }).finally(() => {
      pendingLocalWrites -= 1;
    });
  };

  const requireRemoteSource = metadata => {
    if (!metadata
      || !['remote', 'migration', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid Competition Scores write source.');
    }
  };

  const waitForEditorIdle = async () => {
    const currentBridge = bridge();
    if (!currentBridge?.hasDirtyEditor?.()) return;
    if (!currentBridge.whenEditorsIdle) {
      throw new Error('An active Competition Scores editor was preserved.');
    }
    await currentBridge.whenEditorsIdle();
  };

  const assertRemoteWritable = capturedFence => {
    if (mutationFence !== capturedFence || pendingLocalWrites > 0) {
      throw new Error('A newer local Competition Scores edit was preserved.');
    }
    if (bridge()?.hasDirtyEditor?.()) {
      throw new Error('An active Competition Scores editor was preserved.');
    }
  };

  const applyMutation = async (mutator, metadata) => {
    requireRemoteSource(metadata);
    const capturedFence = mutationFence;
    if (pendingLocalWrites > 0) {
      throw new Error('Local Competition Scores work must finish before remote data is applied.');
    }
    await waitForEditorIdle();
    assertRemoteWritable(capturedFence);
    return withLock(async () => {
      assertRemoteWritable(capturedFence);
      const raw = root.localStorage.getItem(STORAGE_KEY);
      const current = stateFromRawOrDefault(raw);
      const next = await mutator(current);
      assertRemoteWritable(capturedFence);
      if (root.localStorage.getItem(STORAGE_KEY) !== raw) {
        throw new Error('Competition Scores changed during remote apply. The newer value was preserved.');
      }
      const written = writeState(next, metadata.source, capturedFence, raw);
      bridge()?.replaceState?.(written);
      return written;
    });
  };

  const sha256 = async value => {
    if (!root.crypto?.subtle) {
      throw new Error('Secure hashing is required to synchronize saved classes.');
    }
    const digest = await root.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(value)),
    );
    return Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, '0'),
    ).join('');
  };

  const recordIdFor = async (kind, sourceId) => {
    if (kind !== 'classProfile' || !validId(sourceId)) {
      throw new Error('The Competition Scores record identifier is invalid.');
    }
    return `class-${await sha256(`${APP_ID}\u001f${kind}\u001f${sourceId}`)}`;
  };

  const preferencesValue = state => ({ scoringMode: state.scoringMode });

  const workspaceValue = state => {
    const value = {};
    WORKSPACE_KEYS.forEach(key => {
      value[key] = clone(state[key]);
    });
    return value;
  };

  const comparisonValue = state => clone(state.comparison);

  const listProfileRecords = async state => Promise.all(
    state.savedClasses.map(async (profile, position) => ({
      recordId: await recordIdFor('classProfile', profile.id),
      value: {
        classId: profile.id,
        position,
        profile: clone(profile),
      },
    })),
  );

  const decompose = async state => {
    if (!validState(state)) {
      throw new Error('Competition Scores data is invalid and cannot be synchronized.');
    }
    const parts = {
      preferences: preferencesValue(state),
      workspace: workspaceValue(state),
      comparison: comparisonValue(state),
      profiles: await listProfileRecords(state),
    };
    if (!validPreferencesValue(parts.preferences)
      || !validWorkspaceValue(parts.workspace)
      || !validComparisonValue(parts.comparison)
      || !parts.profiles.every(item => validProfileValue(item.value))
      || new Set(parts.profiles.map(item => item.recordId)).size !== parts.profiles.length) {
      throw new Error(
        'A Competition Scores record exceeds 128 KiB or has an invalid shape. '
        + 'The exact local value was preserved.',
      );
    }
    return parts;
  };

  const strictCurrent = () => {
    const current = inspection();
    if (current.status === 'absent') return null;
    if (current.status !== 'current') {
      throw new Error(current.error || 'The exact local Competition Scores value was preserved.');
    }
    return clone(current.state);
  };

  const compareRecord = async (kind, recordId, expectedValue, deleted) => {
    const raw = root.localStorage.getItem(STORAGE_KEY);
    const parsed = parseRaw(raw);
    if (parsed.status === 'absent') {
      if (deleted && kind === 'profiles') return;
      throw new Error('The local Competition Scores record is missing.');
    }
    if (parsed.status !== 'current') {
      throw new Error(parsed.error || 'The exact local Competition Scores value was preserved.');
    }
    const current = clone(parsed.state);
    const parts = await decompose(current);
    if (root.localStorage.getItem(STORAGE_KEY) !== raw) {
      throw new Error(
        'Competition Scores changed while a sync record was verified. The newer value was preserved.',
      );
    }
    const source = {
      preferences: [{ recordId: 'current', value: parts.preferences }],
      workspace: [{ recordId: 'current', value: parts.workspace }],
      comparison: [{ recordId: 'current', value: parts.comparison }],
      profiles: parts.profiles,
    }[kind];
    if (!source) throw new Error('The Competition Scores record kind is invalid.');
    const found = source.find(item => item.recordId === recordId);
    if (deleted ? Boolean(found) : !found || JSON.stringify(found.value) !== JSON.stringify(expectedValue)) {
      throw new Error('A newer local Competition Scores edit was preserved instead of a stale sync write.');
    }
  };

  const verifyCurrentRecord = (kind, recordId, expectedValue, metadata) => {
    if (!metadata || metadata.source !== 'local') {
      return Promise.reject(new Error(
        'The sync client requested an invalid local Competition Scores write source.',
      ));
    }
    if (metadata.deleted && kind !== 'profiles') {
      return Promise.reject(new Error('Fixed Competition Scores records cannot be deleted.'));
    }
    return withLock(() => compareRecord(
      kind,
      recordId,
      expectedValue,
      Boolean(metadata.deleted),
    ));
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata?.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const applyPreferences = (value, metadata) => {
    rejectFixedTombstone(metadata, 'Competition Scores preferences');
    if (!validPreferencesValue(value)) {
      return Promise.reject(new Error('Synchronized Competition Scores preferences are invalid.'));
    }
    return applyMutation(state => {
      state.scoringMode = value.scoringMode;
      return state;
    }, metadata);
  };

  const applyWorkspace = (value, metadata) => {
    rejectFixedTombstone(metadata, 'Competition Scores current workspace');
    if (!validWorkspaceValue(value)) {
      return Promise.reject(new Error('The synchronized Competition Scores workspace is invalid.'));
    }
    return applyMutation(state => {
      WORKSPACE_KEYS.forEach(key => {
        state[key] = clone(value[key]);
      });
      return state;
    }, metadata);
  };

  const applyComparison = (value, metadata) => {
    rejectFixedTombstone(metadata, 'Competition Scores comparison');
    if (!validComparisonValue(value)) {
      return Promise.reject(new Error('The synchronized Competition Scores comparison is invalid.'));
    }
    return applyMutation(state => {
      state.comparison = clone(value);
      return state;
    }, metadata);
  };

  const applyProfile = async (recordId, value, metadata) => {
    const deleted = Boolean(metadata?.deleted);
    if (!/^class-[a-f0-9]{64}$/.test(recordId)
      || (!deleted && !validProfileValue(value))) {
      throw new Error('The synchronized Competition Scores class profile is invalid.');
    }
    if (!deleted
      && recordId !== await recordIdFor('classProfile', value.classId)) {
      throw new Error('The synchronized class profile ID does not match its value.');
    }
    return applyMutation(async state => {
      if (deleted) {
        const identified = await Promise.all(state.savedClasses.map(async profile => ({
          sourceId: profile.id,
          recordId: await recordIdFor('classProfile', profile.id),
        })));
        const matches = identified.filter(item => item.recordId === recordId);
        if (matches.length > 1) {
          throw new Error('Local Competition Scores class identities collide.');
        }
        if (!matches.length) return state;
        const deletedId = matches[0].sourceId;
        state.savedClasses = state.savedClasses.filter(profile => profile.id !== deletedId);
        if (state.activeClassProfileId === deletedId) state.activeClassProfileId = null;
        return state;
      }
      const entries = state.savedClasses
        .map((profile, position) => ({
          position,
          tie: profile.id,
          profile,
        }))
        .filter(entry => entry.profile.id !== value.classId);
      entries.push({
        position: value.position,
        tie: value.classId,
        profile: clone(value.profile),
      });
      entries.sort((left, right) => (
        left.position - right.position || left.tie.localeCompare(right.tie)
      ));
      state.savedClasses = entries.map(entry => entry.profile);
      return state;
    }, metadata);
  };

  const rawBackup = () => ({
    schemaVersion: 'competition-scores-browser-raw-backup-v1',
    appId: APP_ID,
    exportedAt: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map(key => {
      const rawValue = root.localStorage.getItem(key);
      return {
        key,
        present: rawValue !== null,
        rawValue,
      };
    }),
  });

  const migrationBlockers = preview => {
    if (!preview
      || !Number.isInteger(preview.writesPerformed)
      || !Number.isInteger(preview.remoteCount)
      || !Number.isInteger(preview.orphanedCount)
      || preview.writesPerformed < 0
      || preview.remoteCount < 0
      || preview.orphanedCount < 0) {
      return ['Migration preview counts are invalid.'];
    }
    const blockers = [];
    if (preview.writesPerformed !== 0) {
      blockers.push('Preview did not prove zero writes.');
    }
    if (preview.remoteCount > 0) {
      blockers.push('Synchronized Competition Scores records already exist.');
    }
    if (preview.orphanedCount > 0) {
      blockers.push('Orphaned Competition Scores sync intents need review.');
    }
    return blockers;
  };

  root.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    const capturedFence = ++mutationFence;
    const parsed = parseRaw(event.newValue);
    if (parsed.status === 'current' && !bridge()?.hasDirtyEditor?.()) {
      bridge()?.replaceState?.(clone(parsed.state));
    } else if (parsed.status === 'current') {
      const idle = bridge()?.whenEditorsIdle?.();
      if (!idle) return;
      void idle.then(() => {
        if (mutationFence !== capturedFence
          || root.localStorage.getItem(STORAGE_KEY) !== event.newValue) {
          return;
        }
        bridge()?.replaceState?.(clone(parsed.state));
      });
    } else if (!['absent'].includes(parsed.status)) {
      dispatchError(parsed.error);
    }
  });

  root.CompetitionScoresStore = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    storageKey: STORAGE_KEY,
    rawBackupKeys: RAW_BACKUP_KEYS,
    changeEvent: CHANGE_EVENT,
    errorEvent: ERROR_EVENT,
    initialInspection: () => ({
      ...initialInspection,
      state: initialInspection.state ? clone(initialInspection.state) : null,
    }),
    inspect: inspection,
    readCurrent: strictCurrent,
    validState,
    validPreferencesValue,
    validWorkspaceValue,
    validComparisonValue,
    validProfileValue,
    decompose,
    recordIdFor,
    saveCurrent,
    verifyCurrentRecord,
    applyPreferences,
    applyWorkspace,
    applyComparison,
    applyProfile,
    rawBackup,
    migrationBlockers,
    flush: () => withLock(() => undefined),
    jsonBytes,
    limits: Object.freeze({
      maxLocalBytes: MAX_LOCAL_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
      maxAthletes: MAX_ATHLETES,
      maxProfiles: MAX_PROFILES,
    }),
    __test: Object.freeze({
      parseRaw,
      exactKeys,
      plainObject,
      mutationFence: () => mutationFence,
      pendingLocalWrites: () => pendingLocalWrites,
    }),
  });
})();
