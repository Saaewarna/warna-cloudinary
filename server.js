require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// === DATABASE MANAGEMENT ===
let DB = {
    users: [{ id: 1, username: 'admin', password: '123', apiKey: 'dev-key-123' }],
    assets: [],
    folders: [],
    userIdCounter: 2,
    assetIdCounter: 1,
    folderIdCounter: 1
};

if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        const parsed = JSON.parse(rawData);
        DB = { ...DB, ...parsed };
        if(!DB.folders) DB.folders = [];
    } catch (err) { console.error('Database error, reset default.'); }
} else { saveDB(); }

function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }
    catch (err) { console.error('Gagal save DB:', err); }
}

// === CONFIG BUNNY ===
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST;
const BUNNY_STORAGE_ZONE_NAME = process.env.BUNNY_STORAGE_ZONE_NAME;
const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;
// Bersihkan slash di belakang URL biar ga double
const BUNNY_CDN_BASE_URL = process.env.BUNNY_CDN_BASE_URL.replace(/\/+$/, "");

// === AUTH MIDDLEWARE ===
function apiAuth(req, res, next) {
    const key = req.header('x-api-key');
    if (!key) return res.status(401).json({ error: 'Login required' });
    const user = DB.users.find(u => u.apiKey === key);
    if (!user) return res.status(401).json({ error: 'Session Invalid' });
    req.user = user;
    next();
}

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = DB.users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ error: 'Login gagal' });
    res.json({ message: 'Login sukses', apiKey: user.apiKey, username: user.username });
});

// === UPLOAD HELPERS ===
const tempDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
        // Simpan sementara pakai random biar ga bentrok di server lokal
        const ext = path.extname(file.originalname);
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
});

const fileFilter = (req, file, cb) => {
    const isMimeTypeValid = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    if (isMimeTypeValid) return cb(null, true);
    return cb(new Error('Hanya file gambar dan video yang diperbolehkan!'));
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 100 * 1024 * 1024 }
});

function getSafeFolderName(username) {
    return username.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

// Fungsi bantu biar nama file asli aman (spasi jadi strip, dll)
function sanitizeFileName(originalName) {
    // Ambil nama tanpa ekstensi
    const ext = path.extname(originalName);
    const name = path.basename(originalName, ext);
    // Ganti karakter aneh dan spasi dengan strip, lalu tempel ekstensi lagi
    return name.replace(/[^a-z0-9]/gi, '-') + ext;
}

async function uploadToBunnyStorage(localPath, remoteName, folderName = '') {
    const storagePath = folderName ? `${BUNNY_STORAGE_ZONE_NAME}/${folderName}/${remoteName}` : `${BUNNY_STORAGE_ZONE_NAME}/${remoteName}`;
    const url = `https://${BUNNY_STORAGE_HOST}/${storagePath}`;
    const fileStream = fs.createReadStream(localPath);
    const res = await fetch(url, { method: 'PUT', headers: { 'AccessKey': BUNNY_STORAGE_API_KEY }, body: fileStream });
    if (!res.ok) throw new Error('Bunny Upload Failed');
    return `${BUNNY_CDN_BASE_URL}/${folderName ? folderName + '/' + remoteName : remoteName}`;
}

async function deleteFromBunnyStorage(remoteName, folderName = '') {
    const storagePath = folderName ? `${BUNNY_STORAGE_ZONE_NAME}/${folderName}/${remoteName}` : `${BUNNY_STORAGE_ZONE_NAME}/${remoteName}`;
    const url = `https://${BUNNY_STORAGE_HOST}/${storagePath}`;
    const res = await fetch(url, { method: 'DELETE', headers: { 'AccessKey': BUNNY_STORAGE_API_KEY } });
    if (!res.ok && res.status !== 404) throw new Error('Bunny Delete Failed');
}

// === LOGIC BARU: PROCESS & OPTIMIZE PILIHAN USER ===
async function processAndUpload(file, user, folderId = null, shouldOptimize = true) {
    let filePathToUpload = file.path;
    let finalFileName = sanitizeFileName(file.originalname); // Default pakai nama asli yang dibersihkan
    let isOptimized = false;
    let finalMimeType = file.mimetype;

    // Cek apakah User Minta Optimize (Compress) DAN filenya Gambar
    if (shouldOptimize === 'true' && file.mimetype.startsWith('image/')) {
        try {
            const imageProcessor = sharp(file.path, { animated: true })
                .resize(1000, null, { withoutEnlargement: true });

            // Kalau dicompress, kita kasih prefix 'opt-' biar tau ini hasil compress
            let outputFileName = 'opt-' + finalFileName; 
            let outputPath = path.join(tempDir, outputFileName);

            if (file.mimetype === 'image/png') {
                await imageProcessor.png({ quality: 80, compressionLevel: 8 }).toFile(outputPath);
            }
            else if (file.mimetype === 'image/jpeg') {
                await imageProcessor.jpeg({ quality: 80, mozjpeg: true }).toFile(outputPath);
            }
            else if (file.mimetype === 'image/gif') {
                await imageProcessor.gif({ reoptimise: true }).toFile(outputPath);
            }
            else {
                // Convert format lain ke JPG
                const nameWithoutExt = path.parse(finalFileName).name;
                outputFileName = 'opt-' + nameWithoutExt + '.jpg';
                outputPath = path.join(tempDir, outputFileName);
                await imageProcessor.jpeg({ quality: 80, mozjpeg: true }).toFile(outputPath);
                finalMimeType = 'image/jpeg';
            }

            filePathToUpload = outputPath;
            finalFileName = outputFileName; // Pakai nama baru yang ada 'opt-'
            isOptimized = true;

        } catch (error) {
            console.error('Optimasi gagal, pakai file original:', error);
            // Kalau gagal compress, lanjut upload original tanpa prefix opt-
        }
    }

    const userFolder = getSafeFolderName(user.username);
    const cdnUrl = await uploadToBunnyStorage(filePathToUpload, finalFileName, userFolder);

    // Hapus file temp
    fs.unlink(file.path, () => {});
    if (isOptimized) fs.unlink(filePathToUpload, () => {});

    return {
        id: DB.assetIdCounter++,
        userId: user.id,
        folderId: folderId ? parseInt(folderId) : null,
        fileName: finalFileName,
        folder: userFolder,
        url: cdnUrl,
        mimeType: finalMimeType,
        createdAt: new Date().toISOString()
    };
}

// === API ENDPOINTS ===

// Bulk Upload (Mendukung Single juga lewat sini)
app.post('/upload-bulk', apiAuth, (req, res) => {
    upload.array('images', 20)(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });

        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'Tidak ada file valid yang diupload' });

        const folderId = req.body.folderId || null;
        // Baca pilihan user (dikirim string 'true' atau 'false' dari frontend)
        const shouldOptimize = req.body.optimize; 

        const results = [];

        for (const file of files) {
            try {
                const asset = await processAndUpload(file, req.user, folderId, shouldOptimize);
                DB.assets.unshift(asset);
                results.push({ originalName: file.originalname, url: asset.url });
            } catch (e) {
                console.error(e);
                results.push({ originalName: file.originalname, error: 'Failed' });
                fs.unlink(file.path, () => {});
            }
        }
        saveDB();
        res.json({ message: 'Proses selesai', files: results });
    });
});

app.post('/upload', apiAuth, upload.single('image'), async (req, res) => {
    // Backup endpoint kalau pakai single upload biasa
    if (!req.file) return res.status(400).json({ error: 'No file' });
    try {
        const folderId = req.body.folderId || null;
        const shouldOptimize = req.body.optimize; 
        const asset = await processAndUpload(req.file, req.user, folderId, shouldOptimize);
        DB.assets.unshift(asset);
        saveDB();
        res.json({ message: 'Sukses', url: asset.url });
    } catch (err) { fs.unlink(req.file.path, () => {}); res.status(500).json({ error: err.message }); }
});

// Get Assets
app.get('/api/assets', apiAuth, (req, res) => {
    const currentFolderId = req.query.folderId ? parseInt(req.query.folderId) : null;
    const folders = DB.folders.filter(f => f.userId === req.user.id && f.parentId === (currentFolderId || null));
    const files = DB.assets.filter(a => a.userId === req.user.id && (a.folderId === currentFolderId || (!a.folderId && !currentFolderId)));
    let currentFolder = null;
    if (currentFolderId) {
        currentFolder = DB.folders.find(f => f.id === currentFolderId);
    }
    res.json({ folders, assets: files, currentFolder });
});

// Delete Asset
app.delete('/api/assets/:id', apiAuth, async (req, res) => {
    const assetId = parseInt(req.params.id);
    const index = DB.assets.findIndex(a => a.id === assetId);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    const asset = DB.assets[index];
    if (asset.userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    try {
        await deleteFromBunnyStorage(asset.fileName, asset.folder);
        DB.assets.splice(index, 1);
        saveDB();
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed delete' }); }
});

// Rename Asset
app.put('/api/assets/:id', apiAuth, async (req, res) => {
    const assetId = parseInt(req.params.id);
    const { newName } = req.body;
    const asset = DB.assets.find(a => a.id === assetId);
    if (!asset || asset.userId !== req.user.id) return res.status(404).json({ error: 'Not found' });

    const cleanName = sanitizeFileName(newName); // Bersihkan nama baru juga
    const tempPath = path.join(tempDir, `ren-${Date.now()}-${cleanName}`);
    try {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error('Download fail');
        await pipeline(response.body, fs.createWriteStream(tempPath));
        const newUrl = await uploadToBunnyStorage(tempPath, cleanName, asset.folder);
        await deleteFromBunnyStorage(asset.fileName, asset.folder);
        asset.fileName = cleanName; asset.url = newUrl;
        saveDB(); fs.unlink(tempPath, () => {});
        res.json({ message: 'Renamed', asset });
    } catch (err) { if(fs.existsSync(tempPath)) fs.unlink(tempPath, () => {}); res.status(500).json({ error: err.message }); }
});

// === FOLDER API ===
app.post('/api/folders', apiAuth, (req, res) => {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama folder wajib' });
    const newFolder = {
        id: DB.folderIdCounter++,
        userId: req.user.id,
        name,
        parentId: parentId ? parseInt(parentId) : null,
        createdAt: new Date().toISOString()
    };
    DB.folders.push(newFolder);
    saveDB();
    res.json(newFolder);
});

app.delete('/api/folders/:id', apiAuth, (req, res) => {
    const folderId = parseInt(req.params.id);
    const index = DB.folders.findIndex(f => f.id === folderId);
    if (index === -1) return res.status(404).json({ error: 'Folder not found' });
    if (DB.folders[index].userId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    DB.assets.forEach(a => { if (a.folderId === folderId) a.folderId = null; });
    DB.folders.splice(index, 1);
    saveDB();
    res.json({ message: 'Folder dihapus, isi dipindahkan ke Home' });
});

app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
});
