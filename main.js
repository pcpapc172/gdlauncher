const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { spawn, execSync } = require('child_process');
const os = require('os');
const axios = require('axios');
const decompress = require('decompress');
const decompressUnzip = require('decompress-unzip');
const psList = require('ps-list');
const semver = require('semver');
const EasyDl = require('easydl');
const editor = require('./editor'); // Ensure you have this file

let mainWindow;
let isGameRunning = false;
let gameProcessMonitor = null;
let gameProcess = null;
let isSyncing = false;

// --- CONSTANTS ---
let BASE_DIR, INSTANCES_DIR, TRASH_DIR, VERSIONS_DIR, BACKUPS_DIR, SETTINGS_FILE;
const isLinux = process.platform === 'linux';

const DEFAULT_SETTINGS = { 
    theme: 'Dark', 
    close_behavior: 'Stay Open', 
    sync_delay: 5, 
    last_run_version: null 
};

// --- APP LIFECYCLE ---
app.whenReady().then(async () => {
    BASE_DIR = app.getPath('userData');
    INSTANCES_DIR = path.join(BASE_DIR, 'Instances');
    TRASH_DIR = path.join(BASE_DIR, 'Trash');
    VERSIONS_DIR = path.join(BASE_DIR, 'Versions');
    BACKUPS_DIR = path.join(BASE_DIR, 'Backups'); // --- FIX: Defined Backup Dir
    SETTINGS_FILE = path.join(BASE_DIR, 'launcher_settings.json');

    await fs.mkdir(INSTANCES_DIR, { recursive: true });
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.mkdir(TRASH_DIR, { recursive: true });
    await fs.mkdir(BACKUPS_DIR, { recursive: true }); // --- FIX: Create Backup Dir
    
    setupIpcHandlers();
    createWindow();
    
    setTimeout(checkForUpdates, 3000);
    
    app.on('activate', () => { 
        if (BrowserWindow.getAllWindows().length === 0) createWindow(); 
    });
});

app.on('window-all-closed', () => { 
    if (gameProcessMonitor) clearInterval(gameProcessMonitor); 
    if (process.platform !== 'darwin') app.quit(); 
});

