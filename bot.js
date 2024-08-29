const http = require('http');
const fs = require('fs');
const path = require('path');
const request = require('request');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

// Replace with your bot token and desired port number
const BOT_TOKEN = '7448594075:AAFMCpeHgz1sjE7LgN0XMyPW14Bz8x2qab8';
const PORT = process.env.PORT || 3000;  // You can change the port number as needed
const CHUNK_SIZE = 49 * 1024 * 1024; // 49 MB

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('file_processes.db');

// Initialize SQLite database
db.run(`CREATE TABLE IF NOT EXISTS file_processes (
    chat_id INTEGER,
    file_name TEXT,
    status TEXT
)`);

const statusTracking = {};

// Handle /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Please send me the file link.');
    bot.once('message', (msg) => getFileLink(msg, chatId));
});

function getFileLink(msg, chatId) {
    const fileUrl = msg.text;
    statusTracking[chatId] = "Downloading the file...";

    db.run(`INSERT INTO file_processes (chat_id, file_name, status) VALUES (?, ?, ?)`,
        [chatId, path.basename(fileUrl), statusTracking[chatId]]);

    bot.sendMessage(chatId, 'Downloading the file, please wait...')
        .then((sentMsg) => downloadFile(fileUrl, chatId, sentMsg));
}

function downloadFile(url, chatId, sentMsg) {
    const fileName = path.basename(url);
    const filePath = path.join(__dirname, fileName);
    let receivedBytes = 0;

    const fileStream = fs.createWriteStream(filePath);

    request.get(url)
        .on('response', (response) => {
            const totalBytes = parseInt(response.headers['content-length'], 10);

            response.on('data', (chunk) => {
                receivedBytes += chunk.length;
                updateProgress(sentMsg, receivedBytes, totalBytes, 'Downloading', chatId);
            });

            response.on('end', () => {
                bot.sendMessage(chatId, 'Download complete.');

                fs.stat(filePath, (err, stats) => {
                    if (err) throw err;
                    if (stats.size > 50 * 1024 * 1024) { // Larger than 50 MB
                        statusTracking[chatId] = "Splitting file into chunks...";
                        db.run(`UPDATE file_processes SET status = ? WHERE chat_id = ?`,
                            [statusTracking[chatId], chatId]);

                        bot.sendMessage(chatId, 'The file is larger than 50 MB. Splitting it into chunks...')
                            .then(() => {
                                splitFile(filePath, chatId, sentMsg);
                            });
                    } else {
                        statusTracking[chatId] = "Sending file...";
                        db.run(`UPDATE file_processes SET status = ? WHERE chat_id = ?`,
                            [statusTracking[chatId], chatId]);

                        bot.sendMessage(chatId, 'The file is under 50 MB. Sending the file...')
                            .then(() => {
                                sendFile(chatId, filePath);
                            });
                    }
                });
            });
        })
        .pipe(fileStream)
        .on('error', (err) => {
            fs.unlink(filePath, () => bot.sendMessage(chatId, `Error: ${err.message}`));
        });
}

function splitFile(filePath, chatId, sentMsg) {
    const fileStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    let partNumber = 0;
    const chunks = [];

    fileStream.on('data', (chunk) => {
        partNumber += 1;
        const chunkFileName = `${filePath}.part${partNumber}`;
        chunks.push(chunkFileName);
        fs.writeFileSync(chunkFileName, chunk);
        updateProgress(sentMsg, partNumber, Math.ceil(fs.statSync(filePath).size / CHUNK_SIZE), 'Splitting', chatId);
    });

    fileStream.on('end', () => {
        sendChunks(chatId, chunks, sentMsg);
        cleanupChunks(chunks);
    });
}

function sendChunks(chatId, chunks, sentMsg) {
    chunks.forEach((chunk, index) => {
        bot.sendDocument(chatId, chunk, { caption: `Part ${index + 1} of ${chunks.length}` })
            .then(() => {
                updateProgress(sentMsg, index + 1, chunks.length, 'Sending chunks', chatId);
            });
    });

    bot.sendMessage(chatId, 'All chunks sent successfully.');
}

function sendFile(chatId, filePath) {
    bot.sendDocument(chatId, filePath)
        .then(() => bot.sendMessage(chatId, 'File sent successfully.'));
}

function updateProgress(sentMsg, current, total, stage, chatId) {
    const progress = Math.round((current / total) * 100);
    statusTracking[chatId] = `${stage}... ${progress}% completed`;

    db.run(`UPDATE file_processes SET status = ? WHERE chat_id = ?`,
        [statusTracking[chatId], chatId]);

    bot.editMessageText(`${stage}... ${progress}% completed`, {
        chat_id: sentMsg.chat.id,
        message_id: sentMsg.message_id
    });
}

function cleanupChunks(chunks) {
    chunks.forEach((chunk) => fs.unlinkSync(chunk));
}

function cleanupFile(filePath) {
    fs.unlinkSync(filePath);
}

// Handle /status command
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;

    if (statusTracking[chatId]) {
        bot.sendMessage(chatId, `Current status: ${statusTracking[chatId]}`);
    } else {
        bot.sendMessage(chatId, 'No ongoing tasks found.');
    }
});

// Handle /cancel command
bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Operation cancelled.');
});

// Start HTTP server to listen on the specified port
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Telegram bot is running.\n');
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
