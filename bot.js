const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const request = require('request');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Replace with your bot token
const BOT_TOKEN = '7448594075:AAFMCpeHgz1sjE7LgN0XMyPW14Bz8x2qab8';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const CHUNK_SIZE = 49 * 1024 * 1024; // 49 MB

// Initialize SQLite database
const db = new sqlite3.Database('file_processes.db');

// Create table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS file_processes (
    chat_id INTEGER, 
    file_name TEXT, 
    status TEXT
  )
`);

// Handle /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Please send me the file link.");
});

// Handle plain text messages (expecting file link)
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('http')) {
    const fileUrl = msg.text;
    const fileName = path.basename(fileUrl);
    const filePath = path.join(__dirname, fileName);

    // Insert initial status into the database
    db.run("INSERT INTO file_processes (chat_id, file_name, status) VALUES (?, ?, ?)", [chatId, fileName, 'Downloading the file...'], (err) => {
      if (err) console.error(err);
    });

    bot.sendMessage(chatId, "Downloading the file, please wait...");

    downloadFile(fileUrl, filePath, chatId)
      .then(() => {
        fs.stat(filePath, (err, stats) => {
          if (err) {
            return bot.sendMessage(chatId, "Error occurred while processing the file.");
          }

          if (stats.size > 50 * 1024 * 1024) { // Larger than 50 MB
            updateStatus(chatId, 'Splitting file into chunks...');
            bot.sendMessage(chatId, "The file is larger than 50 MB. Splitting it into chunks...");

            splitFile(filePath, CHUNK_SIZE)
              .then((chunks) => {
                sendChunks(chatId, chunks)
                  .then(() => {
                    cleanupChunks(chunks);
                    updateStatus(chatId, 'Completed');
                  })
                  .catch(err => console.error(err));
              })
              .catch(err => console.error(err));
          } else {
            updateStatus(chatId, 'Sending file...');
            bot.sendMessage(chatId, "The file is under 50 MB. Sending the file...");

            sendFile(chatId, filePath)
              .then(() => {
                updateStatus(chatId, 'Completed');
                cleanupFile(filePath);
              })
              .catch(err => console.error(err));
          }
        });
      })
      .catch(err => {
        console.error(err);
        bot.sendMessage(chatId, "Error occurred while downloading the file.");
      });
  }
});

// Download file
function downloadFile(url, filePath, chatId) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let receivedBytes = 0;

    request.get(url)
      .on('response', (response) => {
        const totalBytes = parseInt(response.headers['content-length'], 10);
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          const progress = Math.floor((receivedBytes / totalBytes) * 100);
          updateStatus(chatId, `Downloading... ${progress}% completed`);
        });
      })
      .pipe(file)
      .on('finish', () => {
        file.close(() => resolve());
      })
      .on('error', (err) => {
        fs.unlink(filePath, () => reject(err));
      });
  });
}

// Split file into chunks
function splitFile(filePath, chunkSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const fileSize = fs.statSync(filePath).size;
    const numChunks = Math.ceil(fileSize / chunkSize);
    const fileStream = fs.createReadStream(filePath, { highWaterMark: chunkSize });

    let chunkIndex = 0;
    fileStream.on('data', (chunk) => {
      const chunkFileName = `${filePath}.part${chunkIndex + 1}`;
      fs.writeFileSync(chunkFileName, chunk);
      chunks.push(chunkFileName);
      chunkIndex += 1;
    });

    fileStream.on('end', () => resolve(chunks));
    fileStream.on('error', (err) => reject(err));
  });
}

// Send chunks
function sendChunks(chatId, chunks) {
  return new Promise((resolve, reject) => {
    const totalChunks = chunks.length;
    let chunkIndex = 0;

    const sendNextChunk = () => {
      if (chunkIndex < totalChunks) {
        const chunk = chunks[chunkIndex];
        bot.sendDocument(chatId, chunk, { caption: `Part ${chunkIndex + 1} of ${totalChunks}` })
          .then(() => {
            updateStatus(chatId, `Sending chunks... ${(chunkIndex + 1)}/${totalChunks} completed`);
            chunkIndex += 1;
            sendNextChunk();
          })
          .catch(err => reject(err));
      } else {
        bot.sendMessage(chatId, "All chunks sent successfully.");
        resolve();
      }
    };

    sendNextChunk();
  });
}

// Send full file
function sendFile(chatId, filePath) {
  return bot.sendDocument(chatId, filePath)
    .then(() => bot.sendMessage(chatId, "File sent successfully."));
}

// Update status in the database
function updateStatus(chatId, status) {
  db.run("UPDATE file_processes SET status = ? WHERE chat_id = ?", [status, chatId], (err) => {
    if (err) console.error(err);
  });
}

// Cleanup chunk files
function cleanupChunks(chunks) {
  chunks.forEach(chunk => fs.unlinkSync(chunk));
}

// Cleanup original file
function cleanupFile(filePath) {
  fs.unlinkSync(filePath);
}

// Start the bot
const PORT = process.env.PORT || 3000;
bot.startPolling();
console.log(`Bot is running on port ${PORT}`);
