(() => {
  "use strict";

  // This adapter deliberately knows nothing about localStorage keys.  Each
  // application exposes validated, domain-level records and uses its own
  // guarded apply/verify APIs below.
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plainObject = (value) => Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const validCollection = (value) => typeof value === "string"
    && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
  const validRecordId = (value) => typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value);
  const identityFor = (collection, recordId) => collection + "\u001f" + recordId;
  const splitIdentity = (identity) => {
    const boundary = typeof identity === "string" ? identity.indexOf("\u001f") : -1;
    if (boundary < 1) return null;
    const collection = identity.slice(0, boundary);
    const recordId = identity.slice(boundary + 1);
    return validCollection(collection) && validRecordId(recordId) ? { collection, recordId } : null;
  };
  const normalizeJson = (value, depth = 0) => {
    if (depth > 48) throw new Error("A synchronized record is nested too deeply.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 20_000) throw new Error("A synchronized record has too many entries.");
      return value.map((item) => normalizeJson(item, depth + 1));
    }
    if (!plainObject(value)) throw new Error("A synchronized record is not plain JSON data.");
    const result = {};
    const keys = Object.keys(value).sort();
    if (keys.length > 20_000) throw new Error("A synchronized record has too many fields.");
    for (const key of keys) {
      if (key.length > 240 || ["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("A synchronized record has an unsafe field.");
      }
      result[key] = normalizeJson(value[key], depth + 1);
    }
    return result;
  };
  const fingerprint = (value) => JSON.stringify(normalizeJson(value));
  const encode = (record) => {
    if (record.deleted) return { present: false, encoding: "text", value: null };
    const value = normalizeJson(record.value);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 900 * 1024) {
      throw new Error("A synchronized record is too large.");
    }
    return { present: true, encoding: "json", value };
  };
  const decode = (collection, recordId, wire) => {
    if (!plainObject(wire) || typeof wire.present !== "boolean"
      || typeof wire.encoding !== "string" || !hasOwn(wire, "value")) {
      throw new Error("A synchronized record has an unsupported schema.");
    }
    if (!wire.present) {
      if (wire.encoding !== "text" || wire.value !== null) {
        throw new Error("A synchronized deletion record is invalid.");
      }
      return { collection, recordId, deleted: true };
    }
    if (wire.encoding !== "json") throw new Error("A synchronized record is not application data.");
    return { collection, recordId, deleted: false, value: normalizeJson(wire.value) };
  };
  const responseJson = async (response) => {
    try { return await response.json(); } catch (_error) { return null; }
  };
  const stateKey = (appId) => "__ryan_private_sync_" + appId + "_semantic_v2";
  const readState = (appId, collections) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(stateKey(appId)) || "null");
      if (!plainObject(parsed) || typeof parsed.enabled !== "boolean" || !plainObject(parsed.records)) {
        return { enabled: false, records: {} };
      }
      const records = {};
      for (const [identity, item] of Object.entries(parsed.records)) {
        const parts = splitIdentity(identity);
        if (!parts || !collections.has(parts.collection) || !plainObject(item)
          || !Number.isSafeInteger(item.revision) || item.revision < 1
          || typeof item.fingerprint !== "string" || item.fingerprint.length > 950 * 1024) continue;
        records[identity] = { revision: item.revision, fingerprint: item.fingerprint };
      }
      return { enabled: parsed.enabled, records };
    } catch (_error) {
      return { enabled: false, records: {} };
    }
  };
  const saveState = (appId, state) => {
    localStorage.setItem(stateKey(appId), JSON.stringify(state));
  };
  const isPrivateSite = () => location.protocol === "https:"
    && location.hostname.endsWith(".chatgpt.site");

  const configure = ({ config, host, download }) => {
    const adapter = config && config.semanticSync;
    const section = host && host.querySelector("[data-transfer-sync]");
    const status = host && host.querySelector("[data-transfer-sync-status]");
    const button = host && host.querySelector("[data-transfer-sync-now]");
    const conflictsNode = host && host.querySelector("[data-transfer-conflicts]");
    if (!isPrivateSite() || !adapter || !section || !status || !button || !conflictsNode
      || !Array.isArray(adapter.collections)
      || typeof adapter.listRecords !== "function"
      || typeof adapter.validateRecord !== "function"
      || typeof adapter.verifyLocal !== "function"
      || typeof adapter.applyRemote !== "function") return false;
    const collections = new Set(adapter.collections);
    if (!collections.size || ![...collections].every(validCollection)) return false;
    section.hidden = false;
    let running = false;

    const setStatus = (message, kind = "") => {
      status.textContent = message;
      status.dataset.kind = kind;
    };
    const validate = async (record, source) => {
      const result = await adapter.validateRecord(record, { source });
      if (result === false) throw new Error("An application sync record did not pass validation.");
    };
    const listLocal = async () => {
      const list = await adapter.listRecords();
      if (!Array.isArray(list)) throw new Error("This app did not provide valid local sync records.");
      const records = new Map();
      for (const item of list) {
        if (!plainObject(item) || !collections.has(item.collection)
          || !validRecordId(item.recordId) || item.deleted) {
          throw new Error("This app provided an invalid local sync record.");
        }
        const record = {
          collection: item.collection,
          recordId: item.recordId,
          deleted: false,
          value: normalizeJson(item.value),
        };
        const identity = identityFor(record.collection, record.recordId);
        if (records.has(identity)) throw new Error("This app has duplicate local sync records.");
        await validate(record, "local");
        records.set(identity, record);
      }
      return records;
    };
    const normalizeRemote = async (item) => {
      if (!plainObject(item) || !collections.has(item.collection)
        || !validRecordId(item.recordId) || !Number.isSafeInteger(item.revision) || item.revision < 1) {
        throw new Error("A synchronized record is invalid and was not applied.");
      }
      const record = decode(item.collection, item.recordId, item.value);
      await validate(record, "remote");
      return { ...record, revision: item.revision, wire: encode(record) };
    };
    const priority = (record) => {
      const value = Number(typeof adapter.priority === "function" ? adapter.priority(record) : 0);
      return Number.isFinite(value) ? value : 0;
    };
    const sortRecords = (left, right) => priority(left) - priority(right)
      || left.collection.localeCompare(right.collection)
      || left.recordId.localeCompare(right.recordId);
    const upload = async (record, expectedRevision) => {
      const response = await fetch("/api/app-sync", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          appId: config.appId,
          collection: record.collection,
          recordId: record.recordId,
          expectedRevision,
          value: encode(record),
        }),
      });
      const body = await responseJson(response);
      if (response.ok && plainObject(body) && body.record) {
        return { record: await normalizeRemote(body.record) };
      }
      if (response.status === 409 && plainObject(body) && body.current) {
        return { conflict: await normalizeRemote(body.current) };
      }
      throw new Error((body && body.error) || "Private sync could not save a record.");
    };
    const downloadConflict = (conflict) => {
      download({
        kind: "ryan-app-sync-conflict",
        schemaVersion: 2,
        appId: config.appId,
        createdAt: new Date().toISOString(),
        collection: conflict.local.collection,
        recordId: conflict.local.recordId,
        local: conflict.localWire,
        remote: { revision: conflict.remote.revision, value: conflict.remote.wire },
      }, "sync-conflict-" + conflict.local.collection + "-"
        + conflict.local.recordId.replace(/[^a-z0-9]+/gi, "-").slice(0, 72));
    };

    const renderConflicts = (conflicts, sync) => {
      conflictsNode.replaceChildren();
      for (const conflict of conflicts) {
        const row = document.createElement("div");
        row.className = "app-transfer-conflict";
        const label = document.createElement("strong");
        label.textContent = conflict.local.collection + "/" + conflict.local.recordId
          + ": both copies changed";
        const keep = document.createElement("button");
        keep.type = "button";
        keep.textContent = "Keep this device";
        const useRemote = document.createElement("button");
        useRemote.type = "button";
        useRemote.textContent = "Use synchronized copy";
        const resolve = async (choice) => {
          try {
            const current = await listLocal();
            const identity = identityFor(conflict.local.collection, conflict.local.recordId);
            const local = current.get(identity) || {
              collection: conflict.local.collection,
              recordId: conflict.local.recordId,
              deleted: true,
            };
            const localWire = encode(local);
            if (fingerprint(localWire) !== fingerprint(conflict.localWire)) {
              throw new Error("This device changed after the conflict was found. Sync again to review it.");
            }
            downloadConflict(conflict);
            if (choice === "remote") {
              await adapter.applyRemote(conflict.remote, {
                source: "remote",
                expectedLocal: local,
              });
              const next = readState(config.appId, collections);
              next.enabled = true;
              next.records[identity] = {
                revision: conflict.remote.revision,
                fingerprint: fingerprint(conflict.remote.wire),
              };
              saveState(config.appId, next);
              window.setTimeout(() => window.location.reload(), 250);
              return;
            }
            const verified = await adapter.verifyLocal(local, { source: "local" });
            if (verified === false) throw new Error("A newer local edit was preserved.");
            const result = await upload(local, conflict.remote.revision);
            if (!result.record) throw new Error("That record changed again. Review the new conflict.");
            const next = readState(config.appId, collections);
            next.enabled = true;
            next.records[identity] = {
              revision: result.record.revision,
              fingerprint: fingerprint(result.record.wire),
            };
            saveState(config.appId, next);
            await sync(true);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Conflict resolution did not finish.", "error");
          }
        };
        keep.addEventListener("click", () => void resolve("local"));
        useRemote.addEventListener("click", () => void resolve("remote"));
        row.append(label, keep, useRemote);
        conflictsNode.append(row);
      }
    };

    const synchronize = async (interactive) => {
      setStatus("Syncing this private site…", "working");
      let local;
      try {
        // Validate every local entity before a network write is possible.
        local = await listLocal();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Local data needs review before syncing.", "error");
        return;
      }
      let response;
      try {
        response = await fetch("/api/app-sync?appId=" + encodeURIComponent(config.appId), {
          cache: "no-store",
          credentials: "same-origin",
        });
      } catch (_error) {
        setStatus("Offline. Local data is preserved and will retry later.", "offline");
        return;
      }
      const manifest = await responseJson(response);
      if (!response.ok || !plainObject(manifest) || !Array.isArray(manifest.records)) {
        setStatus((manifest && manifest.error) || "Private sync is unavailable. Local data is preserved.", "offline");
        return;
      }
      const remote = new Map();
      try {
        for (const item of manifest.records) {
          const record = await normalizeRemote(item);
          const identity = identityFor(record.collection, record.recordId);
          if (remote.has(identity)) throw new Error("The private sync manifest has duplicate records.");
          remote.set(identity, record);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "A synchronized record was not applied.", "error");
        return;
      }

      const state = readState(config.appId, collections);
      const identities = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.records)]);
      const uploads = [];
      const applies = [];
      const conflicts = [];
      for (const identity of identities) {
        const parts = splitIdentity(identity);
        if (!parts || !collections.has(parts.collection)) continue;
        const localRecord = local.get(identity) || { ...parts, deleted: true };
        const localWire = encode(localRecord);
        const remoteRecord = remote.get(identity) || null;
        const known = state.records[identity] || null;
        if (!remoteRecord) {
          if (localRecord.deleted) delete state.records[identity];
          else uploads.push({ identity, local: localRecord, localWire, expectedRevision: null });
          continue;
        }
        const remoteFingerprint = fingerprint(remoteRecord.wire);
        if (!known) {
          if (localRecord.deleted && remoteRecord.deleted) {
            state.records[identity] = { revision: remoteRecord.revision, fingerprint: remoteFingerprint };
          } else if (!localRecord.deleted && fingerprint(localWire) === remoteFingerprint) {
            state.records[identity] = { revision: remoteRecord.revision, fingerprint: remoteFingerprint };
          } else if (localRecord.deleted) {
            applies.push({ identity, remote: remoteRecord });
          } else {
            conflicts.push({ local: localRecord, localWire, remote: remoteRecord });
          }
          continue;
        }
        const localFingerprint = fingerprint(localWire);
        const localChanged = known.fingerprint !== localFingerprint;
        const remoteChanged = known.revision !== remoteRecord.revision;
        if (localChanged && remoteChanged && localFingerprint !== remoteFingerprint) {
          conflicts.push({ local: localRecord, localWire, remote: remoteRecord });
        } else if (localChanged) {
          uploads.push({ identity, local: localRecord, localWire, expectedRevision: known.revision });
        } else if (remoteChanged) {
          applies.push({ identity, remote: remoteRecord });
        } else {
          state.records[identity] = { revision: remoteRecord.revision, fingerprint: remoteFingerprint };
        }
      }
      uploads.sort((left, right) => sortRecords(left.local, right.local));
      applies.sort((left, right) => sortRecords(left.remote, right.remote));
      try {
        // Existing stores fence each staged value; running this pass before the
        // first PUT prevents malformed or stale local data from creating writes.
        for (const plan of uploads) {
          const verified = await adapter.verifyLocal(plan.local, { source: "local" });
          if (verified === false) throw new Error("A newer local edit was preserved.");
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "A local edit changed while sync was preparing.", "error");
        return;
      }
      let changed = 0;
      try {
        for (const plan of uploads) {
          const verified = await adapter.verifyLocal(plan.local, { source: "local" });
          if (verified === false) throw new Error("A newer local edit was preserved.");
          const result = await upload(plan.local, plan.expectedRevision);
          if (result.record) {
            state.records[plan.identity] = {
              revision: result.record.revision,
              fingerprint: fingerprint(result.record.wire),
            };
            changed += 1;
          } else {
            conflicts.push({ local: plan.local, localWire: plan.localWire, remote: result.conflict });
          }
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Private sync did not finish.", "offline");
        return;
      }
      let appliedRemote = false;
      if (!conflicts.length) {
        try {
          for (const plan of applies) {
            await adapter.applyRemote(plan.remote, {
              source: "remote",
              expectedLocal: local.get(plan.identity) || {
                collection: plan.remote.collection,
                recordId: plan.remote.recordId,
                deleted: true,
              },
            });
            state.records[plan.identity] = {
              revision: plan.remote.revision,
              fingerprint: fingerprint(plan.remote.wire),
            };
            changed += 1;
            appliedRemote = true;
          }
        } catch (error) {
          state.enabled = true;
          saveState(config.appId, state);
          setStatus(error instanceof Error ? error.message : "Synchronized data was not applied.", "error");
          return;
        }
      }
      state.enabled = true;
      saveState(config.appId, state);
      renderConflicts(conflicts, sync);
      if (conflicts.length) {
        setStatus(String(conflicts.length) + " conflict" + (conflicts.length === 1 ? " needs" : "s need")
          + " your choice. Nothing was overwritten.", "conflict");
        return;
      }
      setStatus(changed
        ? "Synced " + changed + " record" + (changed === 1 ? "" : "s") + " safely."
        : "Synced. This device is current.", "synced");
      if (appliedRemote) window.setTimeout(() => window.location.reload(), interactive ? 350 : 700);
    };
    const sync = async (interactive = false) => {
      if (running) return;
      running = true;
      try {
        await synchronize(interactive);
      } finally {
        running = false;
      }
    };
    button.addEventListener("click", () => void sync(true));
    if (readState(config.appId, collections).enabled) {
      void sync(false);
      window.setInterval(() => void sync(false), 15_000);
    }
    return true;
  };

  window.RyanSemanticAppSync = Object.freeze({ configure });
})();
