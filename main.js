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
const editor = require('./editor');

let mainWindow;
let isGameRunning = false;
let gameProcessMonitor = null;
let gameProcess = null;
let isSyncing = false;

const isLinux = process.platform === 'linux';

let BASE_DIR, INSTANCES_DIR, TRASH_DIR, VERSIONS_DIR, BACKUPS_DIR, SETTINGS_FILE;

const DEFAULT_SETTINGS = {
    theme: 'Dark',
    close_behavior: 'Stay Open',
    sync_delay: 5,
    last_run_version: null
};

app.whenReady().then(async () => {
    BASE_DIR = app.getPath('userData');
    INSTANCES_DIR = path.join(BASE_DIR, 'Instances');
    TRASH_DIR = path.join(BASE_DIR, 'Trash');
    VERSIONS_DIR = path.join(BASE_DIR, 'Versions');
    BACKUPS_DIR = path.join(BASE_DIR, 'Backups');
    SETTINGS_FILE = path.join(BASE_DIR, 'launcher_settings.json');

    await fs.mkdir(INSTANCES_DIR, { recursive: true });
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.mkdir(TRASH_DIR, { recursive: true });
    await fs.mkdir(BACKUPS_DIR, { recursive: true });

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

/* ============================
   FEDORA HELPERS
============================ */

function isFedora() {
    if (!isLinux) return false;
    try {
        const osRelease = execSync('cat /etc/os-release', { encoding: 'utf8' });
        return osRelease.includes('ID=fedora');
    } catch {
        return false;
    }
}

function isRpmOstree() {
    try {
        execSync('which rpm-ostree', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function installRpm(rpmPath) {
    return new Promise((resolve, reject) => {
        const args = isRpmOstree()
            ? ['rpm-ostree', 'install', rpmPath]
            : ['dnf', 'install', '-y', rpmPath];

        const child = spawn('pkexec', args, { stdio: 'inherit' });

        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error('RPM installation failed'));
        });
    });
}

/* ============================
   WINDOW
============================ */

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
}

/* ============================
   IPC HANDLERS
============================ */

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
    ipcMain.on('repair-version', async (event, version) => downloadVersion(version));
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
                    steam_emulator: data.steam_emulator || 'SmartSteamEmu.exe'
                };
            }
            return { executable: 'GeometryDash.exe', steam_emulator: 'SmartSteamEmu.exe' };
        } catch {
            return { executable: 'GeometryDash.exe', steam_emulator: 'SmartSteamEmu.exe' };
        }
    });
    
    // Launch & Game Process
    ipcMain.on('launch-game', async (event, instanceName) => launchGame(instanceName));
    ipcMain.on('terminate-game', () => terminateGame());
    ipcMain.handle('is-game-running', () => isGameRunning);
    ipcMain.handle('handle-first-run-import', async () => await prepareLocalAppData(await getLinuxAppDataPath('GeometryDash'), path.join(BASE_DIR, 'info.json'), true));
    
    // Backup & Restore
    ipcMain.handle('create-backup', async (event, instanceName) => createBackup(instanceName));
    ipcMain.handle('get-backups', async (event, instanceName) => getBackups(instanceName));
    ipcMain.handle('restore-backup', async (event, instanceName, backupFileName) => restoreBackup(instanceName, backupFileName));
    ipcMain.handle('delete-backup', async (event, instanceName, backupFileName) => deleteBackup(instanceName, backupFileName));
    
    // Miscellaneous
    ipcMain.handle('open-folder', async (event, folderPath) => { await shell.openPath(folderPath); return { success: true }; });
    ipcMain.handle('show-item-in-folder', async (event, itemPath) => { shell.showItemInFolder(itemPath); return { success: true }; });
    ipcMain.handle('open-external', async (event, url) => { await shell.openExternal(url); return { success: true }; });
    
    // Update System
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('check-for-updates', () => checkForUpdates(true));
}

/* ============================
   UPDATE SYSTEM
============================ */

async function checkForUpdates(isManual = false) {
    try {
        // Fetch latest release from GitHub
        const { data } = await axios.get(
            'https://api.github.com/repos/pcpapc172/gdlauncher/releases/latest',
            { 
                timeout: 5000,
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            }
        );

        // Extract version from tag_name (remove 'v' prefix if present)
        const latestVersion = data.tag_name.startsWith('v') 
            ? data.tag_name.substring(1) 
            : data.tag_name;

        if (!semver.gt(latestVersion, app.getVersion())) {
            if (isManual) {
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'No Updates',
                    message: 'You already have the latest version.',
                    buttons: ['OK']
                });
            }
            return;
        }

        // Find the appropriate asset for the platform
        let updateAsset = null;
        
        if (isLinux) {
            // For Fedora, prefer RPM, otherwise DEB
            if (isFedora()) {
                updateAsset = data.assets.find(asset => 
                    asset.name.endsWith('.rpm')
                );
            }
            // Fallback to .deb if no RPM or not Fedora
            if (!updateAsset) {
                updateAsset = data.assets.find(asset => 
                    asset.name.endsWith('.deb')
                );
            }
        } else {
            // Windows - look for .exe installer
            updateAsset = data.assets.find(asset => 
                asset.name.endsWith('.exe') || asset.name.endsWith('-Setup.exe')
            );
        }

        if (!updateAsset) {
            if (isManual) {
                dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'No Compatible Update',
                    message: `Update ${latestVersion} is available, but no compatible installer was found for your platform.`,
                    buttons: ['OK']
                });
            }
            return;
        }

        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `Version ${latestVersion} is available.\n\nCurrent: ${app.getVersion()}\nLatest: ${latestVersion}\n\nFile: ${updateAsset.name}`,
            buttons: ['Download & Install', 'Cancel']
        });

        if (response !== 0) return;

        const downloadPath = path.join(
            app.getPath('temp'),
            updateAsset.name
        );

        mainWindow.webContents.send('launch-status', 'Downloading update...');
        mainWindow.webContents.send('update-progress-start');

        const dl = new EasyDl(updateAsset.browser_download_url, downloadPath, {
            connections: 6,
            maxRetry: 5
        });

        dl.on('progress', ({ total }) => {
            if (total.percentage) {
                mainWindow.webContents.send(
                    'update-progress',
                    total.percentage
                );
            }
        });

        await dl.wait();
        mainWindow.webContents.send('update-progress-complete');

        if (isLinux && isFedora() && downloadPath.endsWith('.rpm')) {
            mainWindow.webContents.send('launch-status', 'Installing update...');
            await installRpm(downloadPath);

            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Update Installed',
                message: 'Update installed successfully. Restarting…',
                buttons: ['OK']
            });

            app.quit();
        } else {
            shell.openPath(downloadPath);
        }
    } catch (err) {
        if (isManual) {
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Update Error',
                message: err.message,
                buttons: ['OK']
            });
        }
    }
}

/* ============================
   INSTANCES
============================ */

async function getInstances() {
    try {
        const files = await fs.readdir(INSTANCES_DIR);
        const instances = [];
        for (const file of files) {
            const instancePath = path.join(INSTANCES_DIR, file);
            const stat = await fs.stat(instancePath);
            if (stat.isDirectory()) {
                const jsonPath = path.join(instancePath, 'instance.json');
                try {
                    const data = await fs.readFile(jsonPath, 'utf8');
                    const instance = JSON.parse(data);
                    instance.folderName = file;
                    instances.push(instance);
                } catch (error) {
                    console.error(`Error reading instance ${file}:`, error);
                }
            }
        }
        return instances;
    } catch (error) {
        console.error('Error getting instances:', error);
        return [];
    }
}

async function createInstance(data) {
    try {
        const { name, versionType, version, versionPath, saveFolderName, isGeodeCompatible, useMegaHack } = data;
        
        if (!name) {
            return { success: false, error: 'Instance name is required' };
        }
        
        const instancePath = path.join(INSTANCES_DIR, name);
        
        if (await fs.access(instancePath).then(() => true).catch(() => false)) {
            return { success: false, error: 'Instance already exists' };
        }
        
        await fs.mkdir(instancePath, { recursive: true });
        
        const instanceData = {
            name,
            versionType: versionType || 'remote',
            version: version || '2.2/2.207',
            versionPath: versionPath || '',
            saveFolderName: saveFolderName || 'GeometryDash',
            isGeodeCompatible: isGeodeCompatible !== undefined ? isGeodeCompatible : true,
            useMegaHack: useMegaHack !== undefined ? useMegaHack : true,
            creationDate: new Date().toISOString()
        };
        
        await fs.writeFile(
            path.join(instancePath, 'instance.json'),
            JSON.stringify(instanceData, null, 4)
        );
        
        await ensureInstanceIntegrity(instancePath, instanceData.isGeodeCompatible, instanceData.useMegaHack);
        
        return { success: true };
    } catch (error) {
        console.error('Error creating instance:', error);
        return { success: false, error: error.message };
    }
}

async function editInstance(originalName, data) {
    try {
        const oldPath = path.join(INSTANCES_DIR, originalName);
        const newPath = path.join(INSTANCES_DIR, data.name);
        
        if (originalName !== data.name) {
            if (await fs.access(newPath).then(() => true).catch(() => false)) {
                return { success: false, error: 'An instance with that name already exists' };
            }
            await fs.rename(oldPath, newPath);
        }
        
        const instanceData = {
            name: data.name,
            versionType: data.versionType,
            version: data.version,
            versionPath: data.versionPath || '',
            saveFolderName: data.saveFolderName,
            isGeodeCompatible: data.isGeodeCompatible,
            useMegaHack: data.useMegaHack,
            creationDate: data.creationDate
        };
        
        await fs.writeFile(
            path.join(newPath, 'instance.json'),
            JSON.stringify(instanceData, null, 4)
        );
        
        await ensureInstanceIntegrity(newPath, data.isGeodeCompatible, data.useMegaHack);
        
        return { success: true };
    } catch (error) {
        console.error('Error editing instance:', error);
        return { success: false, error: error.message };
    }
}

async function deleteInstance(name) {
    try {
        const instancePath = path.join(INSTANCES_DIR, name);
        await moveToTrash(instancePath, `Instance_${name}`);
        return { success: true };
    } catch (error) {
        console.error('Error deleting instance:', error);
        return { success: false, error: error.message };
    }
}

/* ============================
   VERSIONS
============================ */

async function getVersions() {
    try {
        const versions = [];
        const categories = await fs.readdir(VERSIONS_DIR);
        
        for (const category of categories) {
            const categoryPath = path.join(VERSIONS_DIR, category);
            const stat = await fs.stat(categoryPath);
            
            if (stat.isDirectory()) {
                const versionFolders = await fs.readdir(categoryPath);
                
                for (const versionFolder of versionFolders) {
                    const versionPath = path.join(categoryPath, versionFolder);
                    const versionStat = await fs.stat(versionPath);
                    
                    if (versionStat.isDirectory()) {
                        versions.push({
                            id: `${category}/${versionFolder}`,
                            path: `${category}/${versionFolder}`,
                            category,
                            version: versionFolder
                        });
                    }
                }
            }
        }
        
        return versions;
    } catch (error) {
        console.error('Error getting versions:', error);
        return [];
    }
}

async function getVersionsWithSizes() {
    try {
        const versions = await getVersions();
        const versionsWithSizes = [];
        
        for (const version of versions) {
            const versionPath = path.join(VERSIONS_DIR, version.path);
            const size = await getItemSize(versionPath);
            versionsWithSizes.push({
                ...version,
                size
            });
        }
        
        return versionsWithSizes;
    } catch (error) {
        console.error('Error getting versions with sizes:', error);
        return [];
    }
}

async function fetchRemoteVersions() {
    try {
        const response = await axios.get('http://api.pcpapc172.ir/archive/versions.json');
        return response.data;
    } catch (error) {
        console.error('Error fetching remote versions:', error);
        throw error;
    }
}

async function calculateAllVersionSizes(versions) {
    const results = [];
    for (const version of versions) {
        const versionPath = path.join(VERSIONS_DIR, version.path || `${version.category}/${version.version}`);
        const exists = await fs.access(versionPath).then(() => true).catch(() => false);
        
        if (exists) {
            const size = await getItemSize(versionPath);
            results.push({ id: version.id, size });
        }
    }
    return results;
}

async function downloadVersion(version) {
    try {
        mainWindow.webContents.send('download-start', { id: version.id });
        mainWindow.webContents.send('launch-status', `Downloading ${version.id}...`);
        
        const downloadPath = path.join(app.getPath('temp'), `${version.id.replace('/', '_')}.zip`);
        const extractPath = path.join(VERSIONS_DIR, version.category, version.version);
        
        await fs.mkdir(path.join(VERSIONS_DIR, version.category), { recursive: true });
        
        const dl = new EasyDl(version.url, downloadPath, {
            connections: 6,
            maxRetry: 5
        });
        
        dl.on('progress', ({ total }) => {
            if (total.percentage) {
                mainWindow.webContents.send('download-progress', {
                    id: version.id,
                    percentage: total.percentage
                });
            }
        });
        
        await dl.wait();
        
        mainWindow.webContents.send('launch-status', `Extracting ${version.id}...`);
        
        if (await fs.access(extractPath).then(() => true).catch(() => false)) {
            await fs.rm(extractPath, { recursive: true, force: true });
        }
        
        await decompress(downloadPath, extractPath, {
            plugins: [decompressUnzip()]
        });
        
        await fs.unlink(downloadPath);
        
        const versionJsonPath = path.join(extractPath, 'version.json');
        const versionJsonExists = await fs.access(versionJsonPath).then(() => true).catch(() => false);
        
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

/* ============================
   GAME LAUNCH
============================ */

async function launchGame(instanceName) {
    if (isGameRunning) {
        mainWindow.webContents.send('launch-complete');
        mainWindow.webContents.send('launch-status', 'Game is already running');
        return;
    }

    if (isSyncing) {
        mainWindow.webContents.send('launch-complete');
        mainWindow.webContents.send('launch-status', 'Please wait, syncing in progress...');
        return;
    }

    try {
        mainWindow.webContents.send('launch-status', `Preparing to launch ${instanceName}...`);
        
        const instancePath = path.join(INSTANCES_DIR, instanceName);
        const instanceJsonPath = path.join(instancePath, 'instance.json');
        const data = JSON.parse(await fs.readFile(instanceJsonPath, 'utf8'));
        
        let versionPath;
        if (data.versionType === 'local') {
            versionPath = data.versionPath;
            if (!path.isAbsolute(versionPath)) {
                mainWindow.webContents.send('launch-complete');
                mainWindow.webContents.send('launch-status', 'Invalid local version path');
                return;
            }
        } else {
            versionPath = path.join(VERSIONS_DIR, data.version);
        }
        
        if (!(await fs.access(versionPath).then(() => true).catch(() => false))) {
            mainWindow.webContents.send('launch-complete');
            mainWindow.webContents.send('launch-status', 'Version not found');
            return;
        }
        
        const versionJsonPath = path.join(versionPath, 'version.json');
        let versionConfig = { executable: 'GeometryDash.exe', steam_emulator: 'SmartSteamEmu.exe' };
        if (await fs.access(versionJsonPath).then(() => true).catch(() => false)) {
            versionConfig = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
        }
        
        const exePath = path.join(versionPath, versionConfig.executable);
        if (!(await fs.access(exePath).then(() => true).catch(() => false))) {
            mainWindow.webContents.send('launch-complete');
            mainWindow.webContents.send('launch-status', 'Game executable not found');
            return;
        }
        
        const localAppDataPath = await getLinuxAppDataPath(data.saveFolderName);
        const infoJsonPath = path.join(BASE_DIR, 'info.json');
        
        const prepResult = await prepareLocalAppData(localAppDataPath, infoJsonPath);
        if (!prepResult.success) {
            mainWindow.webContents.send('launch-complete');
            mainWindow.webContents.send('launch-status', prepResult.error || 'Failed to prepare save data');
            return;
        }
        
        await ensureInstanceIntegrity(instancePath, data.isGeodeCompatible, data.useMegaHack);
        
        const managedItems = getManagedItems(data.isGeodeCompatible, data.useMegaHack);
        await transferManagedItems(instancePath, localAppDataPath, managedItems, false);
        
        await fs.writeFile(infoJsonPath, JSON.stringify({ instanceName }, null, 4));
        
        mainWindow.webContents.send('launch-status', `Launching ${instanceName}...`);
        
        let launchCommand;
        if (isLinux) {
            launchCommand = ['wine', exePath];
        } else {
            launchCommand = [exePath];
        }
        
        gameProcess = spawn(launchCommand[0], launchCommand.slice(1), {
            cwd: versionPath,
            detached: false
        });
        
        isGameRunning = true;
        mainWindow.webContents.send('game-started');
        
        const settings = await loadSettingsInternal();
        const syncDelay = (settings.sync_delay || 5) * 1000;
        
        gameProcessMonitor = setInterval(async () => {
            const processName = path.basename(versionConfig.executable);
            const running = await checkProcessRunning(processName);
            
            if (!running) {
                clearInterval(gameProcessMonitor);
                gameProcessMonitor = null;
                isGameRunning = false;
                mainWindow.webContents.send('game-stopped');
                
                setTimeout(async () => {
                    await postLaunchCleanup(instanceName, data, localAppDataPath, infoJsonPath, managedItems, settings);
                }, syncDelay);
            }
        }, 2000);
        
    } catch (error) {
        console.error('Launch error:', error);
        mainWindow.webContents.send('launch-complete');
        mainWindow.webContents.send('launch-status', `Launch failed: ${error.message}`);
        isGameRunning = false;
    }
}

function terminateGame() {
    if (gameProcess && !gameProcess.killed) {
        try {
            if (isLinux) {
                execSync(`pkill -9 -f GeometryDash.exe`, { stdio: 'ignore' });
            } else {
                gameProcess.kill('SIGKILL');
            }
        } catch (error) {
            console.error('Error terminating game:', error);
        }
    }
    
    if (gameProcessMonitor) {
        clearInterval(gameProcessMonitor);
        gameProcessMonitor = null;
    }
    
    isGameRunning = false;
    gameProcess = null;
    mainWindow.webContents.send('game-stopped');
    mainWindow.webContents.send('launch-status', 'Game terminated');
}

/* ============================
   BACKUPS
============================ */

async function createBackup(instanceName) {
    try {
        const instancePath = path.join(INSTANCES_DIR, instanceName);
        const backupDir = path.join(BACKUPS_DIR, instanceName);
        await fs.mkdir(backupDir, { recursive: true });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupFile = path.join(backupDir, `backup_${timestamp}.zip`);
        
        const instanceData = JSON.parse(await fs.readFile(path.join(instancePath, 'instance.json'), 'utf8'));
        const managedItems = getManagedItems(instanceData.isGeodeCompatible, instanceData.useMegaHack);
        
        const tempBackupDir = path.join(app.getPath('temp'), `backup_${timestamp}`);
        await fs.mkdir(tempBackupDir, { recursive: true });
        
        for (const item of managedItems) {
            const srcPath = path.join(instancePath, item);
            const destPath = path.join(tempBackupDir, item);
            
            if (await fs.access(srcPath).then(() => true).catch(() => false)) {
                const stat = await fs.stat(srcPath);
                if (stat.isDirectory()) {
                    await copyDir(srcPath, destPath);
                } else {
                    await fs.copyFile(srcPath, destPath);
                }
            }
        }
        
        const archiver = require('archiver');
        const output = require('fs').createWriteStream(backupFile);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(tempBackupDir, false);
            archive.finalize();
        });
        
        await fs.rm(tempBackupDir, { recursive: true, force: true });
        
        return { success: true, backupFile: path.basename(backupFile) };
    } catch (error) {
        console.error('Backup error:', error);
        return { success: false, error: error.message };
    }
}

async function getBackups(instanceName) {
    try {
        const backupDir = path.join(BACKUPS_DIR, instanceName);
        
        if (!(await fs.access(backupDir).then(() => true).catch(() => false))) {
            return [];
        }
        
        const files = await fs.readdir(backupDir);
        const backups = [];
        
        for (const file of files) {
            if (file.endsWith('.zip')) {
                const filePath = path.join(backupDir, file);
                const stat = await fs.stat(filePath);
                backups.push({
                    fileName: file,
                    size: stat.size,
                    date: stat.mtime
                });
            }
        }
        
        backups.sort((a, b) => b.date - a.date);
        return backups;
    } catch (error) {
        console.error('Error getting backups:', error);
        return [];
    }
}

async function restoreBackup(instanceName, backupFileName) {
    try {
        const backupPath = path.join(BACKUPS_DIR, instanceName, backupFileName);
        const instancePath = path.join(INSTANCES_DIR, instanceName);
        
        const tempDir = path.join(app.getPath('temp'), `restore_${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        
        await decompress(backupPath, tempDir, {
            plugins: [decompressUnzip()]
        });
        
        const instanceData = JSON.parse(await fs.readFile(path.join(instancePath, 'instance.json'), 'utf8'));
        const managedItems = getManagedItems(instanceData.isGeodeCompatible, instanceData.useMegaHack);
        
        await transferManagedItems(tempDir, instancePath, managedItems, false);
        
        await fs.rm(tempDir, { recursive: true, force: true });
        
        return { success: true };
    } catch (error) {
        console.error('Restore error:', error);
        return { success: false, error: error.message };
    }
}

async function deleteBackup(instanceName, backupFileName) {
    try {
        const backupPath = path.join(BACKUPS_DIR, instanceName, backupFileName);
        await fs.unlink(backupPath);
        return { success: true };
    } catch (error) {
        console.error('Error deleting backup:', error);
        return { success: false, error: error.message };
    }
}

/* ============================
   FILE SYSTEM HELPERS
============================ */

async function prepareLocalAppData(localPath, infoPath, isTour = false) {
    const allPossibleItems = getAllManagedItems();
    const foundInAppData = [];
    for (const item of allPossibleItems) {
        if (await fs.access(path.join(localPath, item)).then(() => true).catch(() => false)) {
            foundInAppData.push(item);
        }
    }
    
    if (foundInAppData.length === 0) return { success: true, found: false };
    
    if (await fs.access(infoPath).then(() => true).catch(() => false)) {
        if (isTour) return { success: true, found: false };
        try {
            const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));
            const targetDir = path.join(INSTANCES_DIR, info.instanceName);
            if (!(await fs.access(path.join(targetDir, 'instance.json')).then(() => true).catch(() => false))) {
                await fs.unlink(infoPath);
                return { success: true };
            }
            const prevData = JSON.parse(await fs.readFile(path.join(targetDir, 'instance.json'), 'utf8'));
            await transferManagedItems(await getLinuxAppDataPath(prevData.saveFolderName), targetDir, getManagedItems(prevData.isGeodeCompatible, prevData.useMegaHack), true);
            await fs.unlink(infoPath);
            return { success: true, found: true };
        } catch (error) {
            return { success: false, error: `Recovery failed: ${error.message}` };
        }
    } else {
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
                const instanceData = {
                    name: newName,
                    versionType: 'local',
                    version: '2.2/2.207',
                    saveFolderName: 'GeometryDash',
                    isGeodeCompatible: true,
                    useMegaHack: true,
                    creationDate: new Date().toISOString()
                };
                await fs.writeFile(path.join(newInstancePath, 'instance.json'), JSON.stringify(instanceData, null, 4));
                await transferManagedItems(localPath, newInstancePath, foundInAppData, true);
                return { success: true, found: true };
            } catch (error) {
                return { success: false, error: `Import failed: ${error.message}` };
            }
        } else if (response === 1) {
            try {
                const trashFolder = path.join(TRASH_DIR, `UnmanagedData_${new Date().toISOString().replace(/[:.]/g, '-')}`);
                await fs.mkdir(trashFolder, { recursive: true });
                await transferManagedItems(localPath, trashFolder, foundInAppData, true);
                return { success: true, found: true };
            } catch (error) {
                return { success: false, error: `Could not move to trash: ${error.message}` };
            }
        } else {
            return { success: false, error: 'Launch cancelled by user.' };
        }
    }
}

async function getLinuxAppDataPath(saveFolderName) {
    if (!isLinux) return path.join(process.env.LOCALAPPDATA, saveFolderName);
    const username = os.userInfo().username;
    const wineUserDir = path.join(os.homedir(), '.wine', 'drive_c', 'users', username);
    const candidates = [
        path.join(wineUserDir, 'AppData', 'Local', saveFolderName),
        path.join(wineUserDir, 'Local Settings', 'Application Data', saveFolderName)
    ];
    for (const candidate of candidates) {
        try {
            if (await fs.access(path.join(candidate, 'CCGameManager.dat')).then(() => true).catch(() => false)) return candidate;
        } catch (e) {}
    }
    return candidates[0];
}

async function checkProcessRunning(processName) {
    try {
        const list = await psList();
        return list.some(p => {
            const nameMatch = p.name.toLowerCase() === processName.toLowerCase();
            let cmdMatch = false;
            if (isLinux && p.cmd) cmdMatch = p.cmd.toLowerCase().includes(processName.toLowerCase());
            return nameMatch || cmdMatch;
        });
    } catch (error) {
        return false;
    }
}

async function moveToTrash(sourcePath, prefix) {
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const folderName = `${prefix}_${dateStr}`;
    const trashPath = path.join(TRASH_DIR, folderName);
    await fs.mkdir(TRASH_DIR, { recursive: true });
    if (!(await fs.access(sourcePath).then(() => true).catch(() => false))) return;
    const stat = await fs.stat(sourcePath);
    if (stat.isDirectory()) {
        try {
            await fs.rename(sourcePath, trashPath);
        } catch (e) {
            await copyDir(sourcePath, trashPath);
            try {
                await fs.rm(sourcePath, { recursive: true, force: true });
            } catch (ign) {}
        }
    } else {
        await fs.mkdir(trashPath, { recursive: true });
        try {
            await fs.rename(sourcePath, path.join(trashPath, path.basename(sourcePath)));
        } catch (e) {
            await fs.copyFile(sourcePath, path.join(trashPath, path.basename(sourcePath)));
            try {
                await fs.unlink(sourcePath);
            } catch (ign) {}
        }
    }
    return trashPath;
}

async function loadSettingsInternal() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

function getAllManagedItems() {
    return [
        "CCGameManager.dat", "CCGameManager2.dat", "CCGameManager.dat.bak",
        "CCLocalLevels.dat", "CCLocalLevels2.dat", "CCLocalLevels.dat.bak",
        "geode", "geode-backups", "trashed-levels",
        "CCBetterInfo.dat", "CCBetterInfo2.dat",
        "CCBetterInfoCache.dat", "CCBetterInfoCache2.dat",
        "CCBetterInfoStats.dat", "CCBetterInfoStats2.dat"
    ];
}

function getManagedItems(isGeode, useMegahack) {
    const items = [
        "CCGameManager.dat", "CCGameManager2.dat", "CCGameManager.dat.bak",
        "CCLocalLevels.dat", "CCLocalLevels2.dat", "CCLocalLevels.dat.bak"
    ];
    if (isGeode) items.push('geode', 'geode-backups', 'trashed-levels');
    if (useMegahack) items.push(
        'CCBetterInfo.dat', 'CCBetterInfo2.dat',
        'CCBetterInfoCache.dat', 'CCBetterInfoCache2.dat',
        'CCBetterInfoStats.dat', 'CCBetterInfoStats2.dat'
    );
    return items;
}

async function getItemSize(itemPath) {
    try {
        const stat = await fs.stat(itemPath);
        if (stat.isFile()) return stat.size;
        if (stat.isDirectory()) {
            let total = 0;
            const entries = await fs.readdir(itemPath, { withFileTypes: true });
            for (const entry of entries) {
                total += await getItemSize(path.join(itemPath, entry.name));
            }
            return total;
        }
    } catch {
        return 0;
    }
    return 0;
}

async function ensureInstanceIntegrity(instancePath, isGeode, useMegahack) {
    const items = getManagedItems(isGeode, useMegahack);
    for (const item of items) {
        const itemPath = path.join(instancePath, item);
        const exists = await fs.access(itemPath).then(() => true).catch(() => false);
        if (!exists) {
            if (item.includes('.') && !item.startsWith('geode')) await fs.writeFile(itemPath, '');
            else await fs.mkdir(itemPath, { recursive: true });
        }
    }
}

async function transferManagedItems(src, dest, managedItems, move = false) {
    for (const item of managedItems) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        if (!(await fs.access(srcPath).then(() => true).catch(() => false))) continue;
        if (await fs.access(destPath).then(() => true).catch(() => false)) await fs.rm(destPath, { recursive: true, force: true });
        const srcStat = await fs.stat(srcPath);
        if (srcStat.isDirectory()) {
            await copyDir(srcPath, destPath);
            if (move) {
                try {
                    await fs.rm(srcPath, { recursive: true, force: true });
                } catch (e) {
                    console.warn(`Failed to delete source dir ${item}: ${e.message}`);
                }
            }
        } else {
            if (move) {
                try {
                    await fs.rename(srcPath, destPath);
                } catch (e) {
                    await fs.copyFile(srcPath, destPath);
                    try {
                        await fs.unlink(srcPath);
                    } catch (delErr) {
                        console.error("Warning: Could not delete source after move", srcPath);
                    }
                }
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }
}

async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) await copyDir(srcPath, destPath);
        else await fs.copyFile(srcPath, destPath);
    }
}

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
