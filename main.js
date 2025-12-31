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
   IPC
============================ */

function setupIpcHandlers() {
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('check-for-updates', () => checkForUpdates(true));
}

/* ============================
   UPDATE SYSTEM
============================ */

async function checkForUpdates(isManual = false) {
    try {
        const { data } = await axios.get(
            'http://api.pcpapc172.ir/archive/latestlauncher.json',
            { timeout: 5000 }
        );

        if (!semver.gt(data.version, app.getVersion())) {
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

        const updateUrl = isLinux ? data['url-linux'] : data['url-win'];
        if (!updateUrl) return;

        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `Version ${data.version} is available.`,
            buttons: ['Download & Install', 'Cancel']
        });

        if (response !== 0) return;

        const downloadPath = path.join(
            app.getPath('temp'),
            path.basename(updateUrl)
        );

        mainWindow.webContents.send('launch-status', 'Downloading update...');
        mainWindow.webContents.send('update-progress-start');

        const dl = new EasyDl(updateUrl, downloadPath, {
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
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Update Error',
            message: err.message,
            buttons: ['OK']
        });
    }
}
