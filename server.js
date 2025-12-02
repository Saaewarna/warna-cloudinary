// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch'); // npm install node-fetch@2

const app = express();
const PORT = 3000;

// === Bunny config dari .env ===
// BUNNY_STORAGE_HOST=storage.bunnycdn.com
// BUNNY_STORAGE_ZONE_NAME=mini-cloudinary
// BUNNY_STORAGE_API_KEY=PASSWORD_STORAGE_KAMU
// BUNNY_CDN_BASE_URL=https://mini-cloudinary.b-cdn.net
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST;            // biasanya: storage.bunnycdn.com
const BUNNY_STORAGE_ZONE_NAME = process.env.BUNNY_STORAGE_ZONE_NAME;  // nama storage zone kamu
const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;      // storage password
const BUNNY_CDN_BASE_URL = process.env.BUNNY_CDN_BASE_URL;            // host pull zone / cdn

console.log('Bunny host:', BUNNY_STORAGE_HOST);

// ==== Middleware global ====
app.use(cors()); // izinkan akses dari mana saja (bisa dibatasi ke domain tertentu nanti)
app.use(express.static(path.join(__dirname, 'public')));

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
  const allowedImages = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideos = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',    // .mov
    'video/x-matroska'    // .mkv
  ];

  if (allowedImages.includes(file.mimetype) || allowedVideos.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File harus berupa gambar (jpg, png, gif, webp) atau video (mp4, webm, ogg, mov, mkv).'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB per file (boleh lo kecilin / gedein)
    files: 10                   // MAX 10 files per request
  }
});

// ==== Helper: upload file ke Bunny Storage via HTTP PUT ====
// Endpoint: https://storage.bunnycdn.com/{zoneName}/{fileName}
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

// ==== Endpoint SINGLE /upload ====
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
      url: cdnUrl // FULL URL CDN
    });
  } catch (err) {
    console.error(err);
    fs.unlink(localPath, () => {});
    return res.status(500).json({ error: 'Gagal upload ke Bunny Storage.' });
  }
});

// ==== Endpoint BULK /upload-bulk (max 10 file) ====
app.post('/upload-bulk', (req, res) => {
  // gunakan upload.array → field name: "images"
  upload.array('images', 10)(req, res, async (err) => {
    if (err) {
      console.error('Error Multer bulk:', err);
      return res.status(400).json({ error: err.message });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Tidak ada file yang diupload.' });
    }

    const results = [];

    try {
      // proses tiap file → upload ke Bunny
      for (const file of files) {
        const localPath = file.path;
        const fileName = file.filename;

        try {
          const cdnUrl = await uploadToBunnyStorage(localPath, fileName);
        results.push({
        originalName: file.originalname,
        fileName,
        url: cdnUrl,
        mimeType: file.mimetype
        });
        } catch (e) {
          console.error('Gagal upload satu file ke Bunny:', e.message);
            results.push({
            originalName: file.originalname,
            fileName,
            url: null,
            error: 'Gagal upload ke Bunny'
            });
        } finally {
          // hapus temp file apapun hasilnya
          fs.unlink(localPath, (err) => {
            if (err) console.error('Gagal hapus temp file:', err);
          });
        }
      }

      return res.json({
        message: `Upload ${results.length} file selesai`,
        files: results
      });
    } catch (e) {
      console.error('Error umum bulk upload:', e);
      return res.status(500).json({ error: 'Terjadi error saat bulk upload.' });
    }
  });
});

// ==== Error handler (paling akhir sebelum listen) ====
app.use((err, req, res, next) => {
  console.error('Error handler:', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(400).json({ error: err.message || 'Terjadi error.' });
});

// ==== Start server ====
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
