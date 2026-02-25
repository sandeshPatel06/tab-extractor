/**
 * popup.js — tab customization
 */

const els = {
  tabCount: document.getElementById("tab-count"),
  status: document.getElementById("status"),

  btnOpenSettings: document.getElementById("btn-open-settings"),

  btnGroup: document.getElementById("btn-group"),
  btnRemove: document.getElementById("btn-remove"),
  btnUndo: document.getElementById("btn-undo"),
  btnSort: document.getElementById("btn-sort"),
  btnDiscard: document.getElementById("btn-discard"),

  searchQuery: document.getElementById("search-query"),
  btnSearch: document.getElementById("btn-search"),
  searchResults: document.getElementById("search-results"),
};

let currentWindowId = null;
let searchDebounce = null;
let cachedSettings = { scope: "currentWindow" };

init().catch((err) => {
  showStatus(err.message || String(err), "error");
});

async function init() {
  bindEvents();

  const win = await chrome.windows.getCurrent({ populate: false });
  currentWindowId = win?.id;

  const initData = await sendMessage({ action: "initPopup" });
  if (!initData.success) {
    showStatus(initData.error || "Failed to initialize popup.", "error");
    return;
  }

  cachedSettings = initData.settings || DEFAULT_SETTINGS;
  updateUndoButton(initData.undoDepth || 0);
  await updateTabCount();
  await runSearch();
}

function bindEvents() {
  els.btnOpenSettings.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.btnGroup.addEventListener("click", () => {
    void runWithButton(els.btnGroup, async () => {
      if (!(await savePreferences(false))) return;
      const result = await sendMessage({
        action: "groupTabs",
        scope: cachedSettings.scope,
        currentWindowId,
      });

      if (!result.success) {
        showStatus(result.error || "Grouping failed.", "error");
        return;
      }

      showStatus(
        result.groupsCreated > 0
          ? `${result.groupsCreated} group${result.groupsCreated === 1 ? "" : "s"} created.`
          : "No groups created.",
        "success"
      );
    });
  });

  els.btnRemove.addEventListener("click", () => {
    void runWithButton(els.btnRemove, async () => {
      if (!(await savePreferences(false))) return;
      const result = await sendMessage({
        action: "removeDuplicates",
        scope: cachedSettings.scope,
        currentWindowId,
      });

      if (!result.success) {
        showStatus(result.error || "Duplicate cleanup failed.", "error");
        return;
      }

      updateUndoButton(result.undoDepth || 0);
      await updateTabCount();
      await refreshDuplicatePreview();
      await runSearch();

      showStatus(
        result.removed > 0
          ? `${result.removed} duplicate${result.removed === 1 ? "" : "s"} removed.`
          : "No duplicates found.",
        "success"
      );
    });
  });

  els.btnUndo.addEventListener("click", () => {
    void runWithButton(els.btnUndo, async () => {
      const result = await sendMessage({ action: "undoLastRemoval" });
      if (!result.success) {
        showStatus(result.error || "Nothing to undo.", "error");
        return;
      }

      updateUndoButton(result.undoDepth || 0);
      await updateTabCount();
      await refreshDuplicatePreview();
      await runSearch();
      showStatus(`${result.restored} tab${result.restored === 1 ? "" : "s"} restored.`, "success");
    });
  });

  els.btnSort.addEventListener("click", () => {
    void runWithButton(els.btnSort, async () => {
      if (!(await savePreferences(false))) return;
      const result = await sendMessage({
        action: "sortTabs",
        sortBy: "domain",
        sortDirection: "asc",
        scope: cachedSettings.scope,
        currentWindowId,
      });

      if (!result.success) {
        showStatus(result.error || "Sort failed.", "error");
        return;
      }

      await runSearch();
      showStatus(`Sorted tabs in ${result.windowsSorted} window${result.windowsSorted === 1 ? "" : "s"}.`, "success");
    });
  });

  els.btnDiscard.addEventListener("click", () => {
    void runWithButton(els.btnDiscard, async () => {
      const result = await sendMessage({ action: "discardInactive" });
      if (!result.success) {
        showStatus(result.error || "Hibernation failed.", "error");
        return;
      }

      showStatus(
        result.discarded > 0
          ? `${result.discarded} tab${result.discarded === 1 ? "" : "s"} hibernated.`
          : "All tabs are active.",
        "success"
      );
    });
  });

  els.btnSearch.addEventListener("click", () => {
    void runSearch();
  });

  els.searchQuery.addEventListener("input", scheduleSearch);
}


async function savePreferences(notify) {
  return true; // Simplified, as we don't have scope in UI anymore.
}

function applySettingsToUI(settings) {
  if (!settings) return;
  cachedSettings = settings;
}

async function updateTabCount() {
  if (!Number.isFinite(currentWindowId)) {
    const win = await chrome.windows.getCurrent({ populate: false });
    currentWindowId = win?.id;
  }

  const query = cachedSettings.scope === "allWindows"
    ? {}
    : { windowId: currentWindowId };

  const tabs = await chrome.tabs.query(query);
  els.tabCount.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
}

async function refreshDuplicatePreview() {
  const preview = await sendMessage({ action: "previewDuplicates" });
  updateDuplicatePreview(preview);
}

function updateDuplicatePreview(previewResponse) {
  // UI section removed
}

function updateUndoButton(depth) {
  const span = els.btnUndo.querySelector("span");
  if (span) {
    span.textContent = depth > 0 ? `Undo (${depth})` : "Undo";
  }
  els.btnUndo.disabled = depth === 0;
}


function scheduleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    void runSearch();
  }, 180);
}

async function runSearch() {
  const result = await sendMessage({
    action: "searchTabs",
    query: els.searchQuery.value,
    sortBy: "domain",
    sortDirection: "asc",
    scope: cachedSettings.scope,
    currentWindowId,
  });

  if (!result.success) {
    showStatus(result.error || "Search failed.", "error");
    return;
  }

  renderSearchResults(result.results || []);
}

function renderSearchResults(results) {
  els.searchResults.innerHTML = "";

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No matching tabs.";
    els.searchResults.appendChild(empty);
    return;
  }

  for (const tab of results) {
    const row = document.createElement("div");
    row.className = "result-row";

    const meta = document.createElement("div");
    meta.className = "result-meta";

    const title = document.createElement("div");
    title.className = "result-title";

    if (tab.favIconUrl) {
      const icon = document.createElement("img");
      icon.src = tab.favIconUrl;
      icon.className = "result-icon";
      // Handle broken images
      icon.onerror = () => { icon.style.display = 'none'; };
      title.appendChild(icon);
    }

    const titleText = document.createElement("span");
    titleText.textContent = tab.title || "Untitled";
    title.appendChild(titleText);

    const url = document.createElement("div");
    url.className = "result-url";
    url.textContent = tab.url || "";

    meta.appendChild(title);
    meta.appendChild(url);

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const openBtn = document.createElement("button");
    openBtn.className = "mini-btn";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", async () => {
      const res = await sendMessage({
        action: "focusTab",
        tabId: tab.id,
        windowId: tab.windowId,
      });

      if (!res.success) {
        showStatus(res.error || "Could not focus tab.", "error");
        return;
      }

      window.close();
    });

    actions.appendChild(openBtn);

    row.appendChild(meta);
    row.appendChild(actions);

    els.searchResults.appendChild(row);
  }
}


async function runWithButton(button, handler) {
  setButtonLoading(button, true);
  try {
    await handler();
  } finally {
    setButtonLoading(button, false);
  }
}

function setButtonLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("loading", loading);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response || { success: false, error: "No response from background script." });
    });
  });
}

function showStatus(text, tone = "info", duration = 3200) {
  els.status.textContent = text;
  els.status.className = `status ${tone}`;

  clearTimeout(els.status._timeout);
  if (duration > 0) {
    els.status._timeout = setTimeout(() => {
      els.status.className = "status hidden";
    }, duration);
  }
}

function formatDateTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "later";
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
