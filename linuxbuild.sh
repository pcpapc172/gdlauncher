#!/bin/bash
set -e # Exit immediately if any command fails

# --- FORCE LOAD NVM ---
# WSL non-interactive shells don't load .bashrc fully. We manually load NVM here.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
elif [ -s "/usr/local/nvm/nvm.sh" ]; then
    . "/usr/local/nvm/nvm.sh"
else
    # Fallback: try sourcing bashrc/profile if NVM isn't found in standard spots
    source ~/.bashrc 2>/dev/null || source ~/.profile 2>/dev/null
fi

# --- NODE VERSION CHECK ---
echo "🔍 Checking Node.js version..."
# Ensure 'node' is in the path
if ! command -v node &> /dev/null; then
    echo "❌ ERROR: Node.js not found in PATH."
    echo "   Ensure NVM is installed or Node is in your path."
    exit 1
fi

NODE_VER=$(node -v)
echo "   - Current Node version: $NODE_VER"

if [[ "$NODE_VER" == v10* ]] || [[ "$NODE_VER" == v12* ]]; then
    echo "❌ ERROR: Your script is picking up an old Node.js version ($NODE_VER)."
    echo "   Please uninstall the system node inside WSL: 'sudo apt remove nodejs'"
    exit 1
fi

# --- CONFIGURATION ---
# Windows Path (converted to WSL format)
WIN_SOURCE="/mnt/c/Users/asus/Documents/gdlele"
# Linux Working Directory (Fast I/O)
WSL_WORK_DIR="$HOME/gdlele"

# Files to copy
FILES=(
    "icon.ico"
    "icon.png"
    "index.html"
    "main.js"
    "editor.js"
    "package.json"
    "preload.js"
    "renderer.js"
    "styles.css"
)

# --- SCRIPT START ---
echo "🚀 Starting Linux Build Process..."

# 1. Prepare Linux Directory
echo "🧹 Cleaning previous build workspace ($WSL_WORK_DIR)..."
rm -rf "$WSL_WORK_DIR"
mkdir -p "$WSL_WORK_DIR"

# 2. Copy Source Files from Windows to Linux
echo "📂 Copying source files to WSL..."
for file in "${FILES[@]}"; do
    if [ -f "$WIN_SOURCE/$file" ]; then
        cp "$WIN_SOURCE/$file" "$WSL_WORK_DIR/"
    else
        echo "⚠️ Warning: $file not found in source directory!"
    fi
done

# 3. Switch to Linux Directory
cd "$WSL_WORK_DIR"

# 4. Install Dependencies
echo "📦 Installing npm dependencies..."
npm install --verbose

# 5. Build for Linux (Debian Package)
echo "🔨 Building .deb package..."
npm run build -- --linux deb

# 6. Move Artifacts back to Windows
echo "🚚 Moving built files back to Windows..."
mkdir -p "$WIN_SOURCE/dist"

if ls dist/*.deb 1> /dev/null 2>&1; then
    cp -r dist/*.deb "$WIN_SOURCE/dist/"
    echo "✅ Done! Check your Windows folder: $WIN_SOURCE/dist"
else
    echo "❌ Build finished but no .deb file was found!"
    exit 1
fi