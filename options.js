/**
 * options.js — tab customization settings logic
 */

const els = {
  save: document.getElementById("save"),
  status: document.getElementById("status"),

  scope: document.getElementById("scope"),
  duplicateMode: document.getElementById("duplicate-mode"),
  keepRule: document.getElementById("keep-rule"),
  groupPreset: document.getElementById("group-preset"),

  excludePinned: document.getElementById("exclude-pinned"),
  excludeMuted: document.getElementById("exclude-muted"),
  excludeAudible: document.getElementById("exclude-audible"),
  excludedDomains: document.getElementById("excluded-domains"),

  autoCleanup: document.getElementById("auto-cleanup"),
  autoCleanupInterval: document.getElementById("auto-cleanup-interval"),
  autoDiscard: document.getElementById("auto-discard"),
  autoDiscardThreshold: document.getElementById("auto-discard-threshold"),

  defaultSortMode: document.getElementById("default-sort-mode"),
  defaultSnoozeValue: document.getElementById("default-snooze-value"),
  defaultSnoozeUnit: document.getElementById("default-snooze-unit"),

  customGroupRules: document.getElementById("custom-group-rules"),

  snoozeList: document.getElementById("snooze-list"),

  workspaceName: document.getElementById("workspace-name"),
  workspaceList: document.getElementById("workspace-list"),
  btnSaveWorkspace: document.getElementById("btn-save-workspace"),
  btnRestoreWorkspace: document.getElementById("btn-restore-workspace"),
  btnDeleteWorkspace: document.getElementById("btn-delete-workspace"),
  btnExportWorkspaces: document.getElementById("btn-export-workspaces"),
  btnImportWorkspaces: document.getElementById("btn-import-workspaces"),
  importFile: document.getElementById("import-file"),
};

document.addEventListener("DOMContentLoaded", init);
els.save.addEventListener("click", saveSettings);

async function init() {
  await loadSettings();
  await loadSnoozedTabs();
  const initData = await sendMessage({ action: "initPopup" });
  if (initData.success) {
    renderWorkspaces(initData.workspaces || []);
  }
  bindWorkspaceEvents();
}

async function loadSettings() {
  const result = await chrome.runtime.sendMessage({ action: "getSettings" });
  if (!result.success) return;

  const s = result.settings;
  els.scope.value = s.scope;
  els.duplicateMode.value = s.duplicateMatchMode;
  els.keepRule.value = s.smartKeepRule;
  els.groupPreset.value = s.groupPreset;

  els.excludePinned.checked = !!s.excludePinned;
  els.excludeMuted.checked = !!s.excludeMuted;
  els.excludeAudible.checked = !!s.excludeAudible;
  els.excludedDomains.value = s.excludedDomains || "";

  els.autoCleanup.checked = !!s.autoCleanup;
  els.autoCleanupInterval.value = s.autoCleanupIntervalMin || 30;
  els.autoDiscard.checked = !!s.autoDiscard;
  els.autoDiscardThreshold.value = s.autoDiscardThresholdMin || 60;

  els.defaultSortMode.value = s.defaultSortMode || "domain";
  els.defaultSnoozeValue.value = s.defaultSnoozeValue || 60;
  els.defaultSnoozeUnit.value = s.defaultSnoozeUnit || "minutes";

  els.customGroupRules.value = s.customGroupRules || "";
}

async function saveSettings() {
  const settings = {
    scope: els.scope.value,
    duplicateMatchMode: els.duplicateMode.value,
    smartKeepRule: els.keepRule.value,
    groupPreset: els.groupPreset.value,

    excludePinned: els.excludePinned.checked,
    excludeMuted: els.excludeMuted.checked,
    excludeAudible: els.excludeAudible.checked,
    excludedDomains: els.excludedDomains.value,

    autoCleanup: els.autoCleanup.checked,
    autoCleanupIntervalMin: parseInt(els.autoCleanupInterval.value, 10),
    autoDiscard: els.autoDiscard.checked,
    autoDiscardThresholdMin: parseInt(els.autoDiscardThreshold.value, 10),

    defaultSortMode: els.defaultSortMode.value,
    defaultSnoozeValue: parseInt(els.defaultSnoozeValue.value, 10),
    defaultSnoozeUnit: els.defaultSnoozeUnit.value,

    customGroupRules: els.customGroupRules.value,
  };

  const result = await chrome.runtime.sendMessage({
    action: "updateSettings",
    settings,
  });

  if (result.success) {
    showStatus("Settings saved successfully!", "success");
  } else {
    showStatus("Error saving settings: " + result.error, "error");
  }
}

function showStatus(text, tone) {
  els.status.textContent = text;
  els.status.className = `status ${tone}`;
  setTimeout(() => {
    els.status.className = "status";
  }, 3000);
}

function bindWorkspaceEvents() {
  els.btnSaveWorkspace.addEventListener("click", async () => {
    const result = await sendMessage({
      action: "saveWorkspace",
      name: els.workspaceName.value,
      scope: els.scope.value,
    });

    if (result.success) {
      renderWorkspaces(result.workspaces);
      els.workspaceName.value = "";
      showStatus("Workspace saved!", "success");
    } else {
      showStatus("Save failed: " + result.error, "error");
    }
  });

  els.btnRestoreWorkspace.addEventListener("click", async () => {
    const id = els.workspaceList.value;
    if (!id) return showStatus("Select a workspace", "error");

    const result = await sendMessage({ action: "restoreWorkspace", id });
    if (result.success) {
      showStatus(`Restored ${result.restored} tabs`, "success");
    } else {
      showStatus("Restore failed: " + result.error, "error");
    }
  });

  els.btnDeleteWorkspace.addEventListener("click", async () => {
    const id = els.workspaceList.value;
    if (!id) return showStatus("Select a workspace", "error");

    const result = await sendMessage({ action: "deleteWorkspace", id });
    if (result.success) {
      renderWorkspaces(result.workspaces);
      showStatus("Workspace deleted", "success");
    } else {
      showStatus("Delete failed: " + result.error, "error");
    }
  });

  els.btnExportWorkspaces.addEventListener("click", async () => {
    const result = await sendMessage({ action: "exportWorkspaces" });
    if (result.success) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspaces-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  });

  els.btnImportWorkspaces.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files[0];
    if (!file) return;
    const text = await file.text();
    const result = await sendMessage({ action: "importWorkspaces", payload: text });
    if (result.success) {
      renderWorkspaces(result.workspaces);
      showStatus("Workspaces imported!", "success");
    } else {
      showStatus("Import failed: " + result.error, "error");
    }
    els.importFile.value = "";
  });
}

function renderWorkspaces(workspaces) {
  els.workspaceList.innerHTML = "";
  if (!workspaces || workspaces.length === 0) {
    els.workspaceList.innerHTML = '<option value="">No saved workspaces</option>';
    return;
  }
  workspaces.forEach(ws => {
    const opt = document.createElement("option");
    opt.value = ws.id;
    opt.textContent = `${ws.name} (${ws.tabs.length})`;
    els.workspaceList.appendChild(opt);
  });
}

async function loadSnoozedTabs() {
  const result = await sendMessage({ action: "listSnoozedTabs" });
  renderSnoozeList(result.tabs || []);
}

function renderSnoozeList(tabs) {
  els.snoozeList.innerHTML = "";
  if (!tabs || tabs.length === 0) {
    els.snoozeList.innerHTML = '<div class="list-item"><div class="list-item-meta">No active snoozed tabs.</div></div>';
    return;
  }

  tabs.forEach(tab => {
    const item = document.createElement("div");
    item.className = "list-item";

    const meta = document.createElement("div");
    meta.className = "list-item-meta";

    const title = document.createElement("div");
    title.className = "list-item-title";
    title.textContent = tab.title || "Untitled Tab";

    const sub = document.createElement("div");
    sub.className = "list-item-sub";
    const wakeAt = new Date(tab.wakeAt).toLocaleString();
    sub.textContent = `Wakes up at: ${wakeAt}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.padding = "6px 12px";
    btn.style.fontSize = "12px";
    btn.textContent = "Unsnooze";
    btn.onclick = async () => {
      const res = await sendMessage({ action: "unsnoozeTab", id: tab.id });
      if (res.success) {
        showStatus("Tab unsnoozed!", "success");
        await loadSnoozedTabs();
      }
    };

    item.appendChild(meta);
    item.appendChild(btn);
    els.snoozeList.appendChild(item);
  });
}

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}
