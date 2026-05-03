/**
 * Universal browser API wrapper for cross-browser compatibility.
 * Prefers native `browser` namespace (Firefox) over `chrome` (Chrome/Edge).
 */
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
  const els = {
    saveBtn: document.getElementById('save'),
    status: document.getElementById('status'),
    workspaceList: document.getElementById('workspace-list'),
    workspaceName: document.getElementById('workspace-name'),
    btnSaveWorkspace: document.getElementById('btn-save-workspace'),
    btnRestoreWorkspace: document.getElementById('btn-restore-workspace'),
    btnDeleteWorkspace: document.getElementById('btn-delete-workspace')
  };

  const configIds = [
    'default-sort-mode', 'default-snooze-value', 'default-snooze-unit',
    'scope', 'duplicate-mode', 'keep-rule', 'exclude-pinned', 
    'exclude-muted', 'exclude-audible', 'excluded-domains',
    'auto-cleanup', 'auto-cleanup-interval', 'auto-discard', 
    'auto-discard-threshold', 'group-preset', 'custom-group-rules'
  ];

  // Init
  async function init() {
    await loadSettings();
    const { workspaces } = await sendMessage({ action: 'listWorkspaces' });
    renderWorkspaces(workspaces || []);
  }

  // Load
  async function loadSettings() {
    const result = await sendMessage({ action: 'getSettings' });
    if (!result.success) return;

    const s = result.settings;
    document.getElementById('default-sort-mode').value = s.defaultSortMode || 'domain';
    document.getElementById('default-snooze-value').value = s.defaultSnoozeValue || 60;
    document.getElementById('default-snooze-unit').value = s.defaultSnoozeUnit || 'minutes';
    document.getElementById('scope').value = s.scope || 'currentWindow';
    document.getElementById('duplicate-mode').value = s.duplicateMatchMode || 'exact';
    document.getElementById('keep-rule').value = s.smartKeepRule || 'active';
    document.getElementById('group-preset').value = s.groupPreset || 'domain';
    
    document.getElementById('exclude-pinned').checked = !!s.excludePinned;
    document.getElementById('exclude-muted').checked = !!s.excludeMuted;
    document.getElementById('exclude-audible').checked = !!s.excludeAudible;
    document.getElementById('excluded-domains').value = s.excludedDomains || '';
    
    document.getElementById('auto-cleanup').checked = !!s.autoCleanup;
    document.getElementById('auto-cleanup-interval').value = s.autoCleanupIntervalMin || 30;
    document.getElementById('auto-discard').checked = !!s.autoDiscard;
    document.getElementById('auto-discard-threshold').value = s.autoDiscardThresholdMin || 60;
    
    document.getElementById('custom-group-rules').value = s.customGroupRules || '';
  }

  // Save
  async function saveSettings() {
    const settings = {
      defaultSortMode: document.getElementById('default-sort-mode').value,
      defaultSnoozeValue: parseInt(document.getElementById('default-snooze-value').value),
      defaultSnoozeUnit: document.getElementById('default-snooze-unit').value,
      scope: document.getElementById('scope').value,
      duplicateMatchMode: document.getElementById('duplicate-mode').value,
      smartKeepRule: document.getElementById('keep-rule').value,
      groupPreset: document.getElementById('group-preset').value,
      
      excludePinned: document.getElementById('exclude-pinned').checked,
      excludeMuted: document.getElementById('exclude-muted').checked,
      excludeAudible: document.getElementById('exclude-audible').checked,
      excludedDomains: document.getElementById('excluded-domains').value,
      
      autoCleanup: document.getElementById('auto-cleanup').checked,
      autoCleanupIntervalMin: parseInt(document.getElementById('auto-cleanup-interval').value),
      autoDiscard: document.getElementById('auto-discard').checked,
      autoDiscardThresholdMin: parseInt(document.getElementById('auto-discard-threshold').value),
      
      customGroupRules: document.getElementById('custom-group-rules').value
    };

    const result = await sendMessage({ action: 'updateSettings', settings });
    if (result.success) {
      showStatus('Settings Applied Successfully');
    }
  }

  // Workspaces
  function renderWorkspaces(workspaces) {
    els.workspaceList.innerHTML = '';
    if (!workspaces.length) {
      els.workspaceList.innerHTML = '<option value="">No workspaces found</option>';
      return;
    }
    workspaces.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = `${ws.name} (${ws.tabs.length} tabs)`;
      els.workspaceList.appendChild(opt);
    });
  }

  function showStatus(msg) {
    els.status.textContent = msg;
    els.status.classList.add('show');
    setTimeout(() => els.status.classList.remove('show'), 3000);
  }

  function sendMessage(msg) {
    return new Promise(resolve => {
      browserAPI.runtime.sendMessage(msg, resolve);
    });
  }

  // Events
  els.saveBtn.addEventListener('click', saveSettings);
  
  els.btnSaveWorkspace.addEventListener('click', async () => {
    const name = els.workspaceName.value.trim();
    if (!name) return;
    const result = await sendMessage({ action: 'saveWorkspace', name, scope: document.getElementById('scope').value });
    if (result.success) {
      els.workspaceName.value = '';
      renderWorkspaces(result.workspaces);
      showStatus('Workspace Saved');
    }
  });

  els.btnRestoreWorkspace.addEventListener('click', async () => {
    const id = els.workspaceList.value;
    if (!id) return;
    const result = await sendMessage({ action: 'restoreWorkspace', id });
    if (result.success) showStatus(`Restored ${result.restored} Tabs`);
  });

  els.btnDeleteWorkspace.addEventListener('click', async () => {
    const id = els.workspaceList.value;
    if (!id) return;
    const result = await sendMessage({ action: 'deleteWorkspace', id });
    if (result.success) {
      renderWorkspaces(result.workspaces);
      showStatus('Workspace Deleted');
    }
  });

  // Sidebar Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const sectionId = item.getAttribute('data-section');
      
      // Update sidebar
      document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      
      // Update sections
      document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
      document.getElementById(`section-${sectionId}`).classList.add('active');
    });
  });

  init();
});
