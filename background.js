/**
 * background.js — Tab Manager Service Worker
 * Handles heavy lifting: tab automation, alarms, storage, and cross-browser APIs.
 */

/**
 * Universal browser API wrapper for cross-browser compatibility.
 * Prefers native `browser` namespace (Firefox) over `chrome` (Chrome/Edge).
 */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const STORAGE_KEYS = {
  settings: "settings",
  undoStack: "undoStack",
  workspaces: "workspaces",
  snoozedTabs: "snoozedTabs",
};

const ALARM_AUTO_CLEANUP = "autoCleanup";
const ALARM_AUTO_DISCARD = "autoDiscard";
const ALARM_AUTO_BACKUP = "autoBackup";
const ALARM_SNOOZE_PREFIX = "snooze:";
const MENU_ID_CLOSE_DUPLICATES = "closeDuplicates";
const UNDO_LIMIT = 30;
const WORKSPACE_LIMIT = 100;

const DEFAULT_SETTINGS = {
  duplicateMatchMode: "exact", // exact | ignoreHash | ignoreQuery | domainPath
  scope: "currentWindow", // currentWindow | allWindows
  smartKeepRule: "active", // active | pinned | recent
  excludePinned: false,
  excludeMuted: false,
  excludeAudible: false,
  excludedDomains: "",
  groupPreset: "domain", // domain | subdomain | custom
  customGroupRules: "",
  autoCleanup: false,
  autoCleanupIntervalMin: 30,
  autoDiscard: false,
  autoDiscardThresholdMin: 60,
  defaultSortMode: "domain", // domain | title | recent | pinned
  defaultSnoozeValue: 60,
  defaultSnoozeUnit: "minutes", // minutes | hours
};

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
  chrome.contextMenus.create({
    id: MENU_ID_CLOSE_DUPLICATES,
    title: "Close all duplicates of this tab",
    contexts: ["page"],
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[STORAGE_KEYS.settings]) return;
  const nextSettings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue || {});
  void syncAutoCleanupAlarm(nextSettings);
  void syncAutoDiscardAlarm(nextSettings);
  void updateAutoCleanupBadge(nextSettings);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID_CLOSE_DUPLICATES && tab?.url) {
    void closeDuplicatesOfTab(tab);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_AUTO_BACKUP) {
    void runAutoBackup();
    return;
  }

  if (alarm.name === ALARM_AUTO_CLEANUP) {
    void runAutoCleanupScan();
    return;
  }

  if (alarm.name === ALARM_AUTO_DISCARD) {
    void runAutoDiscardScan();
    return;
  }

  if (alarm.name.startsWith(ALARM_SNOOZE_PREFIX)) {
    const snoozeId = alarm.name.slice(ALARM_SNOOZE_PREFIX.length);
    if (snoozeId) {
      void wakeSnoozedTab(snoozeId);
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    const action = message?.action;

    switch (action) {
      case "initPopup": {
        const [settings, undoDepth, workspaces, duplicatePreview] = await Promise.all([
          getSettings(),
          getUndoDepth(),
          listWorkspaces(),
          previewDuplicates(),
        ]);

        return {
          success: true,
          settings,
          undoDepth,
          workspaces,
          duplicatePreview,
        };
      }

      case "getSettings": {
        return {
          success: true,
          settings: await getSettings(),
        };
      }

      case "updateSettings": {
        const settings = await updateSettings(message?.settings || {});
        return {
          success: true,
          settings,
        };
      }

      case "groupTabs": {
        const settings = await getSettings();
        return groupTabsByPreset({
          settings,
          scope: message?.scope || settings.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "removeDuplicates": {
        const settings = await getSettings();
        return removeDuplicateTabs({
          settings,
          scope: message?.scope || settings.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "previewDuplicates": {
        return previewDuplicates();
      }

      case "undoLastRemoval": {
        return undoLastRemoval();
      }

      case "collapseGroups": {
        const settings = await getSettings();
        return setGroupsCollapsed({
          collapsed: true,
          scope: message?.scope || settings.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "expandGroups": {
        const settings = await getSettings();
        return setGroupsCollapsed({
          collapsed: false,
          scope: message?.scope || settings.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "saveWorkspace": {
        return saveWorkspace({
          name: message?.name,
          scope: message?.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "listWorkspaces": {
        return {
          success: true,
          workspaces: await listWorkspaces(),
        };
      }

      case "restoreWorkspace": {
        return restoreWorkspace({
          id: message?.id,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "deleteWorkspace": {
        return deleteWorkspace(message?.id);
      }

      case "exportWorkspaces": {
        const workspaces = await listWorkspaces();
        return {
          success: true,
          data: {
            version: 1,
            exportedAt: new Date().toISOString(),
            workspaces,
          },
        };
      }

      case "importWorkspaces": {
        return importWorkspaces(message?.payload);
      }

      case "searchTabs": {
        const settings = await getSettings();
        return searchTabs({
          query: message?.query || "",
          sortBy: message?.sortBy || "recent",
          sortDirection: message?.sortDirection || "asc",
          scope: message?.scope || settings.scope,
          currentWindowId: message?.currentWindowId,
        });
      }

      case "focusTab":
        return focusTab(message.tabId, message.windowId);

      case "closeTab":
        try {
          await chrome.tabs.remove(message.tabId);
          return { success: true };
        } catch (err) {
          return { success: false, error: err.message };
        }

      case "discardInactive":
        return runAutoDiscardScan(true);

      case "sortTabs": {
        return sortTabs({
          sortBy: message.sortBy,
          sortDirection: message.sortDirection,
          scope: message.scope,
          currentWindowId: message.currentWindowId
        });
      }

      case "snoozeTab": {
        return snoozeTab({
          tabId: message?.tabId,
          durationMinutes: message?.durationMinutes,
        });
      }

      case "getSnoozeCount": {
        return {
          success: true,
          count: (await getSnoozedTabs()).length,
        };
      }

      case "zenMode": {
        return runZenMode();
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${String(action)}`,
        };
    }
  })()
    .then(sendResponse)
    .catch((err) => {
      sendResponse({
        success: false,
        error: err?.message || String(err),
      });
    });

  return true;
});

async function initializeExtension() {
  console.log("[NanoBanana] tab customization initializing...");
  const settings = await getSettings();
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  await syncAutoCleanupAlarm(settings);
  await syncAutoDiscardAlarm(settings);
  await rescheduleSnoozeAlarms();
  await updateAutoCleanupBadge(settings);
  await chrome.alarms.create(ALARM_AUTO_BACKUP, { periodInMinutes: 15 });
}

async function runAutoBackup() {
  try {
    const tabs = await chrome.tabs.query({});
    const capturedTabs = tabs
      .filter((tab) => tab?.url && isSupportedTabUrl(tab.url))
      .map((tab) => ({
        url: tab.url,
        pinned: Boolean(tab.pinned),
        title: tab.title || "",
      }));

    if (capturedTabs.length === 0) return;

    const workspaces = await listWorkspaces();
    
    // Remove old auto-backups if there are more than 3
    const backupPrefix = "⏱️ Auto-Backup";
    let autoBackups = workspaces.filter(w => w.name && w.name.startsWith(backupPrefix));
    
    if (autoBackups.length >= 3) {
      // Keep only the 2 newest, we are adding 1
      const toRemove = autoBackups.slice(2).map(w => w.id);
      for (const id of toRemove) {
        const idx = workspaces.findIndex(w => w.id === id);
        if (idx !== -1) workspaces.splice(idx, 1);
      }
    }

    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const workspace = {
      id: crypto.randomUUID(),
      name: `${backupPrefix} (${timeString})`,
      createdAt: Date.now(),
      scope: "allWindows",
      tabs: capturedTabs,
    };

    workspaces.unshift(workspace);
    if (workspaces.length > WORKSPACE_LIMIT) {
      workspaces.length = WORKSPACE_LIMIT;
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.workspaces]: workspaces });
  } catch (err) {
    console.error("[TabManager] Auto-Backup failed:", err);
  }
}

async function runZenMode() {
  try {
    const allTabs = await chrome.tabs.query({});
    
    // Only stash tabs that are not active and not pinned
    const tabsToStash = allTabs.filter(tab => !tab.active && !tab.pinned && tab.url && isSupportedTabUrl(tab.url));
    const tabIdsToClose = tabsToStash.map(t => t.id);
    
    if (tabsToStash.length === 0) {
      return { success: false, error: "No background tabs to stash." };
    }

    const capturedTabs = tabsToStash.map((tab) => ({
      url: tab.url,
      pinned: false,
      title: tab.title || "",
    }));

    const workspaces = await listWorkspaces();
    const dateStr = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    
    const workspace = {
      id: crypto.randomUUID(),
      name: `🧘 Zen Mode Stash (${dateStr})`,
      createdAt: Date.now(),
      scope: "allWindows",
      tabs: capturedTabs,
    };

    workspaces.unshift(workspace);
    if (workspaces.length > WORKSPACE_LIMIT) {
      workspaces.length = WORKSPACE_LIMIT;
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.workspaces]: workspaces });
    
    // Close the stashed tabs
    await chrome.tabs.remove(tabIdsToClose);
    
    return { success: true, stashedCount: tabsToStash.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleCommand(command) {
  const settings = await getSettings();
  const windowId = await getCurrentWindowId();

  if (command === "group-tabs") {
    await groupTabsByPreset({
      settings,
      scope: settings.scope,
      currentWindowId: windowId,
    });
    return;
  }

  if (command === "remove-duplicates") {
    await removeDuplicateTabs({
      settings,
      scope: settings.scope,
      currentWindowId: windowId,
    });
    return;
  }

  if (command === "undo-last-removal") {
    await undoLastRemoval();
  }
}

function normalizeSettings(rawSettings) {
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...(rawSettings || {}),
  };

  const matchModes = new Set(["exact", "ignoreHash", "ignoreQuery", "domainPath"]);
  if (!matchModes.has(normalized.duplicateMatchMode)) {
    normalized.duplicateMatchMode = DEFAULT_SETTINGS.duplicateMatchMode;
  }

  const scopes = new Set(["currentWindow", "allWindows"]);
  if (!scopes.has(normalized.scope)) {
    normalized.scope = DEFAULT_SETTINGS.scope;
  }

  const keepRules = new Set(["active", "pinned", "recent"]);
  if (!keepRules.has(normalized.smartKeepRule)) {
    normalized.smartKeepRule = DEFAULT_SETTINGS.smartKeepRule;
  }

  const groupPresets = new Set(["domain", "subdomain", "custom"]);
  if (!groupPresets.has(normalized.groupPreset)) {
    normalized.groupPreset = DEFAULT_SETTINGS.groupPreset;
  }

  normalized.excludePinned = Boolean(normalized.excludePinned);
  normalized.excludeMuted = Boolean(normalized.excludeMuted);
  normalized.excludeAudible = Boolean(normalized.excludeAudible);
  normalized.excludedDomains = String(normalized.excludedDomains || "").trim();
  normalized.customGroupRules = String(normalized.customGroupRules || "").trim();

  normalized.autoCleanup = Boolean(normalized.autoCleanup);
  const cleanupInterval = Number.parseInt(normalized.autoCleanupIntervalMin, 10);
  normalized.autoCleanupIntervalMin = Number.isFinite(cleanupInterval)
    ? clamp(cleanupInterval, 5, 720)
    : DEFAULT_SETTINGS.autoCleanupIntervalMin;

  normalized.autoDiscard = Boolean(normalized.autoDiscard);
  const discardThreshold = Number.parseInt(normalized.autoDiscardThresholdMin, 10);
  normalized.autoDiscardThresholdMin = Number.isFinite(discardThreshold)
    ? clamp(discardThreshold, 1, 1440)
    : DEFAULT_SETTINGS.autoDiscardThresholdMin;

  const sortModes = new Set(["domain", "title", "recent", "pinned"]);
  if (!sortModes.has(normalized.defaultSortMode)) {
    normalized.defaultSortMode = DEFAULT_SETTINGS.defaultSortMode;
  }

  normalized.defaultSnoozeValue = Number.isFinite(Number(normalized.defaultSnoozeValue))
    ? clamp(Number(normalized.defaultSnoozeValue), 1, 10080)
    : DEFAULT_SETTINGS.defaultSnoozeValue;

  const snoozeUnits = new Set(["minutes", "hours"]);
  if (!snoozeUnits.has(normalized.defaultSnoozeUnit)) {
    normalized.defaultSnoozeUnit = DEFAULT_SETTINGS.defaultSnoozeUnit;
  }

  return normalized;
}

async function syncAutoDiscardAlarm(settings) {
  await chrome.alarms.clear(ALARM_AUTO_DISCARD);

  if (!settings.autoDiscard) return;

  await chrome.alarms.create(ALARM_AUTO_DISCARD, {
    periodInMinutes: 5, // Scan for idle tabs every 5 minutes
  });
}

async function runAutoDiscardScan(force = false) {
  const settings = await getSettings();
  if (!settings.autoDiscard && !force) return { success: true, discarded: 0 };

  const tabs = await chrome.tabs.query({ active: false, discarded: false });
  const now = Date.now();
  const thresholdMs = settings.autoDiscardThresholdMin * 60 * 1000;

  let discarded = 0;
  for (const tab of tabs) {
    if (!tab.id || tab.pinned || tab.audible) continue;

    const lastAccessed = tab.lastAccessed || 0;
    const shouldDiscard = force || (lastAccessed > 0 && now - lastAccessed > thresholdMs);

    if (shouldDiscard) {
      try {
        await chrome.tabs.discard(tab.id);
        discarded += 1;
      } catch (err) {
        console.warn(`[NanoBanana] Could not discard tab ${tab.id}:`, err.message);
      }
    }
  }

  return { success: true, discarded };
}

async function closeDuplicatesOfTab(tab) {
  const settings = await getSettings();
  const allTabs = await chrome.tabs.query({});
  const targetKey = normalizeUrlForMatch(tab.url, settings.duplicateMatchMode);

  if (!targetKey) return;

  const toClose = [];
  const undoItems = [];

  for (const other of allTabs) {
    if (!other.id || other.id === tab.id) continue;

    const key = normalizeUrlForMatch(other.url, settings.duplicateMatchMode);
    if (key === targetKey) {
      toClose.push(other.id);
      undoItems.push({
        url: other.url,
        windowId: other.windowId,
        index: other.index,
        pinned: Boolean(other.pinned),
      });
    }
  }

  if (toClose.length > 0) {
    await pushUndoBatch(undoItems);
    await chrome.tabs.remove(toClose);
    await updateAutoCleanupBadge(settings);
  }
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return normalizeSettings(stored[STORAGE_KEYS.settings]);
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({
    ...current,
    ...(patch || {}),
  });

  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: next });
  await syncAutoCleanupAlarm(next);
  await updateAutoCleanupBadge(next);
  return next;
}

async function syncAutoCleanupAlarm(settings) {
  await chrome.alarms.clear(ALARM_AUTO_CLEANUP);

  if (!settings.autoCleanup) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  await chrome.alarms.create(ALARM_AUTO_CLEANUP, {
    periodInMinutes: settings.autoCleanupIntervalMin,
  });
}

async function runAutoCleanupScan() {
  const settings = await getSettings();
  if (!settings.autoCleanup) return;

  await updateAutoCleanupBadge(settings);
}

async function updateAutoCleanupBadge(settings) {
  if (!settings.autoCleanup) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "tab customization" });
    return;
  }

  const allTabs = await chrome.tabs.query({});
  const plan = buildDuplicatePlan(allTabs, settings);
  const total = plan.toClose.length;

  await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  await chrome.action.setBadgeText({ text: total > 0 ? String(Math.min(total, 99)) : "" });
  await chrome.action.setTitle({
    title: total > 0
      ? `tab customization (${total} duplicate${total === 1 ? "" : "s"} found)`
      : "tab customization",
  });
}

async function previewDuplicates() {
  const settings = await getSettings();
  const tabs = await getTabsForScope({
    scope: settings.scope,
    currentWindowId: await getCurrentWindowId(),
  });
  const plan = buildDuplicatePlan(tabs, settings);

  return {
    success: true,
    duplicates: plan.toClose.length,
    duplicateGroups: plan.duplicateGroups,
  };
}

async function groupTabsByPreset({ settings, scope, currentWindowId }) {
  const tabs = await getTabsForScope({ scope, currentWindowId });
  const customRules = parseCustomGroupRules(settings.customGroupRules);
  const excludedDomains = parseExcludedDomains(settings.excludedDomains);

  const groupsByKey = new Map();
  const uniqueTitles = new Set();

  for (const tab of tabs) {
    if (!tab?.id || !Number.isInteger(tab.windowId) || shouldExcludeTab(tab, settings, excludedDomains)) continue;

    const title = getGroupKey(tab.url, settings, customRules);
    if (!title) continue;

    const mapKey = `${tab.windowId}::${title}`;
    if (!groupsByKey.has(mapKey)) {
      groupsByKey.set(mapKey, {
        windowId: tab.windowId,
        title,
        tabIds: [],
      });
    }
    groupsByKey.get(mapKey).tabIds.push(tab.id);
    uniqueTitles.add(title);
  }

  let groupsCreated = 0;
  const colors = ["blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple", "grey"];

  for (const groupInfo of groupsByKey.values()) {
    const { title, tabIds, windowId } = groupInfo;
    if (tabIds.length < 2) continue;

    try {
      const groupId = await chrome.tabs.group({
        tabIds,
        createProperties: { windowId },
      });
      const color = colors[Math.abs(hashString(title)) % colors.length];
      await chrome.tabGroups.update(groupId, {
        title: title.length > 20 ? `${title.slice(0, 18)}..` : title,
        color,
        collapsed: false,
      });
      groupsCreated += 1;
    } catch (err) {
      console.warn(`[TabManager] Could not group "${title}":`, err?.message || err);
    }
  }

  return {
    success: true,
    groupsCreated,
    domainsFound: uniqueTitles.size,
  };
}

async function removeDuplicateTabs({ settings, scope, currentWindowId }) {
  const tabs = await getTabsForScope({ scope, currentWindowId });
  const plan = buildDuplicatePlan(tabs, settings);

  if (plan.toClose.length === 0) {
    await updateAutoCleanupBadge(settings);
    return {
      success: true,
      removed: 0,
      remaining: tabs.length,
      duplicateGroups: 0,
      undoDepth: await getUndoDepth(),
    };
  }

  await pushUndoBatch(plan.undoItems);
  await chrome.tabs.remove(plan.toClose);

  const remainingTabs = await getTabsForScope({ scope, currentWindowId });
  await updateAutoCleanupBadge(settings);

  return {
    success: true,
    removed: plan.toClose.length,
    remaining: remainingTabs.length,
    duplicateGroups: plan.duplicateGroups,
    undoDepth: await getUndoDepth(),
  };
}

function buildDuplicatePlan(tabs, settings) {
  const excludedDomains = parseExcludedDomains(settings.excludedDomains);
  const grouped = new Map();

  for (const tab of tabs) {
    if (!tab?.id || shouldExcludeTab(tab, settings, excludedDomains)) continue;

    const key = normalizeUrlForMatch(tab.url, settings.duplicateMatchMode);
    if (!key) continue;

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(tab);
  }

  const toClose = [];
  const undoItems = [];
  let duplicateGroups = 0;

  for (const sameTabs of grouped.values()) {
    if (sameTabs.length < 2) continue;

    duplicateGroups += 1;
    const keepTab = chooseTabToKeep(sameTabs, settings.smartKeepRule);

    for (const tab of sameTabs) {
      if (!tab?.id || tab.id === keepTab.id) continue;

      toClose.push(tab.id);
      undoItems.push({
        url: tab.url,
        windowId: tab.windowId,
        index: tab.index,
        pinned: Boolean(tab.pinned),
      });
    }
  }

  return {
    toClose,
    undoItems,
    duplicateGroups,
  };
}

function chooseTabToKeep(tabs, rule) {
  const sorted = [...tabs].sort((a, b) => {
    if (rule === "pinned") {
      const pinnedCompare = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinnedCompare !== 0) return pinnedCompare;
    }

    if (rule === "active") {
      const activeCompare = Number(Boolean(b.active)) - Number(Boolean(a.active));
      if (activeCompare !== 0) return activeCompare;
    }

    if (rule === "recent") {
      const recentCompare = (b.lastAccessed || 0) - (a.lastAccessed || 0);
      if (recentCompare !== 0) return recentCompare;
    }

    const fallbackRecent = (b.lastAccessed || 0) - (a.lastAccessed || 0);
    if (fallbackRecent !== 0) return fallbackRecent;

    return (a.index || 0) - (b.index || 0);
  });

  return sorted[0];
}

async function undoLastRemoval() {
  const undoStack = await getUndoStack();
  if (undoStack.length === 0) {
    return { success: false, error: "Nothing to undo." };
  }

  const [entry, ...rest] = undoStack;
  await chrome.storage.local.set({ [STORAGE_KEYS.undoStack]: rest });

  let restored = 0;

  for (const item of entry.items) {
    if (!item?.url || !isSupportedTabUrl(item.url)) continue;

    const createInfo = {
      url: item.url,
      active: false,
      pinned: Boolean(item.pinned),
      index: Number.isFinite(item.index) ? Math.max(item.index, 0) : undefined,
    };

    if (Number.isFinite(item.windowId)) {
      createInfo.windowId = item.windowId;
    }

    try {
      await chrome.tabs.create(createInfo);
      restored += 1;
    } catch {
      const fallbackWindowId = await getCurrentWindowId();
      await chrome.tabs.create({
        url: item.url,
        active: false,
        pinned: Boolean(item.pinned),
        windowId: fallbackWindowId,
      });
      restored += 1;
    }
  }

  const settings = await getSettings();
  await updateAutoCleanupBadge(settings);

  return {
    success: true,
    restored,
    undoDepth: rest.length,
  };
}

async function getUndoStack() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.undoStack);
  const stack = stored[STORAGE_KEYS.undoStack];
  return Array.isArray(stack) ? stack : [];
}

async function getUndoDepth() {
  return (await getUndoStack()).length;
}

async function pushUndoBatch(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  const stack = await getUndoStack();
  stack.unshift({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    items,
  });

  if (stack.length > UNDO_LIMIT) {
    stack.length = UNDO_LIMIT;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.undoStack]: stack });
}

async function setGroupsCollapsed({ collapsed, scope, currentWindowId }) {
  const tabs = await getTabsForScope({ scope, currentWindowId });
  const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => Number.isInteger(id) && id >= 0))];

  for (const groupId of groupIds) {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: Boolean(collapsed) });
    } catch {
      // Ignore groups that no longer exist.
    }
  }

  return {
    success: true,
    updated: groupIds.length,
    collapsed: Boolean(collapsed),
  };
}

async function listWorkspaces() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.workspaces);
  const workspaces = stored[STORAGE_KEYS.workspaces];
  if (!Array.isArray(workspaces)) return [];

  return workspaces
    .filter((item) => item && Array.isArray(item.tabs))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function saveWorkspace({ name, scope, currentWindowId }) {
  const effectiveScope = scope || (await getSettings()).scope;
  const tabs = await getTabsForScope({ scope: effectiveScope, currentWindowId });

  const capturedTabs = tabs
    .filter((tab) => tab?.url && isSupportedTabUrl(tab.url))
    .map((tab) => ({
      url: tab.url,
      pinned: Boolean(tab.pinned),
      title: tab.title || "",
    }));

  if (capturedTabs.length === 0) {
    return {
      success: false,
      error: "No restorable tabs found in the selected scope.",
    };
  }

  const workspaces = await listWorkspaces();
  const workspace = {
    id: crypto.randomUUID(),
    name: (name || "").trim() || `Workspace ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    scope: effectiveScope,
    tabs: capturedTabs,
  };

  workspaces.unshift(workspace);
  if (workspaces.length > WORKSPACE_LIMIT) {
    workspaces.length = WORKSPACE_LIMIT;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.workspaces]: workspaces });

  return {
    success: true,
    workspace,
    workspaces,
  };
}

async function restoreWorkspace({ id, currentWindowId }) {
  if (!id) {
    return { success: false, error: "Workspace id is required." };
  }

  const workspaces = await listWorkspaces();
  const workspace = workspaces.find((item) => item.id === id);
  if (!workspace) {
    return { success: false, error: "Workspace not found." };
  }

  const targetWindowId = Number.isFinite(currentWindowId)
    ? currentWindowId
    : await getCurrentWindowId();

  let restored = 0;

  for (const tab of workspace.tabs) {
    if (!tab?.url || !isSupportedTabUrl(tab.url)) continue;

    await chrome.tabs.create({
      windowId: targetWindowId,
      url: tab.url,
      active: false,
      pinned: Boolean(tab.pinned),
    });
    restored += 1;
  }

  return {
    success: true,
    restored,
    workspaceName: workspace.name,
  };
}

async function deleteWorkspace(id) {
  if (!id) {
    return { success: false, error: "Workspace id is required." };
  }

  const workspaces = await listWorkspaces();
  const next = workspaces.filter((item) => item.id !== id);

  if (next.length === workspaces.length) {
    return { success: false, error: "Workspace not found." };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.workspaces]: next });

  return {
    success: true,
    workspaces: next,
  };
}

async function importWorkspaces(payload) {
  let parsed;

  try {
    parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return { success: false, error: "Invalid JSON file." };
  }

  const incoming = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.workspaces)
      ? parsed.workspaces
      : null;

  if (!incoming) {
    return { success: false, error: "No workspaces found in file." };
  }

  const existing = await listWorkspaces();
  const ids = new Set(existing.map((item) => item.id));
  const normalizedIncoming = [];

  for (const item of incoming) {
    if (!item || !Array.isArray(item.tabs)) continue;

    const tabs = item.tabs
      .filter((tab) => tab?.url && isSupportedTabUrl(tab.url))
      .map((tab) => ({
        url: tab.url,
        pinned: Boolean(tab.pinned),
        title: String(tab.title || ""),
      }));

    if (tabs.length === 0) continue;

    let id = String(item.id || "").trim();
    if (!id || ids.has(id)) {
      id = crypto.randomUUID();
    }
    ids.add(id);

    normalizedIncoming.push({
      id,
      name: String(item.name || "Imported Workspace").trim() || "Imported Workspace",
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      scope: item.scope === "allWindows" ? "allWindows" : "currentWindow",
      tabs,
    });
  }

  if (normalizedIncoming.length === 0) {
    return { success: false, error: "No valid workspaces to import." };
  }

  const merged = [...normalizedIncoming, ...existing]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, WORKSPACE_LIMIT);

  await chrome.storage.local.set({ [STORAGE_KEYS.workspaces]: merged });

  return {
    success: true,
    imported: normalizedIncoming.length,
    workspaces: merged,
  };
}

async function searchTabs({ query, sortBy, sortDirection, scope, currentWindowId }) {
  const tabs = await getTabsForScope({ scope, currentWindowId });
  const normalizedQuery = String(query || "").trim().toLowerCase();

  let filtered = tabs;
  if (normalizedQuery) {
    filtered = tabs.filter((tab) => {
      const title = String(tab.title || "").toLowerCase();
      const url = String(tab.url || "").toLowerCase();
      return title.includes(normalizedQuery) || url.includes(normalizedQuery);
    });
  }

  filtered.sort(createTabComparator(sortBy, sortDirection));

  const results = filtered.slice(0, 200).map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "Untitled",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    lastAccessed: tab.lastAccessed || 0,
  }));

  return {
    success: true,
    results,
    total: filtered.length,
  };
}

async function focusTab(tabId, windowId) {
  if (!Number.isInteger(tabId)) {
    return { success: false, error: "tabId is required." };
  }

  await chrome.tabs.update(tabId, { active: true });

  if (Number.isInteger(windowId)) {
    await chrome.windows.update(windowId, { focused: true });
  }

  return { success: true };
}

async function sortTabs({ sortBy, sortDirection, scope, currentWindowId }) {
  const tabs = await getTabsForScope({ scope, currentWindowId });
  const byWindow = new Map();

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    if (!byWindow.has(tab.windowId)) {
      byWindow.set(tab.windowId, []);
    }
    byWindow.get(tab.windowId).push(tab);
  }

  let windowsSorted = 0;

  for (const [windowId, windowTabs] of byWindow.entries()) {
    const comparator = createTabComparator(sortBy, sortDirection);
    const pinned = windowTabs.filter((tab) => tab.pinned).sort(comparator);
    const unpinned = windowTabs.filter((tab) => !tab.pinned).sort(comparator);
    const ordered = [...pinned, ...unpinned];

    if (ordered.length < 2) continue;

    const ids = ordered.map((tab) => tab.id);
    await chrome.tabs.move(ids, { windowId, index: 0 });
    windowsSorted += 1;
  }

  return {
    success: true,
    windowsSorted,
  };
}

function createTabComparator(sortBy, sortDirection = "asc") {
  const multiplier = sortDirection === "desc" ? -1 : 1;

  if (sortBy === "title") {
    return (a, b) => multiplier * String(a.title || "").localeCompare(String(b.title || ""));
  }

    // For time: asc = oldest first (lower value first), desc = newest first (higher value first)
    return (a, b) => multiplier * ((a.lastAccessed || 0) - (b.lastAccessed || 0));

  if (sortBy === "pinned") {
    return (a, b) => {
      const pinCompare = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinCompare !== 0) return pinCompare;
      return multiplier * String(a.title || "").localeCompare(String(b.title || ""));
    };
  }

  // default: domain
  return (a, b) => {
    const d1 = getBaseDomain(extractHostname(a.url));
    const d2 = getBaseDomain(extractHostname(b.url));
    const domainCompare = d1.localeCompare(d2);
    if (domainCompare !== 0) return multiplier * domainCompare;
    return multiplier * String(a.title || "").localeCompare(String(b.title || ""));
  };
}

async function snoozeTab({ tabId, durationMinutes }) {
  if (!Number.isInteger(tabId)) {
    return { success: false, error: "tabId is required." };
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isSupportedTabUrl(tab.url)) {
    return { success: false, error: "This tab cannot be snoozed." };
  }

  const minutes = clamp(Number(durationMinutes) || 60, 1, 10080);
  const wakeAt = Date.now() + minutes * 60 * 1000;

  const entry = {
    id: crypto.randomUUID(),
    wakeAt,
    tab: {
      url: tab.url,
      pinned: Boolean(tab.pinned),
    },
  };

  const snoozedTabs = await getSnoozedTabs();
  snoozedTabs.push(entry);

  await chrome.storage.local.set({ [STORAGE_KEYS.snoozedTabs]: snoozedTabs });
  await chrome.alarms.create(`${ALARM_SNOOZE_PREFIX}${entry.id}`, { when: wakeAt });
  await chrome.tabs.remove(tabId);

  return {
    success: true,
    wakeAt,
  };
}

async function wakeSnoozedTab(snoozeId) {
  const snoozedTabs = await getSnoozedTabs();
  const entry = snoozedTabs.find((item) => item.id === snoozeId);
  if (!entry) return;

  try {
    await chrome.tabs.create({
      url: entry.tab.url,
      active: false,
      pinned: Boolean(entry.tab.pinned),
    });
  } finally {
    const rest = snoozedTabs.filter((item) => item.id !== snoozeId);
    await chrome.storage.local.set({ [STORAGE_KEYS.snoozedTabs]: rest });
  }
}

async function getSnoozedTabs() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.snoozedTabs);
  const snoozedTabs = stored[STORAGE_KEYS.snoozedTabs];
  return Array.isArray(snoozedTabs) ? snoozedTabs : [];
}

async function rescheduleSnoozeAlarms() {
  const snoozedTabs = await getSnoozedTabs();

  for (const entry of snoozedTabs) {
    if (!entry?.id || !Number.isFinite(entry.wakeAt)) continue;

    const alarmName = `${ALARM_SNOOZE_PREFIX}${entry.id}`;

    if (entry.wakeAt <= Date.now()) {
      await wakeSnoozedTab(entry.id);
      continue;
    }

    await chrome.alarms.create(alarmName, { when: entry.wakeAt });
  }
}

function shouldExcludeTab(tab, settings, excludedDomains) {
  if (!tab?.url || !isSupportedTabUrl(tab.url)) return true;

  if (settings.excludePinned && tab.pinned) return true;
  if (settings.excludeMuted && tab.mutedInfo?.muted) return true;
  if (settings.excludeAudible && tab.audible) return true;

  const host = extractHostname(tab.url);
  if (!host) return true;

  if (excludedDomains.length > 0 && matchesAnyDomain(host, excludedDomains)) {
    return true;
  }

  return false;
}

function parseExcludedDomains(input) {
  return String(input || "")
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function matchesAnyDomain(host, domains) {
  return domains.some((domainRule) => {
    const rule = domainRule.replace(/^\*\./, "");
    return host === rule || host.endsWith(`.${rule}`);
  });
}

function normalizeUrlForMatch(url, mode) {
  try {
    const parsed = new URL(url);

    if (mode === "ignoreHash") {
      parsed.hash = "";
      return parsed.toString();
    }

    if (mode === "ignoreQuery") {
      parsed.search = "";
      return parsed.toString();
    }

    if (mode === "domainPath") {
      return `${parsed.hostname.toLowerCase()}${parsed.pathname}`;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function getGroupKey(url, settings, customRules) {
  if (!url) return null;

  const host = extractHostname(url);
  if (!host) return null;

  if (settings.groupPreset === "subdomain") {
    return host;
  }

  if (settings.groupPreset === "custom") {
    const matched = matchCustomRule(url, host, customRules);
    if (matched) return matched;
  }

  return getBaseDomain(host);
}

function parseCustomGroupRules(input) {
  const lines = String(input || "").split(/\r?\n/);
  const rules = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let separator = null;
    if (trimmed.includes("=>")) separator = "=>";
    else if (trimmed.includes("=")) separator = "=";

    if (!separator) continue;

    const [rawPattern, rawGroupName] = trimmed.split(separator);
    const pattern = String(rawPattern || "").trim().toLowerCase();
    const groupName = String(rawGroupName || "").trim();

    if (!pattern || !groupName) continue;
    rules.push({ pattern, groupName });
  }

  return rules;
}

function matchCustomRule(url, host, rules) {
  const lowerUrl = url.toLowerCase();

  for (const rule of rules) {
    if (rule.pattern.startsWith("*.")) {
      const domain = rule.pattern.slice(2);
      if (host === domain || host.endsWith(`.${domain}`)) {
        return rule.groupName;
      }
      continue;
    }

    if (rule.pattern.includes("/")) {
      if (lowerUrl.includes(rule.pattern)) {
        return rule.groupName;
      }
      continue;
    }

    if (host === rule.pattern || host.endsWith(`.${rule.pattern}`) || lowerUrl.includes(rule.pattern)) {
      return rule.groupName;
    }
  }

  return null;
}

function isSupportedTabUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    const blocked = new Set([
      "chrome:",
      "chrome-extension:",
      "edge:",
      "about:",
      "moz-extension:",
      "devtools:",
      "view-source:",
    ]);
    return !blocked.has(protocol);
  } catch {
    return false;
  }
}

function extractHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getBaseDomain(hostname) {
  if (!hostname) return "";

  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;

  return parts.slice(-2).join(".");
}

async function getTabsForScope({ scope, currentWindowId }) {
  if (scope === "allWindows") {
    return chrome.tabs.query({});
  }

  const windowId = Number.isFinite(currentWindowId)
    ? currentWindowId
    : await getCurrentWindowId();

  return chrome.tabs.query({ windowId });
}

async function getCurrentWindowId() {
  const win = await chrome.windows.getLastFocused({ populate: false });
  return win.id;
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