// --- IPC HANDLERS ---
function setupIpcHandlers() {
    // Editor
    ipcMain.handle('editor-update-description', (e, k, d) => editor.updateDescription(k, d));
    ipcMain.handle('editor-update-star-request', (e, k, s) => editor.updateStarRequest(k, s));
    ipcMain.handle('editor-update-song', (e, k, data) => editor.setSong(k, data));
    ipcMain.handle('editor-init-session', (e, i) => editor.initSession(INSTANCES_DIR, i));
    ipcMain.handle('editor-persist', () => editor.persist(INSTANCES_DIR));
    ipcMain.handle('editor-get-levels', () => editor.getLevels());
    ipcMain.handle('editor-get-raw', (e, i, k) => editor.getRaw(k));
    ipcMain.handle('editor-save-all', (e, i, k, u) => editor.saveAll(k, u));
    ipcMain.handle('editor-import-level', (e, k) => editor.importLevel(mainWindow, k));
    ipcMain.handle('editor-set-song', (e, k, id, c) => editor.setSong(k, id, c));
    ipcMain.handle('editor-export-level', (e, k, f) => editor.exportLevel(mainWindow, k, f));
    ipcMain.handle('editor-get-xml', () => editor.getXml());
    ipcMain.handle('editor-save-xml', (e, x) => editor.saveXml(x));
    ipcMain.handle('editor-rename-level', (e, k, n) => editor.renameLevel(k, n));

    // Settings & Data
    ipcMain.handle('load-settings', async () => loadSettingsInternal());
    ipcMain.handle('save-settings', async (event, settings) => { try { await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 4)); return true; } catch (error) { return false; } });
    ipcMain.handle('get-instances', async () => getInstances());
    ipcMain.handle('create-instance', async (event, data) => createInstance(data));
    ipcMain.handle('edit-instance', async (event, originalName, data) => editInstance(originalName, data));
    ipcMain.handle('delete-instance', async (event, name) => deleteInstance(name));
    
    // Versions
    ipcMain.handle('get-versions', async () => getVersions());
    ipcMain.handle('get-versions-with-sizes', async () => getVersionsWithSizes());
    ipcMain.handle('fetch-remote-versions', async () => fetchRemoteVersions());
    ipcMain.handle('calculate-all-sizes', async (e, versions) => calculateAllVersionSizes(versions));
    ipcMain.on('download-version', async (event, version) => downloadVersion(version));
    ipcMain.on('repair-version', async (event, version) => downloadVersion(version)); // Same as download, will overwrite
    ipcMain.handle('delete-version', async (event, versionPath) => {
        try {
            const fullPath = path.join(VERSIONS_DIR, versionPath);
            await moveToTrash(fullPath, `Version_${versionPath.replace(/\//g, '_')}`);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('open-version-folder', async (event, versionPath) => {
        try {
            const fullPath = path.join(VERSIONS_DIR, versionPath);
            await shell.openPath(fullPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('get-version-defaults', async (event, versionPath) => {
        try {
            const versionJsonPath = path.join(VERSIONS_DIR, versionPath, 'version.json');
            if (await fs.access(versionJsonPath).then(()=>true).catch(()=>false)) {
                const data = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
                return {
                    executable: data.executable || 'GeometryDash.exe',
                    geode_compatible: data.geode_compatible || false,
                    use_megahack: data.use_megahack || false,
                    use_steam_emu: data.use_steam_emu || false,
                    skip_restart_check: data.skip_restart_check || false
                };
            }
            return null;
        } catch (e) {
            return null;
        }
    });
    
    // Launch & Utils
    
    ipcMain.handle('launch-instance', (e, n) => launchInstance(n));
    ipcMain.handle('open-file-dialog', async () => { const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Executables', extensions: ['exe'] }] }); return !canceled && filePaths.length > 0 ? filePaths[0] : null; });
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('check-for-updates', () => checkForUpdates(true)); 
    ipcMain.handle('open-data-folder', () => shell.openPath(BASE_DIR));

    // --- FIX: Tour Import Logic ---
    ipcMain.handle('handle-first-run-import', async () => { 
        // Always check the default GeometryDash folder for unmanaged files
        const localAppDataPath = await getLinuxAppDataPath('GeometryDash'); 
        const infoJsonPath = path.join(localAppDataPath, 'info.json'); 
        
        // This function detects files -> asks user -> moves them -> returns result
        const result = await prepareLocalAppData(localAppDataPath, infoJsonPath, true); 
        return { success: result.success, foundFiles: result.found }; 
    });
}

// --- CORE FUNCTIONS ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (isGameRunning || isSyncing) {
      e.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          'launch-status',
          isSyncing
            ? 'Please wait, syncing is in progress...'
            : 'Game is running; close the game first.'
        );
      }
    }
  });
}


async function getInstances() {
    try { 
        const entries = await fs.readdir(INSTANCES_DIR, { withFileTypes: true }); 
        const instancePromises = entries.map(async (entry) => { 
            if (!entry.isDirectory()) return null; 
            const instancePath = path.join(INSTANCES_DIR, entry.name); 
            const jsonPath = path.join(instancePath, 'instance.json'); 
            try { 
                const jsonData = await fs.readFile(jsonPath, 'utf8'); 
                const data = JSON.parse(jsonData); 
                const managedItems = getManagedItems(data.isGeodeCompatible, data.useMegaHack); 
                let totalSize = 0; 
                for (const item of managedItems) totalSize += await getItemSize(path.join(instancePath, item)); 
                const version = data.versionType === 'local' ? data.version : path.basename(path.dirname(data.executablePath || "")); 
                return { name: entry.name, size: totalSize, version, data }; 
            } catch { return { name: entry.name, size: 0, version: 'Error', data: null }; } 
        }); 
        const instances = (await Promise.all(instancePromises)).filter(Boolean); 
        return instances.sort((a, b) => a.name.localeCompare(b.name)); 
    } catch { return []; }
}

async function createInstance(data) {
    const instancePath = path.join(INSTANCES_DIR, data.name); 
    try { 
        if (await fs.access(instancePath).then(()=>true).catch(()=>false)) throw new Error(`'${data.name}' already exists.`); 
        await fs.mkdir(instancePath, { recursive: true }); 
        const instanceData = { ...data, creationDate: new Date().toISOString() }; 
        await fs.writeFile(path.join(instancePath, 'instance.json'), JSON.stringify(instanceData, null, 4)); 
        await ensureInstanceIntegrity(instancePath, data.isGeodeCompatible, data.useMegaHack); 
        return { success: true }; 
    } catch (error) { return { success: false, error: error.message }; }
}

async function editInstance(originalName, data) {
    const originalPath = path.join(INSTANCES_DIR, originalName); 
    const newPath = path.join(INSTANCES_DIR, data.name); 
    try { 
        const jsonData = await fs.readFile(path.join(originalPath, 'instance.json'), 'utf8'); 
        const existingData = JSON.parse(jsonData); 
        if (originalName !== data.name) { 
            if (await fs.access(newPath).then(()=>true).catch(()=>false)) throw new Error(`'${data.name}' already exists.`); 
            await fs.rename(originalPath, newPath); 
        } 
        const instanceData = { ...data, creationDate: existingData.creationDate }; 
        await fs.writeFile(path.join(newPath, 'instance.json'), JSON.stringify(instanceData, null, 4)); 
        return { success: true }; 
    } catch (error) { return { success: false, error: error.message }; }
}

async function deleteInstance(name) {
    try { 
        await moveToTrash(path.join(INSTANCES_DIR, name), 'Instance_' + name); 
        return { success: true }; 
    } catch (error) { return { success: false, error: error.message }; }
}

async function launchInstance(instanceName) { 
    if (isGameRunning) return { success: false, error: 'A game is already running.' }; 
    const sourcePath = path.join(INSTANCES_DIR, instanceName); 
    
    try { 
        const jsonData = await fs.readFile(path.join(sourcePath, 'instance.json'), 'utf8'); 
        const data = JSON.parse(jsonData); 
        const { saveFolderName, isGeodeCompatible, useMegaHack, useSteamEmu } = data; 
        
        // --- FIX: Backup Logic ---
        mainWindow.webContents.send('launch-status', 'Backing up instance...');
        mainWindow.webContents.send('update-progress-start');
        mainWindow.webContents.send('update-progress', 10);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUPS_DIR, `${instanceName}_${timestamp}`);
        
        // Perform Backup
        await copyDir(sourcePath, backupPath);
        mainWindow.webContents.send('update-progress', 30);
        
        // Linux Check
        if (isLinux) { 
            try { execSync('dpkg -l | grep "libgnutls30.*:i386"', { stdio: 'ignore' }); } 
            catch (e) { return { success: false, error: 'Missing required dependency: libgnutls30:i386. Please install it using apt.' }; } 
        }

        // --- FIX: Read version.json for paths ---
        let exeName = 'GeometryDash.exe';
        let emuName = 'SmartSteamEmu.exe';

        if (data.versionType === 'local') {
            const versionJsonPath = path.join(VERSIONS_DIR, data.version, 'version.json');
            if (await fs.access(versionJsonPath).then(()=>true).catch(()=>false)) {
                try {
                    const verData = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
                    if(verData.executable) exeName = verData.executable;
                    if(verData.steam_emulator) emuName = verData.steam_emulator;
                } catch(e) { console.error("Error reading version.json", e); }
            }
        }
        
        const exePath = data.versionType === 'local' ? path.join(VERSIONS_DIR, data.version, exeName) : data.executablePath;
        const managedItems = getManagedItems(isGeodeCompatible, useMegaHack); 
        const localAppDataPath = await getLinuxAppDataPath(saveFolderName); 
        await fs.mkdir(localAppDataPath, { recursive: true }); 
        const infoJsonPath = path.join(localAppDataPath, 'info.json'); 
        
        // Prepare local app data (check for unmanaged files)
        const prepareResult = await prepareLocalAppData(localAppDataPath, infoJsonPath, false); // false = not tour mode
        if (!prepareResult.success) return { success: false, error: prepareResult.error }; 
        
        await ensureInstanceIntegrity(sourcePath, isGeodeCompatible, useMegaHack);

        mainWindow.webContents.send('launch-status', 'Copying files...'); 
        mainWindow.webContents.send('update-progress', 60);
        await transferManagedItems(sourcePath, localAppDataPath, managedItems, false); 
        await fs.writeFile(infoJsonPath, JSON.stringify({ instanceName }, null, 4)); 
        
        let finalLaunchPath = exePath; 
        if (useSteamEmu) { 
            const emuPath = path.join(path.dirname(exePath), emuName); // Uses emuName from version.json
            if (await fs.access(emuPath).then(()=>true).catch(()=>false)) finalLaunchPath = emuPath; 
            else return { success: false, error: `${emuName} not found.` }; 
        } 
        
        if (!(await fs.access(finalLaunchPath).then(()=>true).catch(()=>false))) return { success: false, error: `Executable not found: ${finalLaunchPath}` }; 
        
        mainWindow.webContents.send('launch-status', `Launching ${instanceName}...`); 
        mainWindow.webContents.send('update-progress', 100);
        isGameRunning = true; 
        
        const command = isLinux ? 'wine' : finalLaunchPath; 
        const args = isLinux ? [finalLaunchPath] : []; 
        const launchEnv = { ...process.env };
        if (isLinux && isGeodeCompatible) { launchEnv['WINEDLLOVERRIDES'] = 'xinput1_4=n,b'; }
        
        gameProcess = spawn(command, args, { detached: false, cwd: path.dirname(finalLaunchPath), env: launchEnv }); 
        const processName = path.basename(exePath); 
        const settings = await loadSettingsInternal();
        
        gameProcess.on('exit', async () => { 
            // If using steam emu, wait a moment then check if game is actually running
            if (useSteamEmu) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                const gameStillRunning = await checkProcessRunning(path.basename(exePath));
                if (gameStillRunning) {
                    // Game is running, start monitoring it
                    mainWindow.webContents.send('launch-status', 'Game running...');
                    gameProcessMonitor = setInterval(async () => { 
                        if (!(await checkProcessRunning(path.basename(exePath)))) { 
                            clearInterval(gameProcessMonitor); 
                            gameProcessMonitor = null; 
                            isGameRunning = false; 
                            await postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings); 
                        } 
                    }, 2000);
                    return;
                }
            }
            
            // Original logic for non-steam-emu or if game didn't start
            const syncDelay = settings.sync_delay || 5;
            const skipRestart = (data.skipRestartCheck === true) || (syncDelay === 0);
            if (skipRestart) { isGameRunning = false; await postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings); return; }
            mainWindow.webContents.send('launch-status', `Process ended. Waiting ${syncDelay}s...`); 
            await new Promise(resolve => setTimeout(resolve, syncDelay * 1000)); 
            const restarted = await checkProcessRunning(path.basename(exePath)); 
            if (restarted) { 
                mainWindow.webContents.send('launch-status', 'Game restarted, continuing to watch...'); 
                gameProcessMonitor = setInterval(async () => { 
                    if (!(await checkProcessRunning(path.basename(exePath)))) { 
                        clearInterval(gameProcessMonitor); 
                        gameProcessMonitor = null; 
                        isGameRunning = false; 
                        await postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings); 
                    } 
                }, 2000); 
            } else { 
                isGameRunning = false; 
                await postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings); 
            } 
        });
        
        gameProcess.on('error', (error) => { isGameRunning = false; mainWindow.webContents.send('launch-status', `Error: ${error.message}`); mainWindow.webContents.send('launch-complete'); }); 
        return { success: true }; 
    } catch (error) { 
        isGameRunning = false; 
        return { success: false, error: error.message }; 
    } 
}

