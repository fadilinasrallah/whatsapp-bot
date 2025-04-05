/**
 * WhatsApp Group Moderator Bot – Revised for Multiple Groups, Statistics,
 * and Admin notifications without user removal on spam or badword detection.
 * - Detects badwords via regex.
 * - For spamming: Sends a warning at count 8 and, if count > 10, notifies admin without removal.
 * - For badwords: Notifies admin without deleting the message or removing the user.
 * - Notifications include the group name (to work in multiple groups) and random text.
 * - An Express web server on port 8000 shows statistics grouped by groups and members.
 */

const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');

// ----- DEBUG flag -----
const DEBUG = false;

// ----- Configuration -----
const config = {
    // Notification admin's WhatsApp number (in international format without symbols).
    notificationNumber: "212767619990",
    // Regex to detect badwords.
    messageRegex: /zeb|zob|zab|زب/i,
    retry: {
        maxAttempts: 3,
        delayMs: 1000
    }
};

const stop = [
    `wa l9lawi"`,
    `wa zab`,
    `n3al zaml bok`,
    `lay7r9 tbon mok`,
    `ya wjh sowa`
];

const keep = [
    `7bas`,
    `3ya`,
    `tcalma`,
    `baraka`
];

const out = [
    `rak 7witi lia notif`,
    `rak fr3ati lia kari`,
    `rak 7witi lia tele`,
    `ra an7wi mok`
];

const A = [
    `malik`,
    `sidi`,
    `nasro`,
    `moulay`
]

const horny = [
    `ay zab`,
    `matb9ach tkhsr hadra`,
    `7choma lach 9olti zab`,
    `zab dyalmn`,
    `chmn zab dwiti 3lih`,
    `wach ki3jbk zab`,
    `zboba homa`
]

const LOG_FILE_PATH = "./bot.log";

// ----- Logger Module -----
function log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE_PATH, logEntry, 'utf-8');
    console.log(logEntry.trim());
}

// ----- Global Statistics Object -----
// Structure: { [groupId]: { groupName, members: { [memberId]: { name, number, messages, spams, badwords } } } }
const stats = {};

// ----- WhatsApp Client Setup -----
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "whatsapp-bot" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// ----- Global Spam Tracker -----
// Structure for each sender (keyed by sender id):
// { texts: { normalizedText: [timestamps] }, media: [timestamps] }
const spamTracker = {};

// ----- Utility Functions -----
async function retryOperation(operationFn, description) {
    let attempt = 1;
    const maxAttempts = config.retry.maxAttempts;
    const delay = config.retry.delayMs;
    while (attempt <= maxAttempts) {
        try {
            return await operationFn();
        } catch (error) {
            log(`Failure during "${description}" (attempt ${attempt}/${maxAttempts}): ${error.message}`);
            if (attempt++ < maxAttempts) await new Promise(res => setTimeout(res, delay));
        }
    }
    throw new Error(`Operation failed after ${maxAttempts} attempts`);
}

async function getSenderInfo(msg) {
    try {
        const contact = await msg.getContact();
        const senderId = contact.id._serialized;
        let number = (contact.number && contact.number.trim() !== "") ? contact.number : contact.id.user;
        return {
            id: senderId,
            name: contact.pushname || number,
            number: number,
            contact: contact
        };
    } catch (error) {
        log(`Error getting sender info: ${error.message}`);
        return { id: msg.from, name: 'Unknown', number: 'Unknown' };
    }
}

// Updated to use the dynamic chat object.
async function isGroupAdmin(chat, senderId) {
    try {
        const participant = chat.participants.find(
            p => p.id._serialized === senderId
        );
        return participant ? participant.isAdmin : false;
    } catch (error) {
        log(`Admin check error for ${senderId}: ${error.message}`);
        return false;
    }
}

// ----- Statistics Update -----
// Now stores the sender's phone number along with other stats.
function updateStats(chat, sender, field) {
    const groupId = chat.id._serialized;
    if (!stats[groupId]) {
        stats[groupId] = { groupName: chat.name, members: {} };
    }
    if (!stats[groupId].members[sender.id]) {
        stats[groupId].members[sender.id] = { 
            name: sender.name, 
            number: sender.number, 
            messages: 0, 
            spams: 0, 
            badwords: 0 
        };
    }
    if (stats[groupId].members[sender.id][field] !== undefined) {
        stats[groupId].members[sender.id][field]++;
    }
}

// ----- Random Text Generator for Notifications -----
function getRandomText() {
    const randomParts = [
        stop[Math.floor(Math.random() * stop.length)],
        keep[Math.floor(Math.random() * keep.length)],
        out[Math.floor(Math.random() * out.length)]
    ];
    return randomParts.join(' ');
}

function getRandomTextAdmin() {
    const randomParts = [
        A[Math.floor(Math.random() * A.length)],
        A[Math.floor(Math.random() * A.length)],
        A[Math.floor(Math.random() * A.length)]
    ];
    return randomParts.join(' ');
}

// ----- Admin Notification -----
async function sendAdminNotification(chat, sender, reason, additionalInfo = "") {
    const notifyId = `${config.notificationNumber}@c.us`;
    const randomText = getRandomTextAdmin();
    const notificationText = 
        `${randomText} Alert: User *${sender.name}* (${sender.number}) in group "*${chat.name}*" ${reason}.\n${additionalInfo}`;
    await client.sendMessage(notifyId, notificationText);
}

// ----- Restricted Message Processing (Badword Detection) -----
// Instead of deleting the message or removing the user, only notify admin.
async function processRestrictedMessage(msg) {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        if (msg.fromMe || !config.messageRegex.test(msg.body)) return;
        const sender = await getSenderInfo(msg);
        if (await isGroupAdmin(chat, sender.id)) {
            log(`Admin ${sender.name} (${sender.number}) sent restricted message - IGNORED`);
            return;
        }
        const reason = "sent restricted content";
        const additionalInfo = `Offending message: "${msg.body}"`;
        log(`Processing restricted message from ${sender.name} (${sender.number}) in group ${chat.name}`);
        updateStats(chat, sender, 'badwords');
        const mentionText = `@${sender.contact.id.user}`;
        await chat.sendMessage(`${mentionText} ${horny[Math.floor(Math.random() * horny.length)]}`, { mentions: [sender.contact] });
        await sendAdminNotification(chat, sender, reason, additionalInfo);
    } catch (error) {
        log(`Restricted message processing error: ${error.message}`);
    }
}

// ----- Anti-Spam Processing -----
// Instead of removing the user, when thresholds are exceeded a notification is sent.
async function processSpam(msg) {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup || msg.fromMe) return;
        const sender = await getSenderInfo(msg);
        if (await isGroupAdmin(chat, sender.id)) return;
        const now = Date.now();
        const windowMs = 60000; // 1 minute

        if (!spamTracker[sender.id]) {
            spamTracker[sender.id] = { texts: {}, media: [] };
        }
        const tracker = spamTracker[sender.id];

        // Process text messages.
        if (msg.body && msg.body.trim().length > 0 && !msg.hasMedia) {
            const normalizedText = msg.body.trim().toLowerCase();
            tracker.texts[normalizedText] = (tracker.texts[normalizedText] || []).filter(ts => (now - ts) < windowMs);
            tracker.texts[normalizedText].push(now);
            const count = tracker.texts[normalizedText].length;
            if (DEBUG) {
                console.log("DEBUG: Normalized text:", normalizedText);
                console.log("DEBUG: Duplicate count for this text:", count);
            }
            // Send a warning when count equals 8.
            if (count === 8) {
                const randomWarning = getRandomText();
                const mentionText = `@${sender.contact.id.user}`;
                await chat.sendMessage(`${mentionText} ${randomWarning}`, { mentions: [sender.contact] });
                log(`Sent duplicate text warning to ${sender.name} (${sender.number}) for "${normalizedText}". Count: ${count}`);
            }
            // When count exceeds 10, notify admin.
            if (count > 10) {
                const reason = `spamming duplicate messages ("${normalizedText}") exceeding allowed count`;
                updateStats(chat, sender, 'spams');
                await sendAdminNotification(chat, sender, reason);
                // Reset tracker for this normalizedText.
                tracker.texts[normalizedText] = [];
                return;
            }
        }

        // Process media messages.
        if (msg.hasMedia) {
            tracker.media = tracker.media.filter(ts => (now - ts) < windowMs);
            tracker.media.push(now);
            const mediaCount = tracker.media.length;
            if (DEBUG) console.log(`DEBUG: Media count for ${sender.name}: ${mediaCount}`);
            if (mediaCount === 8) {
                const randomWarning = getRandomText();
                const mentionText = `@${sender.contact.id.user}`;
                await chat.sendMessage(`${mentionText} ${randomWarning}`, { mentions: [sender.contact] });
                log(`Sent media warning to ${sender.name} (${sender.number}). Media count: ${mediaCount}`);
            }
            if (mediaCount > 10) {
                const reason = "spamming media messages (exceeding allowed count)";
                updateStats(chat, sender, 'spams');
                await sendAdminNotification(chat, sender, reason);
                tracker.media = [];
                return;
            }
        }
    } catch (error) {
        log(`Spam processing error: ${error.message}`);
    }
}

// ----- Event Handlers -----
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    log('QR code received. Scan with WhatsApp.');
});

client.on('ready', async () => {
    log('Client ready. Bot is monitoring groups.');
});

client.on('message', async msg => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup || msg.fromMe) return;
        const sender = await getSenderInfo(msg);
        // Update total messages count for statistics.
        updateStats(chat, sender, 'messages');
        processRestrictedMessage(msg);
        processSpam(msg);
    } catch (error) {
        log(`Error processing message: ${error.message}`);
    }
});

client.initialize().catch(error => {
    log(`Initialization failed: ${error.message}`);
    process.exit(1);
});

// ----- Express Web Server for Statistics -----
const app = express();
app.get('/', (req, res) => {
    res.send(renderStatsAsHtml());
});

function renderStatsAsHtml() {
    let html = '<h1>WhatsApp Bot Statistics</h1>';
    for (const groupId in stats) {
        const group = stats[groupId];
        html += `<h2>Group: ${group.groupName} (${groupId})</h2>`;
        html += '<table border="1" cellspacing="0" cellpadding="5"><tr><th>Member</th><th>Phone</th><th>Messages</th><th>Spams</th><th>Badwords</th></tr>';
        for (const memberId in group.members) {
            const member = group.members[memberId];
            html += `<tr><td>${member.name}</td><td>${member.number}</td><td>${member.messages}</td><td>${member.spams}</td><td>${member.badwords}</td></tr>`;
        }
        html += '</table>';
    }
    return html;
}

app.listen(8000, () => {
    log('Web server started on port 8000');
});