require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const youtubeDl = require('yt-dlp-exec');
const archiver = require('archiver');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);
// --- TWIG AYARLARI ---
// 'public' klasörünü hem şablonların olduğu yer hem de statik yer olarak kullanıyoruz
app.set('views', path.join(__dirname, 'public'));
app.set('view engine', 'twig');

// --- MIDDLEWARES ---
app.use(cors());
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

app.get('/api/get-playlist-info', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('ID gerekli.');

    try {
        let allVideos = [];
        let nextPageToken = '';

        // Tüm sayfaları dolaşarak videoları topla
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

        res.json({ videos: allVideos });
    } catch (error) {
        console.error("Liste hatası:", error);
        res.status(500).json({ error: 'Liste alınamadı.' });
    }
});
// Playlist İndirme Endpoint'i
app.get('/api/download-playlist-zip', async (req, res) => {
    const playlistId = req.query.id;
    if (!playlistId) return res.status(400).send('Playlist ID gerekli.');

    try {
        let allVideos = [];
        let nextPageToken = '';

        // --- 1. TÜM VİDEOLARI LİSTELE (PAGINATION) ---
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

        console.log(`>>> Toplam ${allVideos.length} video için paralel indirme başlıyor...`);

        // --- 2. ZIP AYARLARI ---
        const archive = archiver('zip', { zlib: { level: 5 } });
        res.attachment(`StreamZip_Batch.zip`);
        archive.pipe(res);

        // --- 3. PARALEL İNDİRME VE PAKETLEME (CHUNK MANTIĞI) ---
        const concurrentLimit = 5; // Aynı anda inecek video sayısı
        
        for (let i = 0; i < allVideos.length; i += concurrentLimit) {
            const chunk = allVideos.slice(i, i + concurrentLimit);
            
            console.log(`>>> Grup işleniyor: ${i + 1} - ${Math.min(i + concurrentLimit, allVideos.length)}`);

            // Bu gruptaki videoları aynı anda başlatıyoruz
            await Promise.all(chunk.map(async (video) => {
                const tempFile = path.join(downloadsDir, `${video.id}.mp3`);
                const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
                const downloadCommand = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${tempFile}" "${videoUrl}"`;

                return new Promise((resolve) => {
                    exec(downloadCommand, (error, stdout, stderr) => {
                        if (!error && fs.existsSync(tempFile)) {
                            // Dosya tam indiğinde ZIP'e ekliyoruz
                            archive.append(fs.createReadStream(tempFile), { name: `${video.title}.mp3` });
                            console.log(`Eklendi: ${video.title}`);
                        } else {
                            console.error(`Hata: ${video.title}`, stderr);
                        }
                        resolve(); // Hata olsa da grubun kalanı için resolve et
                    });
                });
            }));
        }

        // --- 4. BİTİRİŞ VE TEMİZLİK ---
        console.log(">>> Tüm gruplar bitti. ZIP sonlandırılıyor...");
        archive.finalize();

        res.on('finish', () => {
            allVideos.forEach(v => {
                const p = path.join(downloadsDir, `${v.id}.mp3`);
                if (fs.existsSync(p)) {
                    try { fs.unlinkSync(p); } catch(e) {}
                }
            });
            console.log(">>> Geçici dosyalar temizlendi.");
        });

    } catch (error) {
        console.error('Genel Hata:', error);
        if (!res.headersSent) res.status(500).send('Sunucu hatası.');
    }
});

// Sunucu Başlatma
const server = app.listen(PORT, () => {
    console.log(`>>> StreamZip Sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});

// Timeout süresini 10 dakikaya çıkar (Büyük playlistler için)
server.timeout = 1200000;