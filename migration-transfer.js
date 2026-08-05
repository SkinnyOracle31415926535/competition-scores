(() => {
  "use strict";

  const config = window.AppMigrationConfig;
  if (!config || typeof config.appId !== "string" || !config.appId) return;

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plainObject = (value) => Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const text = (value) => String(value || "");

  const status = {
    host: null,
    message: null,
    preview: null,
    candidate: null,
  };

  const ownKey = (key) => typeof key === "string"
    && key.length > 0
    && (Array.isArray(config.ownedKeys) && config.ownedKeys.includes(key)
      || typeof config.ownsKey === "function" && config.ownsKey(key));

  const currentKeys = () => {
    const keys = new Set(Array.isArray(config.ownedKeys) ? config.ownedKeys : []);
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (ownKey(key)) keys.add(key);
      }
    } catch (error) {
      throw new Error("Browser storage is unavailable, so this transfer cannot continue.");
    }
    return [...keys].sort();
  };

  const rawRecords = (keys = currentKeys()) => keys.map((key) => ({
    key,
    raw: localStorage.getItem(key),
  }));

  const recordsForExport = (records) => records.map(({ key, raw }) => {
    const record = { key, present: raw !== null };
    if (raw === null) return record;
    try {
      record.value = JSON.parse(raw);
    } catch (_error) {
      // Settings such as plain-text notes are intentionally retained as raw text.
      record.rawValue = raw;
    }
    return record;
  });

  const buildEnvelope = (records = rawRecords()) => ({
    kind: "ryan-app-transfer",
    schemaVersion: 1,
    appId: config.appId,
    exportedAt: new Date().toISOString(),
    storage: {
      format: "browser-local-storage-records-v1",
      records: recordsForExport(records),
    },
  });

  const download = (payload, suffix = "transfer") => {
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${config.appId}-${suffix}-${date}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const setMessage = (message, kind = "") => {
    if (!status.message) return;
    status.message.textContent = message;
    status.message.dataset.kind = kind;
  };

  const rawFromRecord = (record) => {
    if (!plainObject(record) || typeof record.key !== "string" || typeof record.present !== "boolean") {
      throw new Error("The transfer has an invalid storage record.");
    }
    if (!record.present) {
      if (hasOwn(record, "value") || hasOwn(record, "rawValue")) {
        throw new Error("An empty transfer record contained unexpected data.");
      }
      return null;
    }
    if (hasOwn(record, "rawValue")) {
      if (typeof record.rawValue !== "string" || hasOwn(record, "value")) {
        throw new Error("The transfer has an invalid raw storage value.");
      }
      return record.rawValue;
    }
    if (!hasOwn(record, "value")) {
      throw new Error("The transfer has a missing storage value.");
    }
    try {
      const raw = JSON.stringify(record.value);
      if (typeof raw !== "string") throw new Error("not JSON");
      return raw;
    } catch (_error) {
      throw new Error("The transfer includes a value that cannot be restored safely.");
    }
  };

  const normalizedRecords = (records, source = "transfer") => {
    if (!Array.isArray(records)) throw new Error("The transfer does not contain a record list.");
    const seen = new Set();
    const normalized = [];
    for (const record of records) {
      if (!plainObject(record) || !ownKey(record.key)) {
        throw new Error("The transfer contains data for a different app.");
      }
      if (seen.has(record.key)) throw new Error("The transfer has duplicate storage records.");
      seen.add(record.key);
      normalized.push({ key: record.key, raw: rawFromRecord(record) });
    }
    if (!normalized.length && source === "transfer") {
      throw new Error("The transfer did not contain any app data.");
    }
    return normalized;
  };

  const normalizeFile = (payload) => {
    if (plainObject(payload)
      && payload.kind === "ryan-app-transfer") {
      if (payload.schemaVersion !== 1) {
        throw new Error("This transfer file uses an unsupported version.");
      }
      if (payload.appId !== config.appId) {
        throw new Error(`This file is for ${text(payload.appId) || "another app"}, not ${config.appId}.`);
      }
      if (!plainObject(payload.storage)
        || payload.storage.format !== "browser-local-storage-records-v1") {
        throw new Error("This transfer file has an unsupported storage format.");
      }
      return {
        records: normalizedRecords(payload.storage.records),
        sourceLabel: "transfer file",
      };
    }

    if (typeof config.normalizeLegacyBackup === "function") {
      const legacy = config.normalizeLegacyBackup(payload);
      if (legacy) {
        return {
          records: normalizedRecords(legacy.records, "legacy"),
          sourceLabel: legacy.label || "existing app backup",
        };
      }
    }
    throw new Error("This is not a recognized transfer or backup file for this app.");
  };

  const recordsToMap = (records) => new Map(records.map(({ key, raw }) => [key, raw]));

  const validate = (records) => {
    const map = recordsToMap(records);
    if (typeof config.validateRecords === "function") {
      const result = config.validateRecords(map);
      if (result === false) throw new Error("The transfer data did not pass this app’s validation.");
    }
    return map;
  };

  const countCurrent = () => rawRecords().filter((record) => record.raw !== null).length;
  const countIncoming = (records) => records.filter((record) => record.raw !== null).length;

  const showPreview = (candidate, fileName) => {
    status.candidate = candidate;
    const incoming = countIncoming(candidate.records);
    const current = countCurrent();
    const summary = typeof config.summarizeRecords === "function"
      ? config.summarizeRecords(recordsToMap(candidate.records))
      : `${incoming} saved data record${incoming === 1 ? "" : "s"}`;
    status.preview.hidden = false;
    status.preview.querySelector("[data-transfer-preview-copy]").textContent =
      `${fileName} contains ${summary}. It will replace ${current} current local record${current === 1 ? "" : "s"}. `
      + "Confirming first downloads a safety backup of this device.";
    setMessage("Review the transfer preview, then confirm replacement.", "ready");
  };

  const importFile = async (file) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const candidate = normalizeFile(parsed);
      validate(candidate.records);
      showPreview(candidate, file.name || "Selected file");
    } catch (error) {
      status.candidate = null;
      status.preview.hidden = true;
      setMessage(error instanceof Error ? error.message : "The selected file could not be read.", "error");
    }
  };

  const restoreSnapshot = (snapshot) => {
    for (const { key, raw } of snapshot) {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    }
  };

  const applyCandidate = async () => {
    const candidate = status.candidate;
    if (!candidate) return;
    let snapshot = null;
    try {
      setMessage("Preparing the local safety backup…", "working");
      if (typeof config.beforeReplace === "function") await config.beforeReplace();
      const targetKeys = new Set(currentKeys());
      candidate.records.forEach((record) => targetKeys.add(record.key));
      snapshot = rawRecords([...targetKeys].sort());
      download(buildEnvelope(snapshot), "before-import");

      const values = recordsToMap(candidate.records);
      for (const key of targetKeys) {
        const raw = values.has(key) ? values.get(key) : null;
        if (raw === null) localStorage.removeItem(key);
        else localStorage.setItem(key, raw);
      }
      setMessage("Transfer restored. Reloading this app with the imported data…", "success");
      window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      if (snapshot) {
        try {
          // A partial localStorage write should never leave the destination half-replaced.
          restoreSnapshot(snapshot);
        } catch (_rollbackError) {
          // Browser storage failure is reported below; the pre-import download still preserves the prior state.
        }
      }
      setMessage(error instanceof Error ? error.message : "The transfer could not be applied.", "error");
    }
  };

  const syncStateKey = `__ryan_private_sync_${config.appId}_v1`;
  const syncSupported = () => location.protocol === "https:"
    && location.hostname.endsWith(".chatgpt.site");
  const syncValue = (raw) => {
    if (raw === null) return { present: false, encoding: "text", value: null };
    try {
      return { present: true, encoding: "json", value: JSON.parse(raw) };
    } catch (_error) {
      return { present: true, encoding: "text", value: raw };
    }
  };
  const rawFromSyncValue = (value) => {
    if (!plainObject(value) || typeof value.present !== "boolean"
      || !["json", "text"].includes(value.encoding)) {
      throw new Error("The synchronized record has an unsupported schema.");
    }
    if (!value.present) {
      if (value.encoding !== "text" || value.value !== null) {
        throw new Error("The synchronized empty record is invalid.");
      }
      return null;
    }
    if (value.encoding === "text") {
      if (typeof value.value !== "string") throw new Error("The synchronized text record is invalid.");
      return value.value;
    }
    try {
      const raw = JSON.stringify(value.value);
      if (typeof raw !== "string") throw new Error("not JSON");
      return raw;
    } catch (_error) {
      throw new Error("The synchronized JSON record is invalid.");
    }
  };
  const fingerprint = (value) => JSON.stringify(value);
  const readSyncState = () => {
    try {
      const value = JSON.parse(localStorage.getItem(syncStateKey) || "null");
      if (!plainObject(value) || typeof value.enabled !== "boolean" || !plainObject(value.records)) {
        return { enabled: false, records: {} };
      }
      return { enabled: value.enabled, records: value.records };
    } catch (_error) {
      return { enabled: false, records: {} };
    }
  };
  const saveSyncState = (state) => localStorage.setItem(syncStateKey, JSON.stringify(state));
  const responseJson = async (response) => {
    try { return await response.json(); } catch (_error) { return null; }
  };
  const applyRemoteValue = (key, value) => {
    const raw = rawFromSyncValue(value);
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) {
      throw new Error("Browser storage did not confirm the synchronized record.");
    }
  };
  const downloadConflict = (conflict) => download({
    kind: "ryan-app-sync-conflict",
    schemaVersion: 1,
    appId: config.appId,
    createdAt: new Date().toISOString(),
    recordId: conflict.key,
    local: conflict.local,
    remote: conflict.remote,
  }, `sync-conflict-${conflict.key.replace(/[^a-z0-9]+/gi, "-").slice(0, 80)}`);

  const configureSync = (host) => {
    const section = host.querySelector("[data-transfer-sync]");
    const syncCopy = host.querySelector("[data-transfer-sync-status]");
    const syncButton = host.querySelector("[data-transfer-sync-now]");
    const conflictsNode = host.querySelector("[data-transfer-conflicts]");
    if (!section || !syncCopy || !syncButton || !conflictsNode || !syncSupported()) return;
    section.hidden = false;

    const update = (message, kind = "") => {
      syncCopy.textContent = message;
      syncCopy.dataset.kind = kind;
    };
    const sync = async (interactive = false) => {
      update("Syncing this private site…", "working");
      let response;
      try {
        response = await fetch(`/api/app-sync?appId=${encodeURIComponent(config.appId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
      } catch (_error) {
        update("Offline. Local data is preserved and will retry later.", "offline");
        return;
      }
      const manifest = await responseJson(response);
      if (!response.ok || !plainObject(manifest) || !Array.isArray(manifest.records)) {
        update(manifest?.error || "Private sync is unavailable. Local data is preserved.", "offline");
        return;
      }
      const remote = new Map();
      for (const record of manifest.records) {
        if (!plainObject(record) || !ownKey(record.recordId)
          || !Number.isSafeInteger(record.revision) || record.revision < 1) {
          update("A synchronized record is invalid and was not applied.", "error");
          return;
        }
        try { rawFromSyncValue(record.value); } catch (error) {
          update(error instanceof Error ? error.message : "A synchronized record is invalid.", "error");
          return;
        }
        remote.set(record.recordId, record);
      }
      const state = readSyncState();
      const conflicts = [];
      let changed = 0;
      let appliedRemote = false;
      const keys = new Set([...currentKeys(), ...remote.keys()]);
      const upload = async (key, value, expectedRevision) => {
        const result = await fetch("/api/app-sync", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            appId: config.appId,
            collection: "browser-storage",
            recordId: key,
            expectedRevision,
            value,
          }),
        });
        const body = await responseJson(result);
        if (result.ok && plainObject(body) && plainObject(body.record)) return { record: body.record };
        if (result.status === 409 && plainObject(body) && plainObject(body.current)) return { conflict: body.current };
        throw new Error(body?.error || "Private sync could not save a record.");
      };
      try {
        for (const key of keys) {
          const local = syncValue(localStorage.getItem(key));
          const localFingerprint = fingerprint(local);
          const known = plainObject(state.records[key]) ? state.records[key] : null;
          const remoteRecord = remote.get(key) || null;
          if (!remoteRecord) {
            if (!local.present) continue;
            const result = await upload(key, local, null);
            if (result.record) {
              state.records[key] = { revision: result.record.revision, fingerprint: localFingerprint };
              changed += 1;
            } else conflicts.push({ key, local, remote: result.conflict });
            continue;
          }
          const remoteFingerprint = fingerprint(remoteRecord.value);
          if (!known) {
            if (!local.present) {
              applyRemoteValue(key, remoteRecord.value);
              state.records[key] = { revision: remoteRecord.revision, fingerprint: remoteFingerprint };
              changed += 1;
              appliedRemote = true;
            } else if (localFingerprint === remoteFingerprint) {
              state.records[key] = { revision: remoteRecord.revision, fingerprint: localFingerprint };
            } else {
              conflicts.push({ key, local, remote: remoteRecord });
            }
            continue;
          }
          const localChanged = known.fingerprint !== localFingerprint;
          const remoteChanged = known.revision !== remoteRecord.revision;
          if (localChanged && remoteChanged && localFingerprint !== remoteFingerprint) {
            conflicts.push({ key, local, remote: remoteRecord });
          } else if (localChanged) {
            const result = await upload(key, local, known.revision);
            if (result.record) {
              state.records[key] = { revision: result.record.revision, fingerprint: localFingerprint };
              changed += 1;
            } else conflicts.push({ key, local, remote: result.conflict });
          } else if (remoteChanged) {
            applyRemoteValue(key, remoteRecord.value);
            state.records[key] = { revision: remoteRecord.revision, fingerprint: remoteFingerprint };
            changed += 1;
            appliedRemote = true;
          } else {
            state.records[key] = { revision: remoteRecord.revision, fingerprint: localFingerprint };
          }
        }
      } catch (error) {
        update(error instanceof Error ? error.message : "Private sync did not finish.", "offline");
        return;
      }
      state.enabled = true;
      saveSyncState(state);
      conflictsNode.replaceChildren();
      for (const conflict of conflicts) {
        const row = document.createElement("div");
        row.className = "app-transfer-conflict";
        const label = document.createElement("strong");
        label.textContent = `${conflict.key}: both copies changed`;
        const keep = document.createElement("button");
        keep.type = "button";
        keep.textContent = "Keep this device";
        const useRemote = document.createElement("button");
        useRemote.type = "button";
        useRemote.textContent = "Use synchronized copy";
        const resolve = async (choice) => {
          try {
            downloadConflict(conflict);
            if (choice === "remote") {
              applyRemoteValue(conflict.key, conflict.remote.value);
              const next = readSyncState();
              next.enabled = true;
              next.records[conflict.key] = {
                revision: conflict.remote.revision,
                fingerprint: fingerprint(conflict.remote.value),
              };
              saveSyncState(next);
              window.setTimeout(() => window.location.reload(), 250);
              return;
            }
            const result = await upload(conflict.key, conflict.local, conflict.remote.revision);
            if (!result.record) throw new Error("That record changed again. Review the new conflict.");
            const next = readSyncState();
            next.enabled = true;
            next.records[conflict.key] = {
              revision: result.record.revision,
              fingerprint: fingerprint(conflict.local),
            };
            saveSyncState(next);
            await sync(true);
          } catch (error) {
            update(error instanceof Error ? error.message : "Conflict resolution did not finish.", "error");
          }
        };
        keep.addEventListener("click", () => void resolve("local"));
        useRemote.addEventListener("click", () => void resolve("remote"));
        row.append(label, keep, useRemote);
        conflictsNode.append(row);
      }
      if (conflicts.length) {
        update(`${conflicts.length} conflict${conflicts.length === 1 ? " needs" : "s need"} your choice. Nothing was overwritten.`, "conflict");
      } else {
        update(changed ? `Synced ${changed} record${changed === 1 ? "" : "s"} safely.` : "Synced. This device is current.", "synced");
        if (appliedRemote && interactive) window.setTimeout(() => window.location.reload(), 250);
      }
    };

    syncButton.addEventListener("click", () => void sync(true));
    if (readSyncState().enabled) {
      void sync(false);
      window.setInterval(() => void sync(false), 15_000);
    }
  };

  const install = () => {
    const host = document.createElement("aside");
    host.className = "app-transfer-tools";
    host.setAttribute("aria-label", "Temporary settings and data transfer");
    host.innerHTML = `
      <style>
        .app-transfer-tools { position: fixed; z-index: 2147483000; right: 12px; bottom: 12px; width: min(360px, calc(100vw - 24px)); color: #122018; font: 600 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; }
        .app-transfer-tools details { overflow: hidden; border: 2px solid #1f5d38; border-radius: 12px; background: #f5fff8; box-shadow: 0 12px 30px rgba(0,0,0,.28); }
        .app-transfer-tools summary { cursor: pointer; padding: 10px 12px; color: #fff; background: #1f5d38; font-weight: 800; }
        .app-transfer-tools [data-transfer-body] { padding: 12px; }
        .app-transfer-tools p { margin: 0 0 10px; }
        .app-transfer-tools [data-transfer-actions] { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .app-transfer-tools button { min-height: 40px; border: 2px solid #17472b; border-radius: 8px; padding: 8px; color: #fff; background: #287849; font: inherit; font-weight: 800; cursor: pointer; }
        .app-transfer-tools button[data-transfer-import] { color: #17351f; background: #c8f4d4; }
        .app-transfer-tools button:focus-visible, .app-transfer-tools summary:focus-visible { outline: 3px solid #f0b429; outline-offset: 2px; }
        .app-transfer-tools [data-transfer-message] { min-height: 1.35em; color: #274832; font-size: 12px; }
        .app-transfer-tools [data-transfer-message][data-kind="error"] { color: #a31919; }
        .app-transfer-tools [data-transfer-message][data-kind="success"] { color: #0d5c2d; }
        .app-transfer-tools [data-transfer-preview] { margin-top: 10px; padding-top: 10px; border-top: 1px solid #9ac9a7; }
        .app-transfer-tools [data-transfer-preview] button { width: 100%; margin-top: 8px; background: #0f6b36; }
        .app-transfer-tools [data-transfer-sync] { margin-top: 10px; padding-top: 10px; border-top: 1px solid #9ac9a7; }
        .app-transfer-tools [data-transfer-sync] strong { display: block; margin-bottom: 4px; }
        .app-transfer-tools [data-transfer-sync-now] { width: 100%; margin: 7px 0; background: #1e5f86; }
        .app-transfer-tools [data-transfer-sync-status][data-kind="conflict"] { color: #9a3a00; }
        .app-transfer-tools .app-transfer-conflict { display: grid; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #bad1c0; font-size: 12px; }
        .app-transfer-tools .app-transfer-conflict button { min-height: 32px; padding: 5px; font-size: 12px; background: #704d11; }
        @media (max-width: 480px) { .app-transfer-tools { right: 8px; bottom: 8px; width: min(340px, calc(100vw - 16px)); } }
      </style>
      <details>
        <summary>Temporary Data Transfer</summary>
        <div data-transfer-body>
          <p>Move this app’s settings and saved data between devices. Photos and videos are not included.</p>
          <div data-transfer-actions>
            <button type="button" data-transfer-export>Export Settings &amp; Data</button>
            <button type="button" data-transfer-import>Import Settings &amp; Data</button>
          </div>
          <input data-transfer-file type="file" accept="application/json,.json" hidden>
          <p data-transfer-message role="status" aria-live="polite"></p>
          <div data-transfer-preview hidden>
            <p data-transfer-preview-copy></p>
            <button type="button" data-transfer-confirm>Replace data &amp; download safety backup</button>
          </div>
          <section data-transfer-sync hidden>
            <strong>Private device sync</strong>
            <p data-transfer-sync-status>Connect this browser to the private, same-site sync store.</p>
            <button type="button" data-transfer-sync-now>Enable private sync &amp; sync now</button>
            <div data-transfer-conflicts></div>
          </section>
        </div>
      </details>`;
    document.body.append(host);
    status.host = host;
    status.message = host.querySelector("[data-transfer-message]");
    status.preview = host.querySelector("[data-transfer-preview]");
    const picker = host.querySelector("[data-transfer-file]");

    host.querySelector("[data-transfer-export]").addEventListener("click", async () => {
      try {
        if (typeof config.beforeExport === "function") await config.beforeExport();
        download(buildEnvelope(), "transfer");
        setMessage("Transfer file downloaded. Keep it private until import is complete.", "success");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not export this app’s data.", "error");
      }
    });
    host.querySelector("[data-transfer-import]").addEventListener("click", () => {
      picker.value = "";
      picker.click();
    });
    picker.addEventListener("change", () => void importFile(picker.files && picker.files[0]));
    host.querySelector("[data-transfer-confirm]").addEventListener("click", () => void applyCandidate());
    configureSync(host);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
