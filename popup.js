const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

document.addEventListener('DOMContentLoaded', () => {
  const els = {
    tabCount: document.getElementById('tab-count'),
    status: document.getElementById('status'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnGroup: document.getElementById('btn-group'),
    btnRemove: document.getElementById('btn-remove'),
    btnUndo: document.getElementById('btn-undo'),
    btnSort: document.getElementById('btn-sort'),
    openTabsList: document.getElementById('open-tabs-list'),
    tabSearch: document.getElementById('tab-search'),
  };

  let currentWindowId = null;
  let cachedSettings = { scope: 'currentWindow' };

  // Init
  async function init() {
    const win = await browserAPI.windows.getCurrent({ populate: false });
    currentWindowId = win?.id;

    const initData = await sendMessage({ action: 'initPopup' });
    if (initData.success) {
      cachedSettings = initData.settings || {};
      updateUndoButton(initData.undoDepth || 0);
      updateTabCount();
      loadTabs(); // Replace runSearch with loadTabs
    }
  }

  // Update Undo state
  function updateUndoButton(depth) {
    if (!els.btnUndo) return;
    const span = els.btnUndo.querySelector('span');
    if (span) span.textContent = depth > 0 ? `Undo (${depth})` : 'Undo';
    els.btnUndo.disabled = depth === 0;
  }

  // Update Tab Count
  async function updateTabCount() {
    const query = cachedSettings.scope === 'allWindows' ? {} : { windowId: currentWindowId };
    const tabs = await browserAPI.tabs.query(query);
    els.tabCount.textContent = `${tabs.length} Tab${tabs.length === 1 ? '' : 's'}`;
  }

  // Show status toast
  function showStatus(msg, tone = 'success') {
    els.status.textContent = msg;
    els.status.className = `status ${tone} show`;
    setTimeout(() => els.status.classList.remove('show'), 3000);
  }

  // Messaging helper
  function sendMessage(msg) {
    return new Promise(resolve => {
      browserAPI.runtime.sendMessage(msg, resolve);
    });
  }

  // Bind Events
  els.btnOpenSettings.addEventListener('click', () => {
    browserAPI.runtime.openOptionsPage();
  });

  els.btnGroup.addEventListener('click', async () => {
    const result = await sendMessage({ 
      action: 'groupTabs', 
      scope: cachedSettings.scope, 
      currentWindowId 
    });
    if (result.success) {
      showStatus(result.groupsCreated > 0 ? `${result.groupsCreated} Groups created` : 'No groups created');
      updateTabCount();
    }
  });

  els.btnRemove.addEventListener('click', async () => {
    const result = await sendMessage({ 
      action: 'removeDuplicates', 
      scope: cachedSettings.scope, 
      currentWindowId 
    });
    if (result.success) {
      showStatus(result.removed > 0 ? `${result.removed} Duplicates removed` : 'No duplicates found');
      updateUndoButton(result.undoDepth || 0);
      updateTabCount();
      loadTabs();
    }
  });

  els.btnUndo.addEventListener('click', async () => {
    const result = await sendMessage({ action: 'undoLastRemoval' });
    if (result.success) {
      showStatus(`${result.restored} Tab(s) restored`);
      updateUndoButton(result.undoDepth || 0);
      updateTabCount();
      loadTabs();
    }
  });

  els.btnSort.addEventListener('click', async () => {
    const result = await sendMessage({ 
      action: 'sortTabs', 
      sortBy: 'domain', 
      sortDirection: 'asc', 
      scope: cachedSettings.scope, 
      currentWindowId 
    });
    if (result.success) {
      showStatus(`Tabs sorted`);
      loadTabs();
    }
  });

  // Tab Loading Logic
  async function loadTabs() {
    // Load Open Tabs
    const openResult = await sendMessage({
      action: 'searchTabs',
      query: '', // All tabs
      sortBy: cachedSettings.defaultSortMode || 'domain',
      sortDirection: 'asc',
      scope: cachedSettings.scope,
      currentWindowId
    });

    if (openResult.success) {
      renderTabList(els.openTabsList, openResult.results || [], true);
      
      // Setup Search Filtering
      els.tabSearch.oninput = (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = openResult.results.filter(t => 
          (t.title || '').toLowerCase().includes(query) || 
          (t.url || '').toLowerCase().includes(query)
        );
        renderTabList(els.openTabsList, filtered, true);
      };
    }
  }

  function renderTabList(container, tabs, isOpen) {
    container.innerHTML = '';
    
    if (!tabs.length) {
      container.innerHTML = `<div class="result-item" style="justify-content:center; color:var(--muted); font-size:12px;">No ${isOpen ? 'open' : 'closed'} tabs</div>`;
      return;
    }

    tabs.forEach(tab => {
      const row = document.createElement('div');
      row.className = `result-item ${tab.audible ? 'audible' : ''}`;
      
      const faviconUrl = tab.favIconUrl || 'icons/icon16.png';
      
      row.innerHTML = `
        <div class="row" style="gap: 12px; flex: 1; min-width: 0;">
          <img src="${faviconUrl}" class="favicon" onerror="this.src='icons/icon16.png'">
          <div class="result-content">
            <div class="result-title-row">
              <span class="result-title">${tab.title || 'Untitled'}</span>
              <div class="indicator-row">
                ${tab.audible ? `
                  <svg class="tag-icon warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  </svg>
                ` : ''}
                ${tab.discarded ? `
                  <svg class="tag-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                  </svg>
                ` : ''}
              </div>
            </div>
            <span class="result-url">${tab.url || ''}</span>
          </div>
        </div>
        <div class="row" style="gap: 4px;">
          ${isOpen ? `
            <button class="mini-btn focus-btn" title="Focus Tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
            </button>
            <button class="mini-btn close-btn" title="Close Tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          ` : `
            <button class="mini-btn restore-btn" title="Restore Tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                <path d="M21 3v5h-5"></path>
                <polyline points="12 8 12 12 15 15"></polyline>
              </svg>
            </button>
          `}
        </div>
      `;
      
      if (isOpen) {
        row.querySelector('.focus-btn').onclick = () => {
          browserAPI.runtime.sendMessage({ action: 'focusTab', tabId: tab.id, windowId: tab.windowId });
          window.close();
        };
        row.querySelector('.close-btn').onclick = async () => {
          await browserAPI.runtime.sendMessage({ action: 'closeTab', tabId: tab.id });
          loadTabs();
          updateTabCount();
        };
      } else {
        row.querySelector('.mini-btn').onclick = async () => {
          await browserAPI.tabs.create({ url: tab.url, active: false });
          loadTabs();
        };
      }
      
      container.appendChild(row);
    });
  }

  init();
});
