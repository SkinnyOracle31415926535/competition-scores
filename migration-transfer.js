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
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
