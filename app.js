const path = require('path');
process.env.NODE_PATH = path.join(__dirname, 'node_modules');
require('module').Module._initPaths();
require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const youtubeDl = require('yt-dlp-exec');
const archiver = require('archiver');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const Datastore = require('nedb');
const qs = require('qs');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

// Veritabanları (NeDB)
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
// --- TWIG AYARLARI ---
// 'public' klasörünü hem şablonların olduğu yer hem de statik yer olarak kullanıyoruz
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'twig');

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public')); // CSS, Resim vb. dosyalar için

// CSP Başlıkları
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
// --- ROTALAR ---

// Ana sayfa yönlendirmesi (home.twig dosyasını render eder)
app.get('/', (req, res) => {
    res.render('home'); 
});

// API Key (Burayı kendi keyinle doldurmalısın)
const API_KEY = process.env.YOUTUBE_API_KEY; 
const youtube = google.youtube('v3');


app.post('/callback/paytr', async (req, res) => {
    // PayTR'den gelen veriler
    const { merchant_oid, status, total_amount, hash } = req.body;

    // 1. GÜVENLİK: Gelen mesaj gerçekten PayTR'den mi geliyor? (Hash Kontrolü)
    const paytr_key = process.env.PAYTR_MERCHANT_KEY;
    const paytr_salt = process.env.PAYTR_MERCHANT_SALT;
    const hash_string = merchant_oid + paytr_salt + status + total_amount;

    const expected_hash = crypto
    .createHmac('sha256', paytr_key)
    .update(hash_string)
    .digest('base64');

    if (hash !== expected_hash) {
        console.error("!!! GÜVENLİK UYARISI: Sahte PayTR Bildirimi!");
        return res.send("HASH HATASI");
    }

  if (status === 'success') {
        // Emanetçiden (ordersDb) e-postayı çekiyoruz
        ordersDb.findOne({ oid: merchant_oid }, (err, order) => {
            if (err || !order) {
                console.error("HATA: Sipariş bulunamadı!", merchant_oid);
                return res.send("OK");
            }

            const user_email = order.email;
            
            // Artık lisansı bu e-posta üzerine kaydedebiliriz
            const newKey = generateLicenseKey(order.plan);
            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + (order.plan === 'monthly' ? 30 : 1));

            const licenseDoc = {
                key: newKey,
                oid: merchant_oid,
                email: user_email, // E-posta artık emanetçiden geldi!
                plan: order.plan,
                active: true,
                expireDate: expireDate,
                createdAt: new Date()
            };

            db.insert(licenseDoc, (err) => {
                if (!err) {
                    console.log(`✅ Lisans Teslim Edildi: ${user_email}`);
                    // İsteğe bağlı: Siparişi tamamlandı olarak işaretle
                    ordersDb.update({ oid: merchant_oid }, { $set: { status: 'completed' } });
                }
            });
        });

        return res.send('OK');
    }
    res.send('OK');
});
app.post('/pay/create-checkout', async (req, res) => {
try {

let { email, planType } = req.body
if (!email) return res.status(400).send("Email adresi gerekli.");
email = (email || "test@test.com").trim().toLowerCase()

const prices = {
daily: 4900,
monthly: 14900,
lifetime: 59900
}

const amount = (prices[planType] || 4900).toString()

// PAYTR BİLGİLERİ
const merchant_id = process.env.PAYTR_MERCHANT_ID
const merchant_key = process.env.PAYTR_MERCHANT_KEY
const merchant_salt = process.env.PAYTR_MERCHANT_SALT

const merchant_oid = "SZ" + Date.now();

ordersDb.insert({ 
    oid: merchant_oid, 
    email: email, 
    plan: planType, 
    status: 'pending' 
}, (err) => {
    if (err) console.error("Sipariş Kayıt Hatası:", err);
});

// IP
let user_ip =
req.headers["x-forwarded-for"] ||
req.socket.remoteAddress ||
req.ip ||
""

if (user_ip.includes(",")) user_ip = user_ip.split(",")[0]

if (user_ip === "::1" || user_ip === "127.0.0.1") {
user_ip = "46.1.28.200"
}

// SEPET
const basket_price = (amount / 100).toFixed(2)

const user_basket = Buffer.from(
JSON.stringify([["Premium", basket_price, "1"]])
).toString("base64")

const no_shipping = "1"
const currency = "TL"
const test_mode = "1"
const no_installment = "1"
const max_installment = "0"

// HASH
const hash_payload =
merchant_id +
user_ip +
merchant_oid +
email +
amount +
user_basket +
no_installment +
max_installment +
currency +
test_mode

console.log("FORM DATA:", {
merchant_id,
user_ip,
merchant_oid,
email,
payment_amount: amount,
user_basket,
currency,
test_mode
})

console.log("HASH PAYLOAD:", hash_payload)

const paytr_token = crypto
.createHmac("sha256", merchant_key)
.update(hash_payload + merchant_salt)
.digest("base64")

console.log("PAYTR TOKEN:", paytr_token)

const merchant_ok_url = `https://playlistzipmp3.com/success?email=${email}`;

// FORM DATA
const form = new FormData()

form.append("merchant_id", merchant_id)
form.append("user_ip", user_ip)
form.append("merchant_oid", merchant_oid)
form.append("email", email)
form.append("payment_amount", amount)
form.append("paytr_token", paytr_token)
form.append("user_basket", user_basket)
form.append("debug_on", "1")
form.append("no_shipping", no_shipping)
form.append("coupon_code", "")
form.append("no_installment", no_installment)
form.append("max_installment", max_installment)
form.append("wait_page_load", "1")
form.append("timeout_limit", "30")
form.append("currency", currency)
form.append("test_mode", test_mode)
form.append("merchant_ok_url", merchant_ok_url);
form.append("merchant_fail_url", "https://playlistzipmp3.com/fail")
form.append("user_name", "Musteri")
form.append("user_address", "Turkiye")
form.append("user_phone", "05555555555")
form.append("lang", "tr")

// PAYTR REQUEST
let response

try {

response = await axios.post(
"https://www.paytr.com/odeme/api/get-token",
form,
{ headers: form.getHeaders() }
)

console.log("PAYTR RESPONSE:", response.data)

} catch (err) {

console.log("AXIOS ERROR:", err.response?.data || err.message)
return res.status(500).send("PayTR bağlantı hatası")

}

// RESPONSE KONTROL
if (response.data.status === "success") {

return res.render("pay", {
token: response.data.token
})

} else {

console.log("HATA SEBEBİ:", response.data.reason)
return res.status(500).send(`Hata: ${response.data.reason}`)

}

} catch (error) {

console.error("Sistem Hatası:", error.message)
return res.status(500).send("İşlem başarısız.")

}
})
function generateLicenseKey(planType) {
    // Plan türüne göre belki bir harf ekleriz: D (Daily), M (Monthly), L (Lifetime)
    const prefix = "SZ-" + planType.charAt(0).toUpperCase() + "-";
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase(); // Örn: 1A2B3C4D
    return prefix + randomPart;
}
// Örnek çıktı: DAY-A1B2C3D4-E5F6
app.get('/success', (req, res) => {
    const email = req.query.email ? req.query.email.toLowerCase().trim() : null;

    if (!email) return res.redirect('/');

    // Email ile eşleşen en son AKTİF lisansı bul
    db.find({ email: email, active: true }).sort({ createdAt: -1 }).limit(1).exec((err, docs) => {
        if (docs && docs.length > 0) {
            res.render('success', { 
                status: 'success',
                licenseKey: docs[0].key,
                expireDate: docs[0].expireDate
            });
        } else {
            // Eğer hala bulunamadıysa (saniyelik gecikme) bekleme moduna devam
            res.render('success', { status: 'waiting', email: email });
        }
    });
});
app.get('/api/check-license', (req, res) => {
    const key = req.query.key;
    db.findOne({ key: key }, (err, license) => {
        if (license && new Date() < new Date(license.expireDate)) {
            res.json({ isValid: true, plan: license.plan });
        } else {
            res.json({ isValid: false });
        }
    });
});
app.get('/api/get-playlist-info', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('ID gerekli.');

    try {
        // --- 1. ÖNCE PLAYLIST BAŞLIĞINI ALALIM (Döngü Dışında) ---
        const playlistMeta = await youtube.playlists.list({
            key: process.env.YOUTUBE_API_KEY,
            part: 'snippet',
            id: id
        });

        const rawTitle = playlistMeta.data.items[0]?.snippet.title || "Bilinmeyen Liste";
        const sanitizedTitle = rawTitle.replace(/[\\/*?:"<>|]/g, "_");

        // --- 2. VİDEOLARI TOPLAYALIM ---
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

        // --- 3. HEM BAŞLIĞI HEM VİDEOLARI DÖNDÜRELİM ---
        res.json({ 
            playlistTitle: sanitizedTitle, 
            videos: allVideos 
        });

    } catch (error) {
        console.error("Liste hatası:", error);
        res.status(500).json({ error: 'Liste alınamadı.' });
    }
});
// Playlist İndirme Endpoint'i
app.get('/api/download-playlist-zip', async (req, res) => {
    const playlistId = req.query.id;
    const licenseKey = req.query.key;

    if (!playlistId) return res.status(400).send('Playlist ID gerekli.');

    try {
        const playlistMeta = await youtube.playlists.list({
            key: process.env.YOUTUBE_API_KEY,
            part: 'snippet',
            id: playlistId
        });

        const rawTitle = playlistMeta.data.items[0]?.snippet.title || "Playlist";
        const sanitizedTitle = rawTitle.replace(/[\\/*?:"<>|]/g, "_");
        // --- 0. LİSANS KONTROLÜ (Callback'ten Promise'e Dönüştürüldü) ---
        let isValidLicense = false;
        let audioQuality = '5'; // Standart: ~128kbps
        let concurrentLimit = 1; // Standart: Tek tek

        if (licenseKey) {
            // NeDB findOne işlemini await ile bekleyebilmek için:
            const license = await new Promise((resolve) => {
                db.findOne({ key: licenseKey, active: true }, (err, doc) => resolve(doc));
            });

            const now = new Date();
            if (license && now < new Date(license.expireDate)) {
                isValidLicense = true;
                audioQuality = '0'; // VIP: 320kbps (En yüksek)
                concurrentLimit = 5; // VIP: Aynı anda 5 indirme (Turbo Hız)
            }
        }

        console.log(`>>> İstek Alındı: ${isValidLicense ? '🚀 VIP (Turbo)' : '🐌 Standart'}`);

        // --- 1. TÜM VİDEOLARI LİSTELE ---
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

            const fetchedVideos = ytRes.data.items.map(item => ({
                id: item.snippet.resourceId.videoId,
                title: item.snippet.title.replace(/[\\/*?:"<>|]/g, "_")
            }));

            allVideos = [...allVideos, ...fetchedVideos];
            nextPageToken = ytRes.data.nextPageToken;
        } while (nextPageToken);

        // --- 2. ZIP AYARLARI ---
        const archive = archiver('zip', { zlib: { level: 5 } });

        // Artık dosya ismi dinamik: "Playlist_Ismi.zip"
        res.attachment(`${sanitizedTitle}.zip`);

        archive.pipe(res);

        // Geçici dosyaları takip etmek için bir dizi
        const tempFiles = [];

        // --- 3. PARALEL İNDİRME (VIP HIZI BURADA DEVREYE GİRİYOR) ---
        for (let i = 0; i < allVideos.length; i += concurrentLimit) {
            const chunk = allVideos.slice(i, i + concurrentLimit);
            
            await Promise.all(chunk.map(async (video) => {
                const tempFileName = `${video.id}_${Date.now()}.mp3`;
                const tempFilePath = path.join(downloadsDir, tempFileName);
                const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                
                // VIP ise 320kbps, Standart ise 128kbps indirir
                const downloadCommand = `yt-dlp -x --audio-format mp3 --audio-quality ${audioQuality} -o "${tempFilePath}" "${videoUrl}"`;

                return new Promise((resolve) => {
                    exec(downloadCommand, (error) => {
                        if (!error && fs.existsSync(tempFilePath)) {
                            archive.append(fs.createReadStream(tempFilePath), { name: `${video.title}.mp3` });
                            tempFiles.push(tempFilePath); // Silinmek üzere listeye ekle
                        }
                        resolve(); 
                    });
                });
            }));
        }

        await archive.finalize();

        // --- 4. TEMİZLİK (İndirme bittikten sonra geçici dosyaları siler) ---
        res.on('finish', () => {
            console.log(">>> ZIP Gönderildi. Temizlik yapılıyor...");
            tempFiles.forEach(file => {
                if (fs.existsSync(file)) {
                    fs.unlink(file, (err) => { if (err) console.error("Silme hatası:", err); });
                }
            });
        });

    } catch (error) {
        console.error('Genel Hata:', error);
        if (!res.headersSent) res.status(500).send('Sunucu hatası.');
    }
});

app.get('/api/verify-license', (req, res) => {
    const { key, email } = req.query;
    
    // Eksik bilgi uyarısını burada bitiriyoruz
    if (!key || !email) {
        return res.json({ valid: false, message: "Anahtar ve e-posta adresi eksik." });
    }

    db.findOne({ 
        key: key.trim(), 
        email: email.trim().toLowerCase(), 
        active: true 
    }, (err, doc) => {
        if (err || !doc) return res.json({ valid: false, message: "Geçersiz lisans veya e-posta." });
        
        if (new Date() > new Date(doc.expireDate)) {
            return res.json({ valid: false, message: "Lisans süresi dolmuş." });
        }
        
        res.json({ valid: true, plan: doc.plan });
    });
});
// Sunucu Başlatma
const server = app.listen(PORT, () => {
    console.log(`>>> StreamZip Sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});



// Timeout süresini 10 dakikaya çıkar (Büyük playlistler için)
server.timeout = 1200000;