// server.js
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch'); // npm install node-fetch@2

const app = express();
const PORT = 3000;

// === Bunny config dari .env ===
// Contoh .env:
// BUNNY_STORAGE_HOST=storage.bunnycdn.com
// BUNNY_STORAGE_ZONE_NAME=mini-cloudinary
// BUNNY_STORAGE_API_KEY=PASSWORD_STORAGE_KAMU
// BUNNY_CDN_BASE_URL=https://mini-cloudinary-cdn.b-cdn.net
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST;            // biasanya: storage.bunnycdn.com
const BUNNY_STORAGE_ZONE_NAME = process.env.BUNNY_STORAGE_ZONE_NAME;  // nama storage zone kamu
const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;      // storage password
const BUNNY_CDN_BASE_URL = process.env.BUNNY_CDN_BASE_URL;            // host pull zone / cdn

console.log('Bunny host:', BUNNY_STORAGE_HOST);

// ==== Multer: simpan sementara ke folder temp ====
const tempDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const randomName = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, randomName + ext);
  }
});

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File harus berupa gambar (jpg, png, gif, webp).'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ==== Serve static frontend (public/index.html) ====
app.use(express.static(path.join(__dirname, 'public')));

// ==== Helper: upload file ke Bunny Storage via HTTP PUT ====
// Di sini kita pakai endpoint generik: https://storage.bunnycdn.com/{zoneName}/{fileName}
async function uploadToBunnyStorage(localFilePath, remoteFileName) {
  const url = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_ZONE_NAME}/${remoteFileName}`;

  const fileStream = fs.createReadStream(localFilePath);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'AccessKey': BUNNY_STORAGE_API_KEY,
      'Content-Type': 'application/octet-stream'
    },
    body: fileStream
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Respon Bunny:', res.status, text);
    throw new Error(`Gagal upload ke Bunny. Status: ${res.status}`);
  }

  // URL CDN final yang bakal dipakai di frontend
  const cdnUrl = `${BUNNY_CDN_BASE_URL}/${remoteFileName}`;
  return cdnUrl;
}

// ==== Endpoint /upload ====
// 1) terima file pakai Multer (temp lokal)
// 2) kirim ke Bunny Storage
// 3) hapus file temp
// 4) balikin URL CDN
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Tidak ada file yang diupload.' });
  }

  const localPath = req.file.path;
  const fileName = req.file.filename;

  try {
    const cdnUrl = await uploadToBunnyStorage(localPath, fileName);

    // hapus temp file
    fs.unlink(localPath, (err) => {
      if (err) console.error('Gagal hapus temp file:', err);
    });

    return res.json({
      message: 'Upload sukses!',
      fileName,
      url: cdnUrl      // ⚠️ sekarang ini FULL URL CDN
    });
  } catch (err) {
    console.error(err);
    fs.unlink(localPath, () => {});
    return res.status(500).json({ error: 'Gagal upload ke Bunny Storage.' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error handler:', err);
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