// --- HELPERS ---

async function checkForUpdates(isManual = false) {
    try {
        const response = await axios.get('http://api.pcpapc172.ir/archive/latestlauncher.json', { timeout: 5000 });
        const latest = response.data;
        const currentVersion = app.getVersion();
        if (semver.gt(latest.version, currentVersion)) {
            let updateUrl = isLinux ? latest['url-linux'] : latest['url-win'];
             if (!updateUrl) return;
            const { response } = await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Update Available', message: `A new version (${latest.version}) is available.`, buttons: ['Download And Install', 'Cancel'] });
            if (response === 0) {
                 mainWindow.webContents.send('launch-status', 'Downloading update...');
                 mainWindow.webContents.send('update-progress-start');
                 const downloadPath = path.join(app.getPath('temp'), path.basename(updateUrl));
                 const dl = new EasyDl(updateUrl, downloadPath, { connections: 8, maxRetry: 5 });
                 dl.on('progress', ({ total }) => { if (total.percentage) mainWindow.webContents.send('update-progress', total.percentage); });
                 await dl.wait();
                 mainWindow.webContents.send('update-progress-complete');
                 shell.openPath(downloadPath);
            }
        } else { if (isManual) dialog.showMessageBox(mainWindow, { type: 'info', title: 'No Updates', message: `Latest version (${currentVersion}) installed.`, buttons: ['OK'] }); }
    } catch (error) { if (isManual) dialog.showMessageBox(mainWindow, { type: 'error', title: 'Error', message: error.message, buttons: ['OK'] }); }
}

async function getVersions() {
    try { 
        const versions = []; 
        const entries = await fs.readdir(VERSIONS_DIR, { withFileTypes: true }); 
        for (const entry of entries) { 
            if (!entry.isDirectory()) continue; 
            const subEntries = await fs.readdir(path.join(VERSIONS_DIR, entry.name), { withFileTypes: true }); 
            for (const subEntry of subEntries) { 
                if (!subEntry.isDirectory()) continue; 
                const files = await fs.readdir(path.join(VERSIONS_DIR, entry.name, subEntry.name)); 
                // Only count as valid version if it has exe or version.json
                if (files.some(f => f.endsWith('.exe') || f === 'version.json')) versions.push(`${entry.name}/${subEntry.name}`); 
            } 
        } 
        return [...new Set(versions)].sort(); 
    } catch { return []; } 
}

async function calculateAllVersionSizes(versions) {
    const updates = [];
    
    for (const version of versions) {
        if (version.isInstalled) {
            // Calculate local folder size
            const versionPath = path.join(VERSIONS_DIR, version.path);
            const sizeBytes = await getItemSize(versionPath);
            const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
            updates.push({ id: version.id, size: `${sizeMB} MB` });
            console.log(`Calculated local: ${version.name} = ${sizeMB} MB`);
        } else if (version.url) {
            // Fetch remote size from URL
            try {
                const headResponse = await axios.head(version.url, { timeout: 3000 });
                const sizeBytes = parseInt(headResponse.headers['content-length']);
                if (sizeBytes) {
                    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                    updates.push({ id: version.id, size: `${sizeMB} MB` });
                    console.log(`Fetched remote: ${version.name} = ${sizeMB} MB`);
                } else {
                    updates.push({ id: version.id, size: 'Unknown' });
                }
            } catch (e) {
                console.log(`Could not fetch size for ${version.name}`);
                updates.push({ id: version.id, size: 'Unknown' });
            }
        }
    }
    
    return updates;
}

async function fetchRemoteVersions() {
    try { 
        const response = await axios.get('http://api.pcpapc172.ir/archive/gdversions.json', { timeout: 5000 }); 
        const remoteVersions = response.data;
        console.log('=== FETCHED REMOTE VERSIONS ===');
        console.log('Total versions from API:', remoteVersions.length);
        
        // Quick check: just mark installed status, all sizes = "Calculating..."
        for (const version of remoteVersions) { 
            const versionPath = path.join(VERSIONS_DIR, version.path);
            version.isInstalled = await fs.access(versionPath).then(()=>true).catch(()=>false);
            version.size = 'Calculating...'; // Everything starts as calculating
        } 
        
        return remoteVersions; 
    } catch (error) { 
        console.error('Error fetching versions:', error);
        return []; 
    } 
}

async function downloadVersion(version) {
    const downloadPath = path.join(app.getPath('temp'), path.basename(version.url)); 
    const extractPath = path.join(VERSIONS_DIR, version.path); 
    try { 
        const dl = new EasyDl(version.url, downloadPath, { connections: 10, maxRetry: 5 }); 
        dl.on('progress', ({ total }) => { if (total.percentage) mainWindow.webContents.send('download-progress', { id: version.id, status: `Downloading... ${Math.floor(total.percentage)}%`, percentage: total.percentage }); }); 
        await dl.wait(); 
        mainWindow.webContents.send('download-progress', { id: version.id, status: 'Extracting...', percentage: 100 }); 
        await fs.mkdir(extractPath, { recursive: true }); 
        await decompress(downloadPath, extractPath, { plugins: [decompressUnzip()] }); 
        await fs.unlink(downloadPath); 

        // Only create version.json if it doesn't exist
        const versionJsonPath = path.join(extractPath, 'version.json'); 
        const versionJsonExists = await fs.access(versionJsonPath).then(()=>true).catch(()=>false);

        if (!versionJsonExists) {
            await fs.writeFile(versionJsonPath, JSON.stringify({ 
                executable: 'GeometryDash.exe', 
                steam_emulator: 'SmartSteamEmu.exe' 
            }, null, 4)); 
        }
        
        mainWindow.webContents.send('download-complete', { id: version.id, success: true }); 
    } catch (error) { 
        mainWindow.webContents.send('download-complete', { id: version.id, success: false, message: error.message }); 
    } 
}

// --- FILE SYSTEM HELPERS ---

async function prepareLocalAppData(localPath, infoPath, isTour = false) { 
    const allPossibleItems = getAllManagedItems();
    const foundInAppData = [];
    for (const item of allPossibleItems) {
        if (await fs.access(path.join(localPath, item)).then(()=>true).catch(()=>false)) {
            foundInAppData.push(item);
        }
    }
    
    if (foundInAppData.length === 0) return { success: true, found: false }; 
    
    // Check if we are already managing this (info.json exists)
    if (await fs.access(infoPath).then(()=>true).catch(()=>false)) { 
        if(isTour) return { success: true, found: false }; // If managed, tour doesn't need to do anything
        try { 
            const info = JSON.parse(await fs.readFile(infoPath, 'utf8')); 
            const targetDir = path.join(INSTANCES_DIR, info.instanceName); 
            if (!(await fs.access(path.join(targetDir, 'instance.json')).then(()=>true).catch(()=>false))) { 
                await fs.unlink(infoPath); return { success: true }; 
            } 
            const prevData = JSON.parse(await fs.readFile(path.join(targetDir, 'instance.json'), 'utf8')); 
            await transferManagedItems(await getLinuxAppDataPath(prevData.saveFolderName), targetDir, getManagedItems(prevData.isGeodeCompatible, prevData.useMegaHack), true); 
            await fs.unlink(infoPath); 
            return { success: true, found: true }; 
        } catch (error) { return { success: false, error: `Recovery failed: ${error.message}` }; } 
    } else { 
        // Found UNMANAGED files
        const fileListStr = foundInAppData.join(', ');
        const { response } = await dialog.showMessageBox(mainWindow, { 
            type: 'question', 
            title: 'Unmanaged Save Data Found', 
            message: `The following unmanaged files were found:\n\n${fileListStr}\n\nWhat would you like to do?`, 
            buttons: ['Import as "Imported Instance"', 'Move to Trash', 'Cancel'], 
            defaultId: 0 
        }); 

        if (response === 0) { 
            try {
                const newName = `Imported_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
                const newInstancePath = path.join(INSTANCES_DIR, newName);
                await fs.mkdir(newInstancePath, { recursive: true });
                const instanceData = { name: newName, versionType: 'local', version: '2.2/2.207', saveFolderName: 'GeometryDash', isGeodeCompatible: true, useMegaHack: true, creationDate: new Date().toISOString() };
                await fs.writeFile(path.join(newInstancePath, 'instance.json'), JSON.stringify(instanceData, null, 4));
                await transferManagedItems(localPath, newInstancePath, foundInAppData, true);
                return { success: true, found: true };
            } catch (error) { return { success: false, error: `Import failed: ${error.message}` }; }
        } else if (response === 1) { 
            try { 
                const trashFolder = path.join(TRASH_DIR, `UnmanagedData_${new Date().toISOString().replace(/[:.]/g, '-')}`);
                await fs.mkdir(trashFolder, { recursive: true });
                await transferManagedItems(localPath, trashFolder, foundInAppData, true);
                return { success: true, found: true }; 
            } catch (error) { return { success: false, error: `Could not move to trash: ${error.message}` }; } 
        } else { 
            return { success: false, error: 'Launch cancelled by user.' }; 
        } 
    } 
}

// ... (Keep moveToTrash, getLinuxAppDataPath, checkProcessRunning, loadSettingsInternal same as before)
async function getLinuxAppDataPath(saveFolderName) {
    if (!isLinux) return path.join(process.env.LOCALAPPDATA, saveFolderName);
    const username = os.userInfo().username;
    const wineUserDir = path.join(os.homedir(), '.wine', 'drive_c', 'users', username);
    const candidates = [ path.join(wineUserDir, 'AppData', 'Local', saveFolderName), path.join(wineUserDir, 'Local Settings', 'Application Data', saveFolderName) ];
    for (const candidate of candidates) { try { if (await fs.access(path.join(candidate, 'CCGameManager.dat')).then(() => true).catch(() => false)) return candidate; } catch (e) {} }
    return candidates[0];
}
async function checkProcessRunning(processName) { try { const list = await psList(); return list.some(p => { const nameMatch = p.name.toLowerCase() === processName.toLowerCase(); let cmdMatch = false; if (isLinux && p.cmd) cmdMatch = p.cmd.toLowerCase().includes(processName.toLowerCase()); return nameMatch || cmdMatch; }); } catch (error) { return false; } }
async function moveToTrash(sourcePath, prefix) { const dateStr = new Date().toISOString().replace(/[:.]/g, '-'); const folderName = `${prefix}_${dateStr}`; const trashPath = path.join(TRASH_DIR, folderName); await fs.mkdir(TRASH_DIR, { recursive: true }); if (!(await fs.access(sourcePath).then(() => true).catch(() => false))) return; const stat = await fs.stat(sourcePath); if (stat.isDirectory()) { try { await fs.rename(sourcePath, trashPath); } catch (e) { await copyDir(sourcePath, trashPath); try { await fs.rm(sourcePath, { recursive: true, force: true }); } catch (ign) {} } } else { await fs.mkdir(trashPath, { recursive: true }); try { await fs.rename(sourcePath, path.join(trashPath, path.basename(sourcePath))); } catch (e) { await fs.copyFile(sourcePath, path.join(trashPath, path.basename(sourcePath))); try { await fs.unlink(sourcePath); } catch (ign) {} } } return trashPath; }
async function loadSettingsInternal() { try { const data = await fs.readFile(SETTINGS_FILE, 'utf8'); return { ...DEFAULT_SETTINGS, ...JSON.parse(data) }; } catch { return DEFAULT_SETTINGS; } }
function getAllManagedItems() { return [ "CCGameManager.dat", "CCGameManager2.dat", "CCGameManager.dat.bak", "CCLocalLevels.dat", "CCLocalLevels2.dat", "CCLocalLevels.dat.bak", "geode", "geode-backups", "trashed-levels", "CCBetterInfo.dat", "CCBetterInfo2.dat", "CCBetterInfoCache.dat", "CCBetterInfoCache2.dat", "CCBetterInfoStats.dat", "CCBetterInfoStats2.dat" ]; }
function getManagedItems(isGeode, useMegahack) { const items = ["CCGameManager.dat", "CCGameManager2.dat", "CCGameManager.dat.bak", "CCLocalLevels.dat", "CCLocalLevels2.dat", "CCLocalLevels.dat.bak"]; if (isGeode) items.push('geode', 'geode-backups', 'trashed-levels'); if (useMegahack) items.push('CCBetterInfo.dat', 'CCBetterInfo2.dat', 'CCBetterInfoCache.dat', 'CCBetterInfoCache2.dat', 'CCBetterInfoStats.dat', 'CCBetterInfoStats2.dat'); return items; }
async function getItemSize(itemPath) { try { const stat = await fs.stat(itemPath); if (stat.isFile()) return stat.size; if (stat.isDirectory()) { let total = 0; const entries = await fs.readdir(itemPath, { withFileTypes: true }); for (const entry of entries) { total += await getItemSize(path.join(itemPath, entry.name)); } return total; } } catch { return 0; } return 0; }
async function ensureInstanceIntegrity(instancePath, isGeode, useMegahack) { const items = getManagedItems(isGeode, useMegahack); for (const item of items) { const itemPath = path.join(instancePath, item); const exists = await fs.access(itemPath).then(()=>true).catch(()=>false); if (!exists) { if (item.includes('.') && !item.startsWith('geode')) await fs.writeFile(itemPath, ''); else await fs.mkdir(itemPath, { recursive: true }); } } }
async function transferManagedItems(src, dest, managedItems, move = false) { for (const item of managedItems) { const srcPath = path.join(src, item); const destPath = path.join(dest, item); if (!(await fs.access(srcPath).then(()=>true).catch(()=>false))) continue; if (await fs.access(destPath).then(()=>true).catch(()=>false)) await fs.rm(destPath, { recursive: true, force: true }); const srcStat = await fs.stat(srcPath); if (srcStat.isDirectory()) { await copyDir(srcPath, destPath); if (move) { try { await fs.rm(srcPath, { recursive: true, force: true }); } catch (e) { console.warn(`Failed to delete source dir ${item}: ${e.message}`); } } } else { if (move) { try { await fs.rename(srcPath, destPath); } catch (e) { await fs.copyFile(srcPath, destPath); try { await fs.unlink(srcPath); } catch (delErr) { console.error("Warning: Could not delete source after move", srcPath); } } } else { await fs.copyFile(srcPath, destPath); } } } }
async function copyDir(src, dest) { await fs.mkdir(dest, { recursive: true }); for (const entry of await fs.readdir(src, { withFileTypes: true })) { const srcPath = path.join(src, entry.name); const destPath = path.join(dest, entry.name); if (entry.isDirectory()) await copyDir(srcPath, destPath); else await fs.copyFile(srcPath, destPath); } }
async function postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings) {
  try {
    isSyncing = true;
    mainWindow.webContents.send('launch-status', `Syncing data for ${instanceName}...`);
    const instancePath = path.join(INSTANCES_DIR, instanceName);
    await transferManagedItems(localAppDataPath, instancePath, managedItems, true);
    if (await fs.access(infoJsonPath).then(() => true).catch(() => false)) {
      await fs.unlink(infoJsonPath);
    }
    if (settings.close_behavior === 'Close After Game Ends') app.quit();
    else {
      mainWindow.webContents.send('launch-complete');
      mainWindow.webContents.send('launch-status', 'Ready');
    }
  } catch (error) {
    mainWindow.webContents.send('launch-complete');
    mainWindow.webContents.send('launch-status', 'Ready');
  } finally {
    isSyncing = false;
  }
}
