const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { dialog } = require('electron');

let globalEditorSession = {
    instanceName: null,
    gdObject: null,
    isDirty: false,
    isLegacy: false
};

// --- GD PARSER & CRYPTO DEFINITIONS (MOVED TO THE TOP) ---

const GDParser = {
    parse: (xml) => {
        xml = xml.toString().replace(/\0/g, ''); 
        let pos = 0;
        const parseNext = () => {
            const openStart = xml.indexOf('<', pos);
            if (openStart === -1) return null;
            const openEnd = xml.indexOf('>', openStart);
            if (openEnd === -1) return null;
            const fullTag = xml.substring(openStart + 1, openEnd);
            let tagName = fullTag.split(' ')[0].split('>')[0];
            const isClosing = fullTag.startsWith('/');
            const isSelfClosing = fullTag.endsWith('/');
            pos = openEnd + 1;
            if (isClosing) return { type: 'close', tag: tagName.substring(1) };
            if (tagName === 'k' || tagName === 'key') {
                const endTag = tagName === 'k' ? '</k>' : '</key>';
                const endPos = xml.indexOf(endTag, pos);
                const key = xml.substring(pos, endPos);
                pos = endPos + endTag.length;
                return { type: 'key', value: key };
            }
            if (tagName === 's' || tagName === 'string') {
                const endTag = tagName === 's' ? '</s>' : '</string>';
                const endPos = xml.indexOf(endTag, pos);
                let val = xml.substring(pos, endPos);
                pos = endPos + endTag.length;
                return { type: 'val', value: val };
            }
            if (tagName === 'i' || tagName === 'integer') {
                const endTag = tagName === 'i' ? '</i>' : '</integer>';
                const endPos = xml.indexOf(endTag, pos);
                let val = xml.substring(pos, endPos);
                pos = endPos + endTag.length;
                return { type: 'val', value: parseInt(val) };
            }
            if (tagName === 'r' || tagName === 'real') {
                const endTag = tagName === 'r' ? '</r>' : '</real>';
                const endPos = xml.indexOf(endTag, pos);
                let val = xml.substring(pos, endPos);
                pos = endPos + endTag.length;
                return { type: 'val', value: parseFloat(val) };
            }
            if (tagName === 't' || tagName === 'true') return { type: 'val', value: true };
            if (tagName === 'f' || tagName === 'false') return { type: 'val', value: false };
            if (tagName === 'd' || tagName === 'dict') {
                if (isSelfClosing) return { type: 'val', value: {} };
                const obj = {};
                let currentKey = null;
                while (true) {
                    const node = parseNext();
                    if (!node || node.type === 'close') break;
                    if (node.type === 'key') currentKey = node.value;
                    else if (node.type === 'val' && currentKey !== null) {
                        if (currentKey !== '_isArr') obj[currentKey] = node.value;
                        currentKey = null;
                    }
                }
                return { type: 'val', value: obj };
            }
            if (tagName.startsWith('?xml') || tagName.startsWith('plist')) return parseNext();
            return parseNext();
        };
        pos = xml.indexOf('<d');
        if (pos === -1) pos = xml.indexOf('<dict');
        if (pos === -1) return {};
        const result = parseNext();
        return result && result.value ? result.value : {};
    },
    build: (obj) => {
        const process = (o) => {
            let s = '';
            for (const [k, v] of Object.entries(o)) {
                s += `<k>${k}</k>`;
                if (typeof v === 'object' && v !== null) {
                    if (Object.keys(v).length === 0) s += '<d />';
                    else s += `<d>${process(v)}</d>`;
                } else if (typeof v === 'boolean') s += v ? '<t />' : '<f />';
                else if (typeof v === 'number') s += Number.isInteger(v) ? `<i>${v}</i>` : `<r>${v}</r>`;
                else s += `<s>${v}</s>`;
            }
            return s;
        };
        return `<?xml version="1.0"?><plist version="1.0" gjver="2.0"><dict>${process(obj)}</dict></plist>`;
    },
    buildPretty: (obj) => {
        const indent = (level) => '  '.repeat(level);
        const process = (o, level) => {
            let s = '';
            for (const [k, v] of Object.entries(o)) {
                s += `\n${indent(level)}<k>${k}</k>`;
                if (typeof v === 'object' && v !== null) {
                    if (Object.keys(v).length === 0) s += `\n${indent(level)}<d />`;
                    else s += `\n${indent(level)}<d>${process(v, level + 1)}\n${indent(level)}</d>`;
                } else if (typeof v === 'boolean') s += `\n${indent(level)}${v ? '<t />' : '<f />'}`;
                else if (typeof v === 'number') s += Number.isInteger(v) ? `\n${indent(level)}<i>${v}</i>` : `\n${indent(level)}<r>${v}</r>`;
                else s += `\n${indent(level)}<s>${v}</s>`;
            }
            return s;
        };
        return `<?xml version="1.0"?>\n<plist version="1.0" gjver="2.0">\n<dict>${process(obj, 1)}\n</dict>\n</plist>`;
    }
};

const GDCrypto = {
    xor: (buffer, key) => { const r = Buffer.alloc(buffer.length); for (let i=0;i<buffer.length;i++) r[i]=buffer[i]^key; return r; },
    urlSafeBase64Decode: (str) => {
        let s = str.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '='; 
        return Buffer.from(s, 'base64');
    },
    urlSafeBase64Encode: (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    decryptSaveFile: async (fp) => { 
        try { 
            const d = await fs.readFile(fp); 
            if(d.toString().trim().startsWith('<')) return d.toString(); 
            try { return zlib.unzipSync(GDCrypto.urlSafeBase64Decode(GDCrypto.xor(d,11).toString())).toString(); } 
            catch(e){ return zlib.unzipSync(GDCrypto.urlSafeBase64Decode(d.toString())).toString(); } 
        } catch(e){ return null; } 
    },
    encryptSaveFile: async (s, fp) => { 
        try { 
            const zipped = zlib.gzipSync(Buffer.from(s));
            const b64 = GDCrypto.urlSafeBase64Encode(zipped);
            const xored = GDCrypto.xor(Buffer.from(b64), 11);
            await fs.writeFile(fp, xored); 
            return true; 
        } catch(e){ return false; } 
    },
    decryptLevelString: (s) => { 
        if(!s) return "";
        try { return zlib.unzipSync(GDCrypto.urlSafeBase64Decode(s)).toString(); } catch(e){ return s; } 
    },
    encryptLevelString: (s) => { 
        if(!s) return "";
        try { return GDCrypto.urlSafeBase64Encode(zlib.gzipSync(Buffer.from(s))); } catch(e){ return ""; } 
    }
};

// --- NEW TRANSLATION LOGIC ---
function translate19to20(levelObject) {
    // Convert kI6 string values to integers for 2.0+
    if (levelObject.kI6) {
        const newKI6 = {};
        for (const key in levelObject.kI6) {
            newKI6[key] = parseInt(levelObject.kI6[key], 10) || 0;
        }
        levelObject.kI6 = newKI6;
    }
    
    // Add k101 if missing (2.0+ requirement)
    if (!levelObject.k101) {
        levelObject.k101 = "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0";
    }
    
    // Update k50 to 45 (2.0+ format version)
    if (levelObject.k50 === 23) {
        levelObject.k50 = 45;
    }
    
    return levelObject;
}

function is20PlusLevel(content) {
    // Check for 2.0+ indicators
    if (content.includes('gjver="2.0"')) return true;
    if (content.includes('k101')) return true; // 2.0+ exclusive key
    if (content.includes('<k>k101</k>')) return true;
    
    // For raw level strings, check if decompressed data has 2.0+ markers
    try {
        const decrypted = GDCrypto.decryptLevelString(content);
        if (decrypted.includes('kA14') || decrypted.includes(';')) return true;
    } catch(e) {
        // Not encrypted, might be raw
    }
    
    return false;
}

// --- EXPORTED HANDLERS ---
module.exports = {
    renameLevel: async (key, newName) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        const l = globalEditorSession.gdObject.LLM_01[key]; 
        if(!l) return {success:false}; 
        l.k2 = newName; 
        globalEditorSession.isDirty = true; 
        return {success:true}; 
    },

    initSession: async (instancesDir, instanceName) => {
        try { 
            const p = path.join(instancesDir, instanceName, 'CCLocalLevels.dat'); 
            if(!(await fs.access(p).then(() => 1).catch(() => 0))) return { success: false, error: 'CCLocalLevels.dat not found in this instance.' }; 
            const xml = await GDCrypto.decryptSaveFile(p); 
            if(!xml) return { success: false, error: 'Failed to decrypt save file. It may be corrupted.' }; 
            
            const isLegacyFormat = !xml.includes('gjver="2.0"');
            let parsed = GDParser.parse(xml);
            if (!parsed.LLM_01) parsed = { LLM_01: {}, LLM_02: isLegacyFormat ? 23 : 45 }; 
            
            globalEditorSession = { instanceName, gdObject: parsed, isDirty: false, isLegacy: isLegacyFormat }; 
            return { success: true }; 
        } catch(err){ return { success: false, error: err.message }; } 
    },

    persist: async (instancesDir) => {
        if(!globalEditorSession.gdObject) return {success:false, error: "No session."}; 
        try { 
            const xml = GDParser.build(globalEditorSession.gdObject);
            await GDCrypto.encryptSaveFile(xml, path.join(instancesDir, globalEditorSession.instanceName, 'CCLocalLevels.dat')); 
            globalEditorSession.isDirty=false; 
            return {success:true}; 
        } catch(e){ return {success:false,error:e.message}; } 
    },

    getLevels: async () => {
        if(!globalEditorSession.gdObject) return {success:false, error: "No session."}; 
        const l=[]; 
        const root = globalEditorSession.gdObject.LLM_01 || {};
        Object.entries(root).forEach(([k,v])=>{
            if(k.startsWith('k_')) {
                let songId = v.k45 !== undefined ? v.k45 : (v.k8 !== undefined ? v.k8 : 0);
                let isCustomSong = v.k45 !== undefined;
                let description = v.k3 || '';
                let starRequest = v.k66 || 0;
                
                l.push({ 
                    key: k, 
                    name: v.k2 || 'Unnamed', 
                    songId, 
                    isCustomSong, 
                    length: v.k23,
                    description,
                    starRequest
                });
            }
        }); 
        return {success:true, levels:l}; 
    },

    getRaw: async (key) => {
        if (!globalEditorSession.gdObject) return { success: false, error: 'No Session' }; 
        try { 
            const lvl = globalEditorSession.gdObject.LLM_01[key]; 
            return { success: true, data: GDCrypto.decryptLevelString(lvl.k4) }; 
        } catch (e) { return { success: false, error: e.message }; } 
    },

    saveAll: async (key, updates) => {
        if (!globalEditorSession.gdObject) return { success: false, error: 'No Session' }; 
        try { 
            const lvl = globalEditorSession.gdObject.LLM_01[key]; 
            if (updates.songId !== undefined) { 
                if (updates.isCustom) { lvl.k45 = parseInt(updates.songId); delete lvl.k8; } 
                else { lvl.k8 = parseInt(updates.songId); delete lvl.k45; } 
            } 
            if (updates.rawData !== undefined) { 
                lvl.k4 = GDCrypto.encryptLevelString(updates.rawData); 
            } 
            globalEditorSession.isDirty = true; 
            return { success: true }; 
        } catch (e) { return { success: false, error: e.message }; } 
    },

    importLevel: async (mainWindow, key) => {
        if (!globalEditorSession.gdObject) return { success: false, error: 'No active editor session.' };
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'GD Levels', extensions: ['txt', 'gmd'] }] });
        if (canceled || !filePaths || filePaths.length === 0) return { success: false, error: 'Cancelled' };
        
        let content = await fs.readFile(filePaths[0], 'utf8');
        content = content.trim();

        const isTargetLegacy = globalEditorSession.isLegacy;
        const isSource20Plus = is20PlusLevel(content);
        
        // VERSION COMPATIBILITY CHECK
        if (isTargetLegacy && isSource20Plus) {
            return { success: false, error: 'Cannot import a 2.0+ level into a 1.9 or older instance. The level format is incompatible.' };
        }

        let levelObject = {};
        const isGMD = content.startsWith('<');
        
        if (isGMD) {
            // GMD PARSING FIX
            const parsedGMD = GDParser.parse(content);
            
            // GMD files have the level as the ROOT dict, not nested
            if (parsedGMD.k2 && parsedGMD.k4) {
                levelObject = parsedGMD;
            } else {
                // Fallback: search in nested dicts
                levelObject = Object.values(parsedGMD).find(v => typeof v === 'object' && v.k2 && v.k4);
            }
            
            if (!levelObject || !levelObject.k4) {
                return { success: false, error: 'Could not find a valid level in the GMD file.' };
            }
        } else {
            // TXT FILE - Raw level string
            // Check if it's already encrypted (starts with H4sIA) or raw
            const isEncrypted = content.startsWith('H4sIA');
            levelObject.k4 = isEncrypted ? content : GDCrypto.encryptLevelString(content);
        }

        // TRANSLATION FOR 1.9 → 2.0+
        if (!isTargetLegacy && !isSource20Plus) {
            console.log("Translating 1.9 level to 2.0+ format...");
            levelObject = translate19to20(levelObject);
        }
        
        const root = globalEditorSession.gdObject.LLM_01 || {};
        
        if (key === 'new') {
            // SMART NUMBERING SYSTEM
            let counter = 1;
            let newName = "";
            while (true) {
                const proposedName = `Imported ${counter}`;
                const exists = Object.values(root).some(lvl => lvl.k2 === proposedName);
                if (!exists) {
                    newName = proposedName;
                    break;
                }
                counter++;
            }
            
            // Find highest key number
            let maxKey = 0;
            Object.keys(root).forEach(k => {
                if (k.startsWith('k_')) {
                    const num = parseInt(k.split('_')[1]);
                    if (!isNaN(num)) maxKey = Math.max(maxKey, num);
                }
            });
            const newKey = `k_${maxKey + 1}`;
            
            // Default properties for new level - INCLUDING ALL 2.0+ REQUIRED FIELDS
            const defaultNewLevel = {
                k1: 1,
                k2: newName,
                k5: 'Player',
                k13: true,
                k21: 2,
                k16: 1,
                k80: 0,
                kCEK: 4,
                k101: '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
                k50: isTargetLegacy ? 23 : 45,
                kI1: 0,
                kI2: 0,
                kI3: 0,
                kI6: {
                    '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0,
                    '7': 0, '8': 0, '9': 0, '10': 0, '11': 0, '12': 0, '13': 0
                }
            };
            
            const finalLevelObject = { ...defaultNewLevel, ...levelObject };
            
            // ADD TO TOP (prepend by reconstructing object)
            if (!globalEditorSession.gdObject.LLM_01) globalEditorSession.gdObject.LLM_01 = {};
            globalEditorSession.gdObject.LLM_01 = {
                [newKey]: finalLevelObject,
                ...root
            };
        } else {
            // Replace existing level
            if (root[key]) {
                root[key] = { ...root[key], ...levelObject };
            }
        }
        
        globalEditorSession.isDirty = true;
        return { success: true };
    },

    // Add after existing setSong function
    setSong: async (key, songData) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        const l = globalEditorSession.gdObject.LLM_01[key]; 
        if(!l) return {success:false}; 
        
        // songData: { id: number, isCustom: boolean }
        if(songData.isCustom) { 
            l.k45 = parseInt(songData.id); 
            delete l.k8; 
        } else { 
            l.k8 = parseInt(songData.id); 
            delete l.k45; 
        } 
        
        globalEditorSession.isDirty = true; 
        return {success:true}; 
    },

    // NEW: Update description
    updateDescription: async (key, desc) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        const l = globalEditorSession.gdObject.LLM_01[key]; 
        if(!l) return {success:false}; 
        l.k3 = desc; 
        globalEditorSession.isDirty = true; 
        return {success:true}; 
    },

    // NEW: Update star request
    updateStarRequest: async (key, stars) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        const l = globalEditorSession.gdObject.LLM_01[key]; 
        if(!l) return {success:false}; 
        l.k66 = parseInt(stars) || 0; 
        globalEditorSession.isDirty = true; 
        return {success:true}; 
    },

    exportLevel: async (mainWindow, key, fmt) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        const l = globalEditorSession.gdObject.LLM_01[key]; 
        if(!l) return {success:false}; 
        let out = ""; 
        if(fmt === 'gmd'){
            out = `<d><k>k2</k><s>${l.k2}</s><k>k4</k><s>${l.k4}</s><k>k1</k><i>1</i><k>k50</k><i>24</i><k>kCEK</k><i>4</i></d>`;
        } else {
            out = GDCrypto.decryptLevelString(l.k4);
        } 
        const {canceled, filePath} = await dialog.showSaveDialog(mainWindow,{defaultPath:`${l.k2}.${fmt}`}); 
        if(!canceled){
            await fs.writeFile(filePath, out);
            return {success:true};
        } 
        return {success:false, error:'Cancelled'}; 
    },

    getXml: async () => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        return {success:true, data: GDParser.buildPretty(globalEditorSession.gdObject)}; 
    },

    saveXml: async (xml) => {
        if(!globalEditorSession.gdObject) return {success:false}; 
        try { 
            const parsed = GDParser.parse(xml);
            globalEditorSession.gdObject = parsed; 
            globalEditorSession.isDirty = true; 
            return {success:true}; 
        } catch(e){ return {success:false, error:e.message}; } 
    }
};