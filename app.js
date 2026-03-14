const path = require('path');
// Modül yollarını garantiye alıyoruz
process.env.NODE_PATH = path.join(__dirname, 'node_modules');
require('module').Module._initPaths();
require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const archiver = require('archiver');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const Datastore = require('nedb');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

// --- VERİTABANI TANIMLAMALARI ---
const db = new Datastore({ 
    filename: path.join(__dirname, 'database', 'licenses.db'), 
    autoload: true 
});
const ordersDb = new Datastore({ 
    filename: path.join(__dirname, 'database', 'orders.db'), 
    autoload: true 
});

const app = express();
const PORT = process.env.PORT || 3001;
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

// --- AYARLAR VE MIDDLEWARES ---
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'twig');

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Güvenlik Başlıkları (CSP)
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src * 'unsafe-inline' 'unsafe-eval'; " +
        "script-src * 'unsafe-inline' 'unsafe-eval'; " +
        "connect-src * 'unsafe-inline'; " +
        "img-src * data: blob: 'unsafe-inline'; " +
        "style-src * 'unsafe-inline';"
    );
    next();
});

// YouTube API Kurulumu
const youtube = google.youtube('v3');

// --- YARDIMCI FONKSİYONLAR ---
function generateLicenseKey(planType) {
    const prefix = "SZ-" + (planType ? planType.charAt(0).toUpperCase() : "X") + "-";
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    return prefix + randomPart;
}

// --- ROTALAR ---

app.get('/', (req, res) => {
    res.render('home'); 
});

// 1. PAYTR BİLDİRİM (CALLBACK) - Paranın Onaylandığı Yer
app.post('/callback/paytr', async (req, res) => {
    const { merchant_oid, status, total_amount, hash } = req.body;

    const paytr_key = process.env.PAYTR_MERCHANT_KEY;
    const paytr_salt = process.env.PAYTR_MERCHANT_SALT;
    const hash_string = merchant_oid + paytr_salt + status + total_amount;

    const expected_hash = crypto
        .createHmac('sha256', paytr_key)
        .update(hash_string)
        .digest('base64');

    if (hash !== expected_hash) {
        console.error("!!! GÜVENLİK UYARISI: Sahte Hash!");
        return res.send("HASH HATASI");
    }

    if (status === 'success') {
        // Emanetçiden (ordersDb) asıl bilgileri çekiyoruz
        ordersDb.findOne({ oid: merchant_oid }, (err, order) => {
            if (err || !order) {
                console.error("HATA: Sipariş emanetçide bulunamadı!", merchant_oid);
                return res.send("OK");
            }

            const user_email = order.email.toLowerCase().trim();
            const plan = order.plan || 'daily';
            const durationDays = (plan === 'monthly' ? 30 : (plan === 'lifetime' ? 36500 : 1));
            
            const newKey = generateLicenseKey(plan);
            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + durationDays);

            const licenseDoc = {
                key: newKey,
                oid: merchant_oid,
                email: user_email,
                plan: plan,
                active: true,
                expireDate: expireDate,
                createdAt: new Date()
            };

            db.insert(licenseDoc, (err) => {
                if (!err) {
                    console.log(`✅ Lisans Teslim Edildi: ${user_email} | Key: ${newKey}`);
                    ordersDb.update({ oid: merchant_oid }, { $set: { status: 'completed' } });
                }
            });
        });
    }
    res.send('OK');
});

// 2. ÖDEME BAŞLATMA (CREATE CHECKOUT)
app.post('/pay/create-checkout', async (req, res) => {
    try {
        let { email, planType } = req.body;
        if (!email) return res.status(400).send("Email gerekli.");
        
        email = email.trim().toLowerCase();
        const merchant_oid = "SZ" + Date.now(); // PayTR için temiz alfanümerik ID
        const prices = { daily: 4900, monthly: 14900, lifetime: 59900 };
        const amount = (prices[planType] || 4900).toString();

        // Bilgileri emanetçiye kaydediyoruz (Callback'te email'i geri almak için)
        ordersDb.insert({ 
            oid: merchant_oid, 
            email: email, 
            plan: planType, 
            status: 'pending',
            createdAt: new Date()
        });

        const merchant_id = process.env.PAYTR_MERCHANT_ID;
        const merchant_key = process.env.PAYTR_MERCHANT_KEY;
        const merchant_salt = process.env.PAYTR_MERCHANT_SALT;
        
        // IP Tespiti
        let user_ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "46.1.28.200";
        if (user_ip.includes(",")) user_ip = user_ip.split(",")[0].trim();
        if (user_ip === "::1" || user_ip === "127.0.0.1") user_ip = "46.1.28.200";

        const basket_price = (amount / 100).toFixed(2);
        const user_basket = Buffer.from(JSON.stringify([["Premium", basket_price, "1"]])).toString("base64");

        // Hash Payload (PayTR Standart Sıralama)
        const hash_payload = merchant_id + user_ip + merchant_oid + email + amount + user_basket + "00TL1";
        const paytr_token = crypto.createHmac("sha256", merchant_key).update(hash_payload + merchant_salt).digest("base64");

        const form = new FormData();
        form.append("merchant_id", merchant_id);
        form.append("user_ip", user_ip);
        form.append("merchant_oid", merchant_oid);
        form.append("email", email);
        form.append("payment_amount", amount);
        form.append("paytr_token", paytr_token);
        form.append("user_basket", user_basket);
        form.append("debug_on", "1");
        form.append("no_shipping", "1");
        form.append("currency", "TL");
        form.append("test_mode", "1");
        form.append("no_installment", "1");
        form.append("max_installment", "0");
        form.append("merchant_ok_url", `https://playlistzipmp3.com/success?email=${email}`);
        form.append("merchant_fail_url", "https://playlistzipmp3.com/fail");
        form.append("user_name", "Musteri");
        form.append("user_address", "Turkiye");
        form.append("user_phone", "05555555555");
        form.append("lang", "tr");

        const response = await axios.post("https://www.paytr.com/odeme/api/get-token", form, { headers: form.getHeaders() });

        if (response.data.status === "success") {
            res.render("pay", { token: response.data.token });
        } else {
            res.status(500).send(`PayTR Hatası: ${response.data.reason}`);
        }
    } catch (error) {
        console.error("Checkout Sistem Hatası:", error.message);
        res.status(500).send("İşlem şu an gerçekleştirilemiyor.");
    }
});

// 3. BAŞARI SAYFASI (SUCCESS)
app.get('/success', (req, res) => {
    const email = req.query.email ? req.query.email.toLowerCase().trim() : null;
    if (!email) return res.redirect('/');

    db.find({ email: email, active: true }).sort({ createdAt: -1 }).limit(1).exec((err, docs) => {
        if (docs && docs.length > 0) {
            res.render('success', { 
                status: 'success',
                licenseKey: docs[0].key,
                expireDate: docs[0].expireDate
            });
        } else {
            res.render('success', { status: 'waiting', email: email });
        }
    });
});

// 4. LİSANS DOĞRULAMA API (FRONTEND İÇİN)
app.get('/api/verify-license', (req, res) => {
    const userKey = req.query.key ? req.query.key.trim() : null;
    const userEmail = req.query.email ? req.query.email.trim().toLowerCase() : null;

    if (!userKey || !userEmail) {
        return res.json({ valid: false, message: "Anahtar ve e-posta gerekli." });
    }

    db.findOne({ key: userKey, email: userEmail, active: true }, (err, doc) => {
        if (err || !doc) return res.json({ valid: false, message: "Geçersiz lisans bilgisi." });

        const now = new Date();
        if (now > new Date(doc.expireDate)) return res.json({ valid: false, message: "Lisans süresi dolmuş." });

        res.json({ valid: true, plan: doc.plan });
    });
});

// 5. PLAYLIST BİLGİSİ ALMA
app.get('/api/get-playlist-info', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('ID gerekli.');

    try {
        const playlistMeta = await youtube.playlists.list({
            key: process.env.YOUTUBE_API_KEY,
            part: 'snippet',
            id: id
        });

        const rawTitle = playlistMeta.data.items[0]?.snippet.title || "Playlist";
        const sanitizedTitle = rawTitle.replace(/[\\/*?:"<>|]/g, "_");

        let allVideos = [];
        let nextPageToken = '';

        do {
            const ytRes = await youtube.playlistItems.list({
                key: process.env.YOUTUBE_API_KEY,
                part: 'snippet',
                playlistId: id,
                maxResults: 50,
                pageToken: nextPageToken
            });

            const fetchedVideos = ytRes.data.items.map(item => ({
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
                videoId: item.snippet.resourceId.videoId
            }));

            allVideos = [...allVideos, ...fetchedVideos];
            nextPageToken = ytRes.data.nextPageToken;
        } while (nextPageToken);

        res.json({ playlistTitle: sanitizedTitle, videos: allVideos });

    } catch (error) {
        console.error("Playlist info hatası:", error);
        res.status(500).json({ error: 'Liste bilgileri alınamadı.' });
    }
});

// 6. ZIP İNDİRME MOTORU
app.get('/api/download-playlist-zip', async (req, res) => {
    const playlistId = req.query.id;
    const licenseKey = req.query.key;
    const userEmail = req.query.email ? req.query.email.trim().toLowerCase() : null;

    if (!playlistId) return res.status(400).send('Playlist ID gerekli.');

    try {
        const playlistMeta = await youtube.playlists.list({
            key: process.env.YOUTUBE_API_KEY,
            part: 'snippet',
            id: playlistId
        });

        const rawTitle = playlistMeta.data.items[0]?.snippet.title || "Playlist";
        const sanitizedTitle = rawTitle.replace(/[\\/*?:"<>|]/g, "_");

        // Lisans ve Hız Ayarları
        let isValidLicense = false;
        let audioQuality = '5'; // Standart
        let concurrentLimit = 1;

        if (licenseKey && userEmail) {
            const license = await new Promise((resolve) => {
                db.findOne({ key: licenseKey, email: userEmail, active: true }, (err, doc) => resolve(doc));
            });

            if (license && (new Date() < new Date(license.expireDate))) {
                isValidLicense = true;
                audioQuality = '0'; // 320kbps
                concurrentLimit = 5; // Turbo Hız
            }
        }

        console.log(`>>> İndirme Başladı: ${isValidLicense ? '🚀 VIP' : '🐌 Standart'}`);

        let allVideos = [];
        let nextPageToken = '';
        do {
            const ytRes = await youtube.playlistItems.list({
                key: process.env.YOUTUBE_API_KEY,
                part: 'snippet',
                playlistId: playlistId,
                maxResults: 50,
                pageToken: nextPageToken
            });
            const fetched = ytRes.data.items.map(item => ({
                id: item.snippet.resourceId.videoId,
                title: item.snippet.title.replace(/[\\/*?:"<>|]/g, "_")
            }));
            allVideos = [...allVideos, ...fetched];
            nextPageToken = ytRes.data.nextPageToken;
        } while (nextPageToken);

        const archive = archiver('zip', { zlib: { level: 5 } });
        res.attachment(`${sanitizedTitle}.zip`);
        archive.pipe(res);

        const tempFiles = [];
        for (let i = 0; i < allVideos.length; i += concurrentLimit) {
            const chunk = allVideos.slice(i, i + concurrentLimit);
            await Promise.all(chunk.map(async (video) => {
                const tempFileName = `${video.id}_${Date.now()}.mp3`;
                const tempFilePath = path.join(downloadsDir, tempFileName);
                const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                
                const cmd = `yt-dlp -x --audio-format mp3 --audio-quality ${audioQuality} -o "${tempFilePath}" "${videoUrl}"`;

                return new Promise((resolve) => {
                    exec(cmd, (error) => {
                        if (!error && fs.existsSync(tempFilePath)) {
                            archive.append(fs.createReadStream(tempFilePath), { name: `${video.title}.mp3` });
                            tempFiles.push(tempFilePath);
                        }
                        resolve(); 
                    });
                });
            }));
        }

        await archive.finalize();

        res.on('finish', () => {
            tempFiles.forEach(file => {
                if (fs.existsSync(file)) fs.unlink(file, () => {});
            });
        });

    } catch (error) {
        console.error('Download hatası:', error);
        if (!res.headersSent) res.status(500).send('İndirme başlatılamadı.');
    }
});

// Sunucuyu Ateşle
const server = app.listen(PORT, () => {
    console.log(`>>> StreamZip Sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});

server.timeout = 1200000; // 20 Dakika