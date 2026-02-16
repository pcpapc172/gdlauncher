// Global state
let currentSettings = {};
let instances = [];
let selectedInstance = null;
let isEditMode = false;
let editingInstanceName = null;
let isGameRunning = false;
let editorSelectedKey = null;
let monacoEditor = null;
let appVersion = '1.0.0';
let tourCurrentStep = 0;
let pendingChangelog = false; 

// DOM Elements
const getElem = (id) => document.getElementById(id);

const instanceList = getElem('instance-list');
const launchBtn = getElem('launch-btn');
const createBtn = getElem('create-btn');
const editBtn = getElem('edit-btn');
const deleteBtn = getElem('delete-btn');
const settingsBtn = getElem('settings-btn');
const downloadBtn = getElem('download-btn');
const editorBtn = getElem('editor-btn');
const statusLabel = getElem('status-label');
const progressBar = getElem('progress-bar');
const progressContainer = document.querySelector('.progress-container');
const instanceModal = getElem('instance-modal');
const modalTitle = getElem('modal-title');
const settingsModal = getElem('settings-modal');
const downloadsModal = getElem('downloads-modal');
const editorModal = getElem('editor-modal');
const codeModal = getElem('code-modal');
const changelogModal = getElem('changelog-modal');
const tourOverlay = getElem('tour-overlay');
const tourTooltip = getElem('tour-tooltip');
const instanceNameInput = getElem('instance-name');
const localVersionSelect = getElem('local-version');
const exePathInput = getElem('exe-path');
const saveFolderInput = getElem('save-folder');
const geodeCheckbox = getElem('geode-compatible');
const megahackCheckbox = getElem('use-megahack');
const steamEmuCheckbox = getElem('use-steam-emu');
const skipRestartCheckbox = getElem('skip-restart-check'); 
const downloadList = getElem('download-list');
const editorInstanceSelect = getElem('editor-instance-select');
const editorLevelsList = getElem('editor-levels-list');
const editorActions = getElem('editor-actions');
const btnEditRaw = getElem('btn-edit-raw');
const btnImportNew = getElem('btn-import-new');
const btnRenameLevel = getElem('btn-rename-level');
const editorLevelNameInput = getElem('editor-level-name');
const btnOpenInEditor = getElem('btn-open-in-editor');
const editSaveSection = getElem('edit-save-section');

// Add after DOM Elements section
const notificationEl = getElem('app-notification');
const notificationText = getElem('notification-text');
const notificationClose = getElem('notification-close');

// Notification system
function showNotification(message, type = 'info', duration = 4000) {
    notificationText.textContent = message;
    notificationEl.className = 'app-notification show';
    
    if (type === 'error') notificationEl.classList.add('error');
    else if (type === 'success') notificationEl.classList.add('success');
    else if (type === 'warning') notificationEl.classList.add('warning');
    
    if (duration > 0) {
        setTimeout(() => {
            notificationEl.classList.remove('show');
        }, duration);
    }
}

function hideNotification() {
    notificationEl.classList.remove('show');
}

// --- CHANGELOG DATA ---
const LATEST_CHANGELOG = `
<ul class="changelog-list">
    <li><strong>Syncing:</strong> fixed closing while syncing</li>
</ul>
<p><em>gd</em></p>
`;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadSettings();
        await refreshInstances();
        setupEventListeners();
        setupLaunchListeners();
        hideProgressBar();
        
        // Get App Version
        appVersion = await window.electron.getAppVersion();
        const verSpan = getElem('app-version');
        if(verSpan) verSpan.textContent = verSpan.textContent + " " + appVersion;
        
        checkVersionAndTour();
    } catch (error) { console.error('Init error:', error); }
});

async function loadSettings() {
    try {
        currentSettings = await window.electron.loadSettings();
        applyTheme(currentSettings.theme);
        const themeRadio = document.querySelector(`input[name="theme"][value="${currentSettings.theme}"]`);
        if(themeRadio) themeRadio.checked = true;
        const closeRadio = document.querySelector(`input[name="close-behavior"][value="${currentSettings.close_behavior}"]`);
        if(closeRadio) closeRadio.checked = true;
        const delayInput = getElem('sync-delay');
        if(delayInput) delayInput.value = currentSettings.sync_delay !== undefined ? currentSettings.sync_delay : 5;
    } catch (e) {
        currentSettings = { theme: 'Dark', close_behavior: 'Stay Open', sync_delay: 5 };
        applyTheme('Dark');
    }
}

function applyTheme(theme) { document.body.className = theme === 'Dark' ? 'dark-theme' : 'light-theme'; }

function setupEventListeners() {
    const checkUpdatesBtn = getElem('check-updates-btn');
    if (checkUpdatesBtn) {
        checkUpdatesBtn.addEventListener('click', async () => {
            const originalText = checkUpdatesBtn.textContent;
            checkUpdatesBtn.textContent = 'Checking...';
            checkUpdatesBtn.disabled = true;
            try { await window.electron.checkForUpdates(); } 
            finally { checkUpdatesBtn.textContent = originalText; checkUpdatesBtn.disabled = false; }
        });
    }
    
    localVersionSelect.addEventListener('change', loadVersionDefaults);
    
    instanceList.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (row) selectInstance(row.dataset.name);
    });
    launchBtn.addEventListener('click', launchInstance);
    createBtn.addEventListener('click', () => openInstanceModal(false));
    editBtn.addEventListener('click', () => openInstanceModal(true));
    deleteBtn.addEventListener('click', deleteInstance);
    settingsBtn.addEventListener('click', openSettingsModal);
    downloadBtn.addEventListener('click', openDownloadsModal);
    if(editorBtn) editorBtn.addEventListener('click', openEditorModal);
    
    // Add in setupEventListeners()
    if (notificationClose) {
        notificationClose.addEventListener('click', hideNotification);
    }
    
    document.querySelectorAll('input[name="version-type"]').forEach(radio => radio.addEventListener('change', updateVersionTypeUI));
    getElem('browse-btn').addEventListener('click', browseForExe);
    getElem('save-instance-btn').addEventListener('click', saveInstance);
    getElem('cancel-instance-btn').addEventListener('click', () => instanceModal.classList.remove('active'));
    instanceModal.addEventListener('click', (e) => { if (e.target.id === 'instance-modal') instanceModal.classList.remove('active'); });
    
    if(btnOpenInEditor) btnOpenInEditor.addEventListener('click', openInstanceInEditor);

    getElem('save-settings-btn').addEventListener('click', saveSettings);
    settingsModal.addEventListener('click', (e) => { if (e.target.id === 'settings-modal') settingsModal.classList.remove('active'); });
    getElem('open-data-folder-btn').addEventListener('click', () => window.electron.openDataFolder());

    getElem('close-downloads-btn').addEventListener('click', () => downloadsModal.classList.remove('active'));
    downloadsModal.addEventListener('click', (e) => { if (e.target.id === 'downloads-modal') downloadsModal.classList.remove('active'); });
    
    // Editor listeners
    if (editorModal) {
        getElem('close-editor-btn').addEventListener('click', () => editorModal.classList.remove('active'));
        editorInstanceSelect.addEventListener('change', initEditorSession);
        
        getElem('btn-export-txt').addEventListener('click', () => doExport('txt'));
        getElem('btn-export-gmd').addEventListener('click', () => doExport('gmd'));
        getElem('btn-import-replace').addEventListener('click', () => doImport(editorSelectedKey));
        getElem('btn-import-new').addEventListener('click', () => doImport('new'));
        
        getElem('btn-save-level').addEventListener('click', () => saveSession(false));
        getElem('btn-save-exit').addEventListener('click', () => saveSession(true));
        getElem('btn-edit-raw').addEventListener('click', openCodeEditor);
        
        if(btnRenameLevel) btnRenameLevel.addEventListener('click', openRenameModal);
        getElem('btn-edit-desc').addEventListener('click', openDescModal);
        getElem('editor-is-custom').addEventListener('change', toggleSongType);
        getElem('btn-apply-song').addEventListener('click', applySongChange);
        getElem('editor-star-request').addEventListener('change', applyStarRequest);
        
        getElem('rename-cancel-btn').addEventListener('click', () => getElem('rename-modal').classList.remove('active'));
        getElem('rename-confirm-btn').addEventListener('click', confirmRename);
        
        getElem('desc-cancel-btn').addEventListener('click', () => getElem('desc-modal').classList.remove('active'));
        getElem('desc-confirm-btn').addEventListener('click', confirmDesc);
        
        getElem('btn-code-cancel').addEventListener('click', () => codeModal.classList.remove('active'));
        getElem('btn-code-save').addEventListener('click', saveCodeEditor);
    }

    if(getElem('close-changelog-btn')) {
        getElem('close-changelog-btn').addEventListener('click', () => changelogModal.classList.remove('active'));
    }
    if(getElem('tour-next-btn')) {
        getElem('tour-next-btn').addEventListener('click', nextTourStep);
        getElem('tour-skip-btn').addEventListener('click', endTour);
    }
}

function setupLaunchListeners() {
    window.electron.onLaunchStatus((message) => { statusLabel.textContent = message; });
    window.electron.onLaunchComplete(() => {
        isGameRunning = false;
        setUIState(false);
        hideProgressBar();
        refreshInstances();
    });
    window.electron.onDownloadProgress((data) => {
        const card = document.querySelector(`.version-card[data-id="${data.id}"]`);
        if (!card) return;
        
        const progressBar = card.querySelector('.version-progress-bar');
        if (progressBar && data.percentage) {
            progressBar.style.width = `${data.percentage}%`;
        }
        
        const btn = card.querySelector('.version-btn');
        if (btn && data.status) {
            const isRepair = btn.classList.contains('repair');
            btn.textContent = isRepair ? `🔧 ${data.status}` : `⬇️ ${data.status}`;
        }
    });

    window.electron.onDownloadComplete((data) => {
        const card = document.querySelector(`.version-card[data-id="${data.id}"]`);
        if (!card) return;
        
        if (data.success) {
            showNotification('Download complete!', 'success');
            setTimeout(() => openDownloadsModal(), 500); // Refresh to show new state
        } else {
            const progress = card.querySelector('.version-progress');
            if(progress) progress.remove();
            
            const actionsDiv = card.querySelector('.version-actions');
            actionsDiv.innerHTML = '<button class="version-btn download" onclick="handleDownloadVersion(...)">⬇️ Retry</button>';
            
            showNotification('Download failed', 'error');
        }
    });
    window.electron.onUpdateProgressStart(() => { showProgressBar(); setProgressBar(0); });
    window.electron.onUpdateProgress((percentage) => setProgressBar(percentage));
    window.electron.onUpdateProgressComplete(() => { setProgressBar(100); setTimeout(hideProgressBar, 2000); });
}

function showProgressBar() { if (progressContainer) { progressContainer.style.visibility = 'visible'; progressContainer.style.opacity = '1'; } }
function hideProgressBar() { if (progressBar) progressBar.style.width = '0%'; if (progressContainer) { progressContainer.style.visibility = 'visible'; progressContainer.style.opacity = '1'; } }
function setProgressBar(percentage) { if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`; }
function formatSize(bytes) { if(bytes == 0) return '0 B'; const s = ['B','KB','MB','GB']; let i = 0; while(bytes >= 1024) { bytes /= 1024; i++; } return `${bytes.toFixed(2)} ${s[i]}`; }

async function refreshInstances() { try { instances = await window.electron.getInstances(); renderInstances(); } catch (e) { console.error(e); } }
function renderInstances() {
    const tbody = instanceList;
    tbody.innerHTML = '';
    if (instances.length === 0) { tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 20px;">No instances.</td></tr>'; updateButtonStates(); return; }
    instances.forEach(inst => {
        const row = document.createElement('tr');
        row.dataset.name = inst.name;
        if (selectedInstance === inst.name) row.classList.add('selected');
        row.innerHTML = `<td>${inst.name}</td><td>${formatSize(inst.size)}</td><td>${inst.version}</td>`;
        tbody.appendChild(row);
    });
    updateButtonStates();
}
function selectInstance(name) { selectedInstance = name; renderInstances(); }
function updateButtonStates() {
    const sel = selectedInstance !== null && instances.length > 0;
    launchBtn.disabled = !sel || isGameRunning;
    editBtn.disabled = !sel || isGameRunning;
    deleteBtn.disabled = !sel || isGameRunning;
}
function setUIState(launching) { isGameRunning = launching; [launchBtn, createBtn, editBtn, deleteBtn, settingsBtn, downloadBtn, editorBtn].forEach(b => { if(b) b.disabled = launching }); updateButtonStates(); }

async function launchInstance() {
    if (!selectedInstance) return;
    setUIState(true); showProgressBar(); setProgressBar(10); statusLabel.textContent = `Preparing ${selectedInstance}...`;
    const res = await window.electron.launchInstance(selectedInstance);
    if (!res.success) { showNotification(`Failed: ${res.error}`, 'error'); setUIState(false); hideProgressBar(); statusLabel.textContent = 'Ready'; }
    else { setProgressBar(100); statusLabel.textContent = 'Running...'; setTimeout(hideProgressBar, 1500); }
}

async function openInstanceModal(edit) {
    isEditMode = edit; 
    modalTitle.textContent = edit ? 'Edit' : 'Create';
    const vers = await window.electron.getVersions();
    localVersionSelect.innerHTML = '<option value="">Select...</option>' + vers.map(v => `<option value="${v}">${v}</option>`).join('');
    
    if(editSaveSection) editSaveSection.style.display = edit ? 'block' : 'none';

    if (edit) {
        const inst = instances.find(i => i.name === selectedInstance);
        if(!inst) return;
        editingInstanceName = selectedInstance;
        instanceNameInput.value = inst.name;
        const isLocal = (inst.data.versionType || 'local') === 'local';
        document.querySelector(`input[name="version-type"][value="${isLocal?'local':'custom'}"]`).checked = true;
        if(isLocal) localVersionSelect.value = inst.data.version || ''; 
        else exePathInput.value = inst.data.executablePath || '';
        saveFolderInput.value = inst.data.saveFolderName || '';
        geodeCheckbox.checked = inst.data.isGeodeCompatible || false;
        megahackCheckbox.checked = inst.data.useMegaHack || false;
        steamEmuCheckbox.checked = inst.data.useSteamEmu || false;
        skipRestartCheckbox.checked = inst.data.skipRestartCheck || false;
    } else {
        editingInstanceName = null; 
        instanceNameInput.value = ''; 
        localVersionSelect.value = ''; 
        exePathInput.value = '';
        saveFolderInput.value = 'GeometryDash'; 
        geodeCheckbox.checked = false; 
        megahackCheckbox.checked = false; 
        steamEmuCheckbox.checked = false;
        skipRestartCheckbox.checked = false;
        document.querySelector('input[name="version-type"][value="local"]').checked = true;
    }
    updateVersionTypeUI();
    instanceModal.classList.add('active');
}
function updateVersionTypeUI() {
    const isLocal = document.querySelector('input[name="version-type"]:checked').value === 'local';
    getElem('local-version-section').style.display = isLocal ? 'block' : 'none';
    getElem('custom-exe-section').style.display = isLocal ? 'none' : 'block';
    if(!isEditMode && isLocal) saveFolderInput.value = 'GeometryDash';
}
async function browseForExe() { 
    const f = await window.electron.openFileDialog(); 
    if(f) { 
        getElem('exe-path').value = f; 
        // Extract filename without extension for save folder
        const fileName = f.split(/[\\\/]/).pop(); // Get filename
        const folderName = fileName.replace(/\.[^/.]+$/, ''); // Remove extension
        saveFolderInput.value = folderName;
    } 
}
async function saveInstance() { 
    const name = instanceNameInput.value.trim();
    if (!name) { showNotification('Invalid name.', 'error'); return; }
    const versionType = document.querySelector('input[name="version-type"]:checked').value;
    const data = { 
        name, 
        versionType, 
        saveFolderName: saveFolderInput.value.trim(), 
        isGeodeCompatible: geodeCheckbox.checked, 
        useMegaHack: megahackCheckbox.checked, 
        useSteamEmu: steamEmuCheckbox.checked,
        skipRestartCheck: skipRestartCheckbox.checked
    };
    if (versionType === 'local') {
        if (!localVersionSelect.value) { showNotification('Select version.', 'error'); return; }
        data.version = localVersionSelect.value; data.executablePath = null;
    } else {
        if (!exePathInput.value) { showNotification('Select executable.', 'error'); return; }
        data.executablePath = exePathInput.value; data.version = null;
    }
    const result = isEditMode ? await window.electron.editInstance(editingInstanceName, data) : await window.electron.createInstance(data);
    if (result.success) { instanceModal.classList.remove('active'); selectedInstance = data.name; await refreshInstances(); } 
    else { showNotification(`Failed: ${result.error}`, 'error'); }
}
async function deleteInstance() { 
    if(selectedInstance && confirm(`Are you sure you want to move '${selectedInstance}' to Trash?`)) { 
        const result = await window.electron.deleteInstance(selectedInstance); 
        if (result && result.success) {
            showNotification('Instance moved to trash', 'success');
            selectedInstance = null; 
            refreshInstances(); 
        } else {
            showNotification(`Failed to delete: ${result && result.error ? result.error : 'Unknown error'}`, 'error');
        }
    } 
}
async function openSettingsModal() { settingsModal.classList.add('active'); }
async function saveSettings() {
    const theme = document.querySelector('input[name="theme"]:checked').value;
    const closeBehavior = document.querySelector('input[name="close-behavior"]:checked').value;
    let syncDelay = parseInt(getElem('sync-delay').value);
    if(isNaN(syncDelay)) syncDelay = 5;
    currentSettings = { theme, close_behavior: closeBehavior, sync_delay: syncDelay, last_run_version: appVersion };
    applyTheme(theme);
    await window.electron.saveSettings(currentSettings);
    settingsModal.classList.remove('active');
}

async function openDownloadsModal() { 
    downloadsModal.classList.add('active');
    
    getElem('version-stats').innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 20px;">Loading...</div>';
    getElem('download-list').innerHTML = '<div class="downloads-empty"><div class="downloads-empty-icon">⏳</div><p>Loading...</p></div>';
    
    try {
        // FAST: Show versions with "Calculating..." immediately
        const vs = await window.electron.fetchRemoteVersions();
        renderDownloadsList(vs);
        
        // BACKGROUND: Calculate all sizes
        const sizeUpdates = await window.electron.calculateAllSizes(vs);
        sizeUpdates.forEach(update => {
            const version = vs.find(v => v.id === update.id);
            if (version) version.size = update.size;
        });
        renderDownloadsList(vs); // Re-render with real sizes
        
        // Search functionality
        const searchInput = getElem('version-search');
        if(searchInput) {
            searchInput.oninput = () => {
                const query = searchInput.value.toLowerCase();
                const filtered = vs.filter(v => 
                    v.name.toLowerCase().includes(query) || 
                    v.path.toLowerCase().includes(query)
                );
                renderDownloadsList(filtered);
            };
        }
    } catch(e) { 
        getElem('download-list').innerHTML = '<div class="downloads-empty"><div class="downloads-empty-icon">⚠️</div><p>Error fetching versions</p></div>'; 
        showNotification('Error fetching versions.', 'error'); 
    }
}

function renderDownloadsList(versions) {
    console.log('=== RENDER DOWNLOADS LIST ===');
    console.log('Total versions:', versions.length);
    console.log('First version example:', versions[0]);
    
    const statsEl = getElem('version-stats');
    const listEl = getElem('download-list');
    
    // Calculate stats
    const installed = versions.filter(v => v.isInstalled).length;
    const available = versions.length - installed;
    const totalSize = versions.filter(v => v.isInstalled).reduce((acc, v) => {
        console.log('Processing version:', v.name, 'Size:', v.size, 'Installed:', v.isInstalled);
        if (!v.size) {
            console.log('  → No size property found');
            return acc;
        }
        // Extract number from strings like "145 MB", "1.2 GB", etc.
        const match = v.size.match(/(\d+(\.\d+)?)\s*(MB|GB)?/i);
        if (!match) {
            console.log('  → Size format not recognized:', v.size);
            return acc;
        }
        let size = parseFloat(match[1]);
        console.log('  → Parsed size:', size, match[3] || 'MB');
        // Convert GB to MB if needed
        if (match[3] && match[3].toUpperCase() === 'GB') size *= 1024;
        console.log('  → Final size (MB):', size);
        return acc + size;
    }, 0);
    console.log('TOTAL SIZE CALCULATED:', totalSize, 'MB');
    // Render stats
    statsEl.innerHTML = `
        <div class="stat-card">
            <div class="stat-icon blue">📦</div>
            <div class="stat-info">
                <div class="stat-label">Installed</div>
                <div class="stat-value">${installed}</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon purple">💾</div>
            <div class="stat-info">
                <div class="stat-label">Total Size</div>
                <div class="stat-value">${totalSize.toFixed(0)} MB</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon green">⬇️</div>
            <div class="stat-info">
                <div class="stat-label">Available</div>
                <div class="stat-value">${available}</div>
            </div>
        </div>
    `;
    
    // Render version cards
    if(versions.length === 0) {
        listEl.innerHTML = '<div class="downloads-empty"><div class="downloads-empty-icon">📭</div><p>No versions available</p></div>';
        return;
    }
    
    listEl.innerHTML = versions.map(v => {
        const downloading = document.querySelector(`.version-card[data-id="${v.id}"]`)?.querySelector('.version-progress');
        const progressHTML = downloading ? downloading.outerHTML : '';
        
        return `
            <div class="version-card ${v.isInstalled ? 'installed' : ''}" data-id="${v.id}">
                <div class="version-card-header">
                    <div class="version-info">
                        <h3>${v.name}</h3>
                        <div class="version-number">${v.path || 'N/A'}</div>
                    </div>
                    <span class="version-status-badge ${v.isInstalled ? 'status-installed' : 'status-available'}">
                        ${v.isInstalled ? '✓ Installed' : 'Available'}
                    </span>
                </div>
                
                <div class="version-meta">
                    <div class="version-meta-item">
                        <span>💾</span>
                        <span>${v.size || 'Size unknown'}</span>
                    </div>
                </div>
                
                ${progressHTML}
                
                <div class="version-actions">
                    ${v.isInstalled ? `
                        <button class="version-btn repair" onclick="handleRepairVersion('${v.id}', ${JSON.stringify(v).replace(/"/g, '&quot;')})">
                            🔧 Repair
                        </button>
                        <button class="version-btn delete" onclick="handleDeleteVersion('${v.path}', '${v.id}')">
                            🗑️ Delete
                        </button>
                        <button class="version-btn folder" onclick="handleOpenVersionFolder('${v.path}')" title="Open Folder">
                            📁
                        </button>
                    ` : `
                        <button class="version-btn download" onclick="handleDownloadVersion(${JSON.stringify(v).replace(/"/g, '&quot;')})">
                            ⬇️ Download
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');
}

function handleDownloadVersion(version) {
    const card = document.querySelector(`.version-card[data-id="${version.id}"]`);
    const actionsDiv = card.querySelector('.version-actions');
    
    // Add progress bar
    actionsDiv.insertAdjacentHTML('beforebegin', `
        <div class="version-progress">
            <div class="version-progress-bar" style="width: 0%"></div>
        </div>
    `);
    
    actionsDiv.innerHTML = '<button class="version-btn download" disabled>⏳ Downloading...</button>';
    
    window.electron.downloadVersion(version);
}

function handleRepairVersion(id, version) {
    if(!confirm(`Repair ${version.name}?\n\nThis will re-download and overwrite existing files.`)) return;
    
    const card = document.querySelector(`.version-card[data-id="${id}"]`);
    const actionsDiv = card.querySelector('.version-actions');
    
    actionsDiv.insertAdjacentHTML('beforebegin', `
        <div class="version-progress">
            <div class="version-progress-bar" style="width: 0%"></div>
        </div>
    `);
    
    actionsDiv.innerHTML = '<button class="version-btn repair" disabled>🔧 Repairing...</button>';
    
    window.electron.repairVersion(version);
}

async function handleDeleteVersion(versionPath, id) {
    if(!confirm(`Delete this version?\n\nPath: ${versionPath}\n\nThis will move it to trash.`)) return;
    
    const result = await window.electron.deleteVersion(versionPath);
    if(result.success) {
        showNotification('Version moved to trash', 'success');
        openDownloadsModal(); // Refresh
    } else {
        showNotification('Failed to delete: ' + result.error, 'error');
    }
}

async function handleOpenVersionFolder(versionPath) {
    await window.electron.openVersionFolder(versionPath);
}

// --- EDITOR LOGIC ---

async function openEditorModal() {
    editorModal.classList.add('active');
    editorInstanceSelect.innerHTML = '<option value="">Select Instance...</option>';
    instances.forEach(inst => {
        const opt = document.createElement('option');
        opt.value = inst.name;
        opt.textContent = inst.name;
        editorInstanceSelect.appendChild(opt);
    });
    // Fix: Clean on open
    editorLevelsList.innerHTML = '<div style="padding:10px;">Please select an instance.</div>';
    editorActions.style.display = 'none';
    if(btnEditRaw) btnEditRaw.disabled = true;
    if(btnImportNew) btnImportNew.disabled = true;
}

async function loadVersionDefaults() {
    if (isEditMode) return; // Don't override when editing
    
    const selectedVersion = localVersionSelect.value;
    if (!selectedVersion) return;
    
    const defaults = await window.electron.getVersionDefaults(selectedVersion);
    if (defaults) {
        geodeCheckbox.checked = defaults.geode_compatible || false;
        megahackCheckbox.checked = defaults.use_megahack || false;
        steamEmuCheckbox.checked = defaults.use_steam_emu || false;
        skipRestartCheckbox.checked = defaults.skip_restart_check || false;
        
        // Set save folder name from executable name
        if (defaults.executable) {
            const folderName = defaults.executable.replace(/\.[^/.]+$/, ''); // Remove .exe
            saveFolderInput.value = folderName;
        }
    }
}

async function openInstanceInEditor() {
    if (!editingInstanceName) return;
    instanceModal.classList.remove('active');
    await openEditorModal();
    editorInstanceSelect.value = editingInstanceName;
    await initEditorSession();
}

async function initEditorSession() {
    const name = editorInstanceSelect.value;
    editorLevelsList.innerHTML = '<div style="padding:10px;">Loading session...</div>';
    editorActions.style.display = 'none';

    if (!name) { 
        editorLevelsList.innerHTML = '<div style="padding:10px;">Please select an instance.</div>';
        if(btnEditRaw) btnEditRaw.disabled = true; 
        if(btnImportNew) btnImportNew.disabled = true;
        return; 
    }
    const res = await window.electron.editorInitSession(name);
    if (!res.success) { 
        editorLevelsList.innerHTML = `<div style="padding:10px; color:red;">${res.error}</div>`; 
        if(btnEditRaw) btnEditRaw.disabled = true; 
        if(btnImportNew) btnImportNew.disabled = true;
        return; 
    }
    if(btnEditRaw) btnEditRaw.disabled = false;
    if(btnImportNew) btnImportNew.disabled = false;
    loadEditorLevels();
}

async function loadEditorLevels() {
    const result = await window.electron.editorGetLevels();
    if (!result.success) { editorLevelsList.innerHTML = `<div style="padding:10px; color:red;">${result.error}</div>`; return; }
    editorLevelsList.innerHTML = '';
    if (result.levels.length === 0) editorLevelsList.innerHTML = '<div>No levels found.</div>';
    result.levels.forEach(lvl => {
        const div = document.createElement('div');
        div.className = 'level-item';
        div.textContent = lvl.name;
        div.onclick = () => selectEditorLevel(div, lvl);
        editorLevelsList.appendChild(div);
    });
}

function selectEditorLevel(el, lvl) {
    document.querySelectorAll('.level-item').forEach(d => d.classList.remove('active'));
    el.classList.add('active');
    editorSelectedKey = lvl.key;
    
    if(editorLevelNameInput) editorLevelNameInput.value = lvl.name;
    getElem('editor-level-desc').value = lvl.description ? atob(lvl.description) : '';
    
    const isCustom = lvl.isCustomSong;
    getElem('editor-is-custom').checked = isCustom;
    
    if (isCustom) {
        getElem('custom-song-section').style.display = 'block';
        getElem('official-song-section').style.display = 'none';
        getElem('editor-custom-song-id').value = lvl.songId;
    } else {
        getElem('custom-song-section').style.display = 'none';
        getElem('official-song-section').style.display = 'block';
        getElem('editor-song-select').value = lvl.songId;
    }
    
    getElem('editor-star-request').value = lvl.starRequest || 0;
    editorActions.style.display = 'block'; 
}

function toggleSongType() {
    const isCustom = getElem('editor-is-custom').checked;
    if (isCustom) {
        getElem('custom-song-section').style.display = 'block';
        getElem('official-song-section').style.display = 'none';
    } else {
        getElem('custom-song-section').style.display = 'none';
        getElem('official-song-section').style.display = 'block';
    }
}

async function applySongChange() {
    if (!editorSelectedKey) return;
    
    const isCustom = getElem('editor-is-custom').checked;
    let songId;
    
    if (isCustom) {
        songId = parseInt(getElem('editor-custom-song-id').value);
        if (!songId || songId < 1 || songId > 99999999) {
            showNotification('Please enter a valid Newgrounds song ID (1-99999999)', 'error');
            return;
        }
    } else {
        songId = parseInt(getElem('editor-song-select').value);
    }
    
    const res = await window.electron.editorUpdateSong(editorSelectedKey, { id: songId, isCustom });
    if (res.success) {
        showNotification('Song updated! Click Save to commit changes.', 'success');
        await loadEditorLevels();
    } else {
        showNotification('Failed to update song.', 'error');
    }
}

async function applyStarRequest() {
    if (!editorSelectedKey) return;
    const stars = parseInt(getElem('editor-star-request').value);
    const res = await window.electron.editorUpdateStarRequest(editorSelectedKey, stars);
    if (res.success) {
        statusLabel.textContent = 'Star request updated (Save to commit)';
    }
}

function openRenameModal() {
    if (!editorSelectedKey) return;
    getElem('rename-input').value = editorLevelNameInput.value;
    getElem('rename-modal').classList.add('active');
}

async function confirmRename() {
    const newName = getElem('rename-input').value.trim();
    if (!newName) {
        showNotification("Name cannot be empty.", 'error');
        return;
    }
    
    const res = await window.electron.editorRenameLevel(editorSelectedKey, newName);
    if (res.success) {
        getElem('rename-modal').classList.remove('active');
        await loadEditorLevels();
        showNotification('Level renamed! Click Save to commit changes.', 'success');
    } else {
        showNotification("Rename failed.", 'error');
    }
}

function openDescModal() {
    if (!editorSelectedKey) return;
    getElem('desc-input').value = getElem('editor-level-desc').value;
    getElem('desc-modal').classList.add('active');
}

async function confirmDesc() {
    const newDesc = getElem('desc-input').value.trim();
    if (newDesc.length > 140) {
        showNotification("Description is too long (max 140 characters).", 'error');
        return;
    }
    
    const encoded = btoa(newDesc);
    const res = await window.electron.editorUpdateDescription(editorSelectedKey, encoded);
    if (res.success) {
        getElem('desc-modal').classList.remove('active');
        getElem('editor-level-desc').value = newDesc;
        showNotification('Description updated! Click Save to commit changes.', 'success');
    } else {
        showNotification("Update failed.", 'error');
    }
}


async function doImport(key) {
    const inst = editorInstanceSelect.value;
    if (!inst) return;
    statusLabel.textContent = 'Importing...';
    const res = await window.electron.editorImportLevel(key);
    statusLabel.textContent = 'Ready';
    if (res.success) { showNotification('Imported to session! (Click Save to commit)', 'success'); loadEditorLevels(); }
    else { showNotification('Failed: ' + res.error, 'error'); }
}
async function doExport(fmt) {
    if (!editorSelectedKey) return;
    const res = await window.electron.editorExportLevel(editorSelectedKey, fmt);
    if (res.success) showNotification('Exported!', 'success'); else if (res.error !== 'Cancelled') showNotification(res.error, 'error');
}
async function saveSession(closeAfter) {
    const res = await window.electron.editorPersist();
    if (res.success) { showNotification('Session saved to disk!', 'success'); if (closeAfter) editorModal.classList.remove('active'); } 
    else showNotification('Save Failed: ' + res.error, 'error');
}
async function openCodeEditor() {
    codeModal.classList.add('active');
    const res = await window.electron.editorGetXml();
    if (!res.success) { showNotification(res.error, 'error'); codeModal.classList.remove('active'); return; }
    if (!monacoEditor) {
        require(['vs/editor/editor.main'], function () {
            monacoEditor = monaco.editor.create(document.getElementById('code-editor-container'), {
                value: res.data,
                language: 'xml',
                theme: 'vs-dark',
                automaticLayout: true
            });
        });
    } else {
        monacoEditor.setValue(res.data);
    }
}
async function saveCodeEditor() {
    if (!monacoEditor) return;
    const newData = monacoEditor.getValue();
    const res = await window.electron.editorSaveXml(newData);
    if (res.success) { showNotification('XML updated in session! (Click Save in main window to commit to disk)', 'success'); codeModal.classList.remove('active'); loadEditorLevels(); } 
    else { showNotification('Failed to parse XML: ' + res.error, 'error'); }
}

// --- TOUR & CHANGELOG LOGIC ---
async function checkVersionAndTour() {
    const lastVersion = currentSettings.last_run_version;
    
    if (!lastVersion) {
        pendingChangelog = true; // Flag to show changelog after tour
        currentSettings.last_run_version = appVersion;
        await window.electron.saveSettings(currentSettings);
        startTour();
        return;
    }

    if (lastVersion !== appVersion) {
        currentSettings.last_run_version = appVersion;
        await window.electron.saveSettings(currentSettings);
        showChangelog();
    }
}

function showChangelog() {
    getElem('changelog-version').textContent = `v${appVersion}`;
    getElem('changelog-text').innerHTML = LATEST_CHANGELOG;
    changelogModal.classList.add('active');
}

const tourSteps = [
    {
        title: 'Welcome!',
        desc: 'Welcome to the Instance Manager. Let\'s get you set up.',
        elementId: 'app-title'
    },
    {
        isAction: true, 
        skipCounter: true,
        action: async () => {
            const result = await window.electron.handleFirstRunImport();
            if (result && result.foundFiles) {
                await refreshInstances();
            }
        }
    },
    { elementId: 'create-btn', title: 'Create Instances', desc: 'Start here! Create separated profiles for different mods, texture packs, or GD versions.' },
    { elementId: 'instance-list', title: 'Your Library', desc: 'All your instances appear here. Click one to select it.' },
    { elementId: 'launch-btn', title: 'Launch Game', desc: 'Click Launch to swap the save files and start Geometry Dash. The launcher will sync your data when you close the game.' },
    { elementId: 'editor-btn', title: 'Save Editor', desc: 'Advanced users can edit song IDs, rename levels, or fix save data without opening the game.' }
];

function startTour() {
    tourCurrentStep = 0;
    tourOverlay.classList.add('active');
    showTourStep();
}


async function showTourStep() {
    document.querySelectorAll('.tour-highlight').forEach(el => el.classList.remove('tour-highlight'));
    const step = tourSteps[tourCurrentStep];
    
    // ACTION STEPS
    if (step.isAction) {
        // Show loading message instead of hiding completely
        tourTooltip.style.display = 'block';
        tourTooltip.style.visibility = 'visible';
        tourTooltip.style.opacity = '1';
        
        // Center the tooltip
        const tooltipWidth = 320;
        const tooltipHeight = 200;
        tourTooltip.style.left = `${(window.innerWidth / 2) - (tooltipWidth / 2)}px`;
        tourTooltip.style.top = `${(window.innerHeight / 2) - (tooltipHeight / 2)}px`;
        
        getElem('tour-title').textContent = 'Checking for Save Data...';
        getElem('tour-desc').textContent = 'Looking for existing Geometry Dash files...';
        getElem('tour-counter').textContent = '';
        getElem('tour-next-btn').style.display = 'none';
        getElem('tour-skip-btn').style.display = 'none';
        
        // Run the action
        if(step.action) await step.action();
        
        // Restore buttons
        getElem('tour-next-btn').style.display = 'inline-block';
        getElem('tour-skip-btn').style.display = 'inline-block';
        
        nextTourStep(); 
        return;
    }

    // Ensure tooltip is visible at the start of non-action steps
    tourTooltip.style.display = 'block';
    tourTooltip.style.visibility = 'visible';
    tourTooltip.style.opacity = '1';
    
    let el = getElem(step.elementId);
    
    // Fallback if ID not found (e.g. app-title)
    if (!el && step.elementId === 'app-title') el = document.body;
    if (!el) { 
        console.error('Tour element not found:', step.elementId);
        nextTourStep(); 
        return; 
    }

    if(step.elementId !== 'app-title') el.classList.add('tour-highlight');
    
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 320;
    const tooltipHeight = 200; 
    let left = rect.right + 15;
    let top = rect.top;

    if (step.elementId === 'app-title' || el === document.body) {
         left = (window.innerWidth / 2) - (tooltipWidth / 2);
         top = (window.innerHeight / 2) - (tooltipHeight / 2);
    } else {
        const fitsRight = (left + tooltipWidth) < window.innerWidth;
        const fitsLeft = (rect.left - tooltipWidth - 15) > 0;
        if (!fitsRight) {
            if (fitsLeft) { left = rect.left - tooltipWidth - 15; } 
            else { left = rect.left + (rect.width / 2) - (tooltipWidth / 2); top = rect.top + (rect.height / 2) - (tooltipHeight / 2); }
        }
    }
    
    if (top + tooltipHeight > window.innerHeight) top = window.innerHeight - tooltipHeight - 20;
    if (top < 10) top = 10;
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth) left = window.innerWidth - tooltipWidth - 10;

    tourTooltip.style.top = `${top}px`;
    tourTooltip.style.left = `${left}px`;
    getElem('tour-title').textContent = step.title;
    getElem('tour-desc').textContent = step.desc;
    
    // Calculate visible step numbers (excluding action steps)
    const visibleSteps = tourSteps.filter(s => !s.skipCounter);
    const currentVisibleIndex = tourSteps.slice(0, tourCurrentStep + 1).filter(s => !s.skipCounter).length;
    getElem('tour-counter').textContent = `${currentVisibleIndex}/${visibleSteps.length}`;
    
    getElem('tour-next-btn').textContent = (tourCurrentStep === tourSteps.length - 1) ? 'Finish' : 'Next';
}

function nextTourStep() {
    tourCurrentStep++;
    if (tourCurrentStep >= tourSteps.length) endTour();
    else showTourStep();
}

function endTour() {
    document.querySelectorAll('.tour-highlight').forEach(el => el.classList.remove('tour-highlight'));
    tourOverlay.classList.remove('active');
    tourTooltip.style.display = 'none';
    if(pendingChangelog) {
        pendingChangelog = false;
        showChangelog();
    }
}
