(() => {
  'use strict';

  const APP_ID = 'competition-scores';
  const MANIFEST_VERSION = 1;
  const SOURCE_KEY = 'gymnastics-class-routine-scoring-combined-v1';
  const store = window.CompetitionScoresStore;
  const bridge = window.CompetitionScoresAppBridge;
  const status = document.getElementById('status');
  const titlebar = document.querySelector('.titlebar');

  if (!document.body || !store || !bridge || !titlebar || !status) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'competition-sync-open';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'Sync & backup';
  titlebar.append(openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'competition-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'competition-sync-title');
  dialog.innerHTML = `
    <div class="competition-sync-window">
      <div class="competition-sync-heading">
        <div>
          <p class="competition-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="competition-sync-title">Sync &amp; backup</h2>
        </div>
        <button type="button" class="competition-sync-close"
          data-competition-sync-close aria-label="Close sync and backup window">×</button>
      </div>
      <p class="competition-sync-copy">
        Scoring preferences, the current workspace, comparison text, and saved class
        profiles sync as separate Competition Scores records. Every edit saves in this
        browser first.
      </p>
      <p class="competition-sync-safety">
        Only validated records derived from Competition Scores’ combined value are eligible
        for upload. The two older app-owned values are included only in the exact local backup
        and are never sent as generic records.
      </p>
      <div class="competition-sync-state" data-competition-sync-state
        data-state="disconnected">
        <strong data-competition-sync-state-label>Disconnected</strong>
        <span data-competition-sync-state-message>
          Competition Scores data stays on this device.
        </span>
      </div>
      <p class="competition-sync-alert" data-competition-sync-alert role="alert" hidden></p>
      <div class="competition-sync-actions">
        <button type="button" class="is-primary" data-competition-sync-connect
          data-sync-action>Connect as Ryan</button>
        <button type="button" data-competition-sync-now data-sync-action>Sync now</button>
        <button type="button" data-competition-sync-backup data-sync-action>
          Download exact local backup
        </button>
        <button type="button" data-competition-sync-preview data-sync-action>
          Create backup &amp; preview
        </button>
        <button type="button" data-competition-sync-disconnect
          data-sync-action>Disconnect</button>
        <button type="button" data-competition-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="competition-sync-review" data-competition-sync-review hidden
        aria-labelledby="competition-sync-review-title">
        <h3 id="competition-sync-review-title">Migration preview</h3>
        <p data-competition-sync-counts></p>
        <p class="competition-sync-zero-write" data-competition-sync-zero-write></p>
        <div data-competition-sync-records></div>
        <button type="button" class="is-primary" data-competition-sync-apply
          data-sync-action disabled>Apply reviewed migration</button>
      </section>
      <section class="competition-sync-conflicts" data-competition-sync-conflicts hidden
        aria-labelledby="competition-sync-conflicts-title">
        <h3 id="competition-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose every result deliberately. Nothing is selected automatically.</p>
        <div data-competition-sync-conflict-list></div>
      </section>
      <p class="competition-sync-footnote">
        Active scoring fields defer synchronized changes until focus leaves the editor.
        Resetting the connection never deletes any browser-local scoring value.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-competition-sync-close]');
  const connectButton = dialog.querySelector('[data-competition-sync-connect]');
  const syncButton = dialog.querySelector('[data-competition-sync-now]');
  const backupButton = dialog.querySelector('[data-competition-sync-backup]');
  const previewButton = dialog.querySelector('[data-competition-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-competition-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-competition-sync-reset]');
  const applyButton = dialog.querySelector('[data-competition-sync-apply]');
  const stateBox = dialog.querySelector('[data-competition-sync-state]');
  const stateLabel = dialog.querySelector('[data-competition-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-competition-sync-state-message]');
  const alertBox = dialog.querySelector('[data-competition-sync-alert]');
  const review = dialog.querySelector('[data-competition-sync-review]');
  const counts = dialog.querySelector('[data-competition-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-competition-sync-zero-write]');
  const records = dialog.querySelector('[data-competition-sync-records]');
  const conflicts = dialog.querySelector('[data-competition-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-competition-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let preferencesHandle = null;
  let workspaceHandle = null;
  let comparisonHandle = null;
  let profilesHandle = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let restoreFocus = null;
  let lastQueuedRaw = null;
  let queuedRaw;
  let captureScheduled = false;
  let localCapture = Promise.resolve();
  let partsCacheRaw;
  let partsCachePromise = null;

  const stateLabels = Object.freeze({
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  });

  const buttonLabels = Object.freeze({
    disconnected: 'Sync & backup',
    review: 'Review sync',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline backup',
    conflict: 'Resolve sync',
  });

  const showAlert = (message = '') => {
    alertBox.hidden = !message;
    alertBox.textContent = message;
  };

  const downloadJson = (value, filename) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `competition-scores-browser-local-raw-backup-${today}.json`,
    );
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const updateApplyAvailability = () => {
    if (busy || !previewResult) {
      applyButton.disabled = true;
      return;
    }
    const choices = Array.from(records.querySelectorAll('select[data-record-key]'));
    const blocked = records.querySelector('[data-competition-migration-blocked]');
    applyButton.disabled = Boolean(blocked) || choices.some(select => !select.value);
  };

  const setBusy = next => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach(button => {
      if (button === applyButton && !next) return;
      button.disabled = next;
    });
    if (!next) updateApplyAvailability();
  };

  const makeReviewRow = item => {
    const row = document.createElement('div');
    row.className = 'competition-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = `${item.collection} · ${item.recordId}`;
    const itemStatus = document.createElement('span');
    itemStatus.className = 'competition-sync-record-status';
    itemStatus.textContent = String(item.status || '').replaceAll('-', ' ');
    row.append(identity, itemStatus);
    if (item.status === 'content-conflict') {
      const label = document.createElement('label');
      label.textContent = 'Choose result';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = `
        <option value="">Choose…</option>
        <option value="keep-local">Keep this device</option>
        <option value="accept-remote">Use synchronized record</option>
      `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict' && item.localPresent) {
      const label = document.createElement('label');
      label.textContent = 'Unsupported remote schema';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = `
        <option value="">Choose…</option>
        <option value="keep-local">Keep this device</option>
      `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict') {
      const blocked = document.createElement('p');
      blocked.dataset.competitionMigrationBlocked = '';
      blocked.textContent =
        'This remote schema is unsupported. Local scoring data was preserved.';
      row.append(blocked);
    }
    return row;
  };

  const renderPreview = result => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · `
      + `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · `
      + `${result.preview.orphanedCount} orphaned`;
    const blockers = store.migrationBlockers(result.preview);
    zeroWrite.textContent = blockers.length
      ? blockers.join(' ')
      : 'Preview confirmed: 0 writes, 0 remote records, and 0 orphaned intents.';
    zeroWrite.dataset.safe = String(blockers.length === 0);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    blockers.forEach(message => {
      const blocked = document.createElement('p');
      blocked.dataset.competitionMigrationBlocked = '';
      blocked.textContent = message;
      records.prepend(blocked);
    });
    if (!result.preview.review.length && !blockers.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No local or synchronized Competition Scores records were found.';
      records.append(empty);
    }
    updateApplyAvailability();
  };

  const showState = next => {
    const mode = next?.state || next?.mode || 'disconnected';
    stateBox.dataset.state = mode;
    openButton.dataset.state = mode;
    openButton.textContent = buttonLabels[mode] || 'Sync & backup';
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent =
      next?.message || 'Competition Scores data stays on this device.';
    if (mode === 'conflict') void renderConflicts();
  };

  const resolveConflict = async (item, strategy) => {
    const revision = Number.isSafeInteger(item.current?.revision)
      ? item.current.revision
      : 0;
    await client.resolveConflict(item.recordKey, {
      strategy,
      expectedRemoteRevision: revision,
    });
    await renderConflicts();
  };

  const renderConflicts = async () => {
    if (!client) return;
    const items = await client.listConflicts();
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren();
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'competition-sync-conflict';
      const title = document.createElement('strong');
      const pieces = String(item.recordKey || '').split('\u001f');
      title.textContent = pieces.slice(-2).join(' · ') || 'Competition Scores record';
      const reason = document.createElement('span');
      reason.textContent = `Reason: ${String(item.reason || 'record conflict').replaceAll('-', ' ')}`;
      const actions = document.createElement('div');
      actions.className = 'competition-sync-conflict-actions';
      [
        ['Keep this device', 'keep-local'],
        ['Use synchronized record', 'accept-remote'],
      ].forEach(([label, strategy]) => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = label;
        choice.addEventListener('click', () => {
          void runAction(() => resolveConflict(item, strategy));
        });
        actions.append(choice);
      });
      card.append(title, reason, actions);
      conflictList.append(card);
    });
  };

  const requireLocalSource = metadata => {
    if (!metadata || metadata.source !== 'local') {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = metadata => {
    if (!metadata
      || !['remote', 'migration', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid synchronized write source.');
    }
  };

  const currentParts = async () => {
    const current = store.readCurrent();
    if (!current) {
      partsCacheRaw = null;
      partsCachePromise = null;
      return null;
    }
    const raw = JSON.stringify(current);
    if (raw !== partsCacheRaw || !partsCachePromise) {
      partsCacheRaw = raw;
      partsCachePromise = store.decompose(current).catch(error => {
        if (partsCacheRaw === raw) {
          partsCacheRaw = undefined;
          partsCachePromise = null;
        }
        throw error;
      });
    }
    return partsCachePromise;
  };

  const fixedAdapter = (collection, kind, validate, apply) => ({
    scope: APP_ID,
    appId: APP_ID,
    collection,
    recordId: 'current',
    schemaVersion: 1,
    validate,
    readLocal: async () => (await currentParts())?.[kind],
    writeLocal: (value, metadata) => {
      if (metadata.source === 'local') {
        requireLocalSource(metadata);
        return store.verifyCurrentRecord(kind, 'current', value, metadata);
      }
      requireRemoteSource(metadata);
      return apply(value, metadata);
    },
    applyRemote: (value, metadata) => {
      requireRemoteSource(metadata);
      return apply(value, metadata);
    },
  });

  const preferencesAdapter = fixedAdapter(
    'preferences',
    'preferences',
    store.validPreferencesValue,
    store.applyPreferences,
  );
  const workspaceAdapter = fixedAdapter(
    'current-workspace',
    'workspace',
    store.validWorkspaceValue,
    store.applyWorkspace,
  );
  const comparisonAdapter = fixedAdapter(
    'comparison',
    'comparison',
    store.validComparisonValue,
    store.applyComparison,
  );
  const profilesAdapter = {
    scope: APP_ID,
    appId: APP_ID,
    collection: 'saved-class-profiles',
    schemaVersion: 1,
    validate: store.validProfileValue,
    listLocal: async () => (await currentParts())?.profiles || [],
    writeLocal: (recordId, value, metadata) => {
      if (metadata.source === 'local') {
        requireLocalSource(metadata);
        return store.verifyCurrentRecord('profiles', recordId, value, metadata);
      }
      requireRemoteSource(metadata);
      return store.applyProfile(recordId, value, metadata);
    },
    applyRemote: (recordId, value, metadata) => {
      requireRemoteSource(metadata);
      return store.applyProfile(recordId, value, metadata);
    },
  };

  const runAction = async action => {
    if (busy) return;
    showAlert('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showAlert(
        error instanceof Error
          ? error.message
          : 'The action did not finish. Local scoring data was preserved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const initialize = async () => {
    const local = store.inspect();
    if (!['absent', 'current'].includes(local.status)) {
      throw new Error(local.error || 'Exact local scoring data was preserved for recovery.');
    }
    if (!window.RyanAppSync?.create) {
      throw new Error('Ryan App Sync is unavailable. Exact local backup still works.');
    }
    const initialCurrent = store.readCurrent();
    lastQueuedRaw = initialCurrent ? JSON.stringify(initialCurrent) : null;
    client = window.RyanAppSync.create({
      appId: APP_ID,
      manifestVersion: MANIFEST_VERSION,
      serviceOrigin: 'https://ryan-app-sync.ryan-666-mp3.chatgpt.site',
      deviceLabel: `Competition Scores · ${navigator.platform || 'browser'}`,
      showStatus: false,
    });
    client.onStateChange(showState);
    preferencesHandle = await client.register(preferencesAdapter);
    workspaceHandle = await client.register(workspaceAdapter);
    comparisonHandle = await client.register(comparisonAdapter);
    profilesHandle = await client.registerCollection(profilesAdapter);
    await client.finalizeRegistration();
    initialized = true;
    showState(client.getState());
  };

  const ready = initialize().catch(error => {
    showAlert(error instanceof Error ? error.message : 'Ryan App Sync could not initialize.');
    stateMessage.textContent =
      'Exact local backup remains available; synchronization is unavailable.';
    [connectButton, syncButton, previewButton, disconnectButton, resetButton]
      .forEach(button => { button.hidden = true; });
    openButton.dataset.state = 'offline';
    openButton.textContent = 'Offline backup';
    throw error;
  });
  ready.catch(() => {});

  const recordMap = items => new Map(
    (items || []).map(item => [item.recordId, item.value]),
  );

  const queueFixed = async (handle, oldValue, nextValue) => {
    if (nextValue === undefined) {
      throw new Error('Fixed Competition Scores records cannot be removed.');
    }
    if (JSON.stringify(oldValue) !== JSON.stringify(nextValue)) {
      await handle.save(nextValue);
    }
  };

  const queueCollection = async (handle, oldItems, nextItems) => {
    const oldMap = recordMap(oldItems);
    const nextMap = recordMap(nextItems);
    for (const [recordId, value] of nextMap) {
      if (JSON.stringify(oldMap.get(recordId)) !== JSON.stringify(value)) {
        await handle.save(recordId, value);
      }
    }
    for (const recordId of oldMap.keys()) {
      if (!nextMap.has(recordId)) await handle.remove(recordId);
    }
  };

  const queueStateDiff = async (oldState, nextState) => {
    if (!nextState) {
      throw new Error('Removing the combined Competition Scores value is not a sync operation.');
    }
    const oldParts = oldState ? await store.decompose(oldState) : null;
    const nextParts = await store.decompose(nextState);
    await queueFixed(preferencesHandle, oldParts?.preferences, nextParts.preferences);
    await queueFixed(workspaceHandle, oldParts?.workspace, nextParts.workspace);
    await queueFixed(comparisonHandle, oldParts?.comparison, nextParts.comparison);
    await queueCollection(profilesHandle, oldParts?.profiles, nextParts.profiles);
  };

  const parseCurrentRaw = raw => {
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!store.validState(value)) {
      throw new Error(
        'A changed Competition Scores value was invalid. It stayed local and was not synchronized.',
      );
    }
    return value;
  };

  const processLocalCaptures = async () => {
    while (queuedRaw !== undefined) {
      await new Promise(resolve => window.setTimeout(resolve, 75));
      const requestedRaw = queuedRaw;
      queuedRaw = undefined;
      await ready;
      await store.flush();
      const current = store.inspect();
      const actualRaw = current.status === 'current'
        ? JSON.stringify(current.state)
        : null;
      if (requestedRaw !== actualRaw) {
        queuedRaw = actualRaw;
        continue;
      }
      if (actualRaw === lastQueuedRaw) continue;
      await queueStateDiff(
        parseCurrentRaw(lastQueuedRaw),
        parseCurrentRaw(actualRaw),
      );
      lastQueuedRaw = actualRaw;
      invalidatePreview();
    }
  };

  const queueLatestLocalCapture = raw => {
    queuedRaw = raw;
    if (captureScheduled) return;
    captureScheduled = true;
    localCapture = localCapture.then(processLocalCaptures).catch(error => {
      queuedRaw = undefined;
      showAlert(
        error instanceof Error
          ? error.message
          : 'The local edit stayed saved but could not be queued for synchronization.',
      );
    }).finally(() => {
      captureScheduled = false;
      if (queuedRaw !== undefined) queueLatestLocalCapture(queuedRaw);
    });
  };

  window.addEventListener(store.changeEvent, event => {
    const detail = event.detail;
    if (!detail || detail.key !== store.storageKey) return;
    partsCacheRaw = undefined;
    partsCachePromise = null;
    if (detail.source === 'local') {
      queueLatestLocalCapture(detail.newRaw);
      return;
    }
    lastQueuedRaw = detail.newRaw;
    invalidatePreview();
  });

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
    void renderConflicts();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    restoreFocus?.focus?.();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.connect();
    });
  });
  syncButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.sync();
    });
  });
  backupButton.addEventListener('click', () => {
    try {
      downloadRawBackup();
      showAlert('');
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'The exact backup could not be created.');
    }
  });
  previewButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      await ready;
      renderPreview(await client.previewMigration({
        sourceKey: SOURCE_KEY,
        downloadBackup: true,
      }));
    });
  });
  applyButton.addEventListener('click', () => {
    void runAction(async () => {
      if (!previewResult) throw new Error('Create a fresh migration preview first.');
      const blockers = store.migrationBlockers(previewResult.preview);
      if (blockers.length) throw new Error(`Migration is blocked. ${blockers.join(' ')}`);
      const resolutions = {};
      records.querySelectorAll('select[data-record-key]').forEach(select => {
        if (select.value) resolutions[select.dataset.recordKey] = select.value;
      });
      await client.applyMigration(previewResult.plan, resolutions);
      invalidatePreview();
    });
  });
  disconnectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.disconnect();
      invalidatePreview();
    });
  });
  resetButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.resetDevice();
      invalidatePreview();
    });
  });

  window.CompetitionScoresSync = Object.freeze({
    appId: APP_ID,
    manifestVersion: MANIFEST_VERSION,
    sourceKey: SOURCE_KEY,
    ready,
    open: () => openButton.click(),
    rawBackup: store.rawBackup,
    adapters: Object.freeze({
      preferences: preferencesAdapter,
      workspace: workspaceAdapter,
      comparison: comparisonAdapter,
      profiles: profilesAdapter,
    }),
    __test: Object.freeze({
      queueStateDiff,
      parseCurrentRaw,
      migrationBlockers: store.migrationBlockers,
    }),
  });
})();
