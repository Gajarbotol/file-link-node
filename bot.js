const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Replace with your bot token
const BOT_TOKEN = '7448594075:AAFMCpeHgz1sjE7LgN0XMyPW14Bz8x2qab8';
const bot = new Telegraf(BOT_TOKEN);

const CHUNK_SIZE = 49 * 1024 * 1024; // 49 MB
const statusTracking = new Map();
const progressCache = new Map();
const app = express();
const PORT = process.env.PORT || 3000;

// Queue to manage editMessageText requests
const requestQueue = [];

// Function to download the file
const downloadFile = async (url, filePath, ctx, progressMessage) => {
  const writer = fs.createWriteStream(filePath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  const totalSize = parseInt(response.headers['content-length'], 10);
  let downloadedSize = 0;

  response.data.on('data', (chunk) => {
    writer.write(chunk);
    downloadedSize += chunk.length;
    enqueueEditMessageRequest(ctx, downloadedSize, totalSize, "Downloading", progressMessage);
  });

  return new Promise((resolve, reject) => {
    response.data.on('end', () => {
      writer.end();
      resolve();
    });

    response.data.on('error', (err) => {
      writer.end();
      reject(err);
    });
  });
};

// Function to split the file into chunks
const splitFile = (filePath, chunkSize, ctx, progressMessage) => {
  const fileSize = fs.statSync(filePath).size;
  const numChunks = Math.ceil(fileSize / chunkSize);
  const chunks = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkFileName = `${filePath}.part${i + 1}`;
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);

    fs.writeFileSync(chunkFileName, fs.readFileSync(filePath, { start, end }));
    chunks.push(chunkFileName);
    enqueueEditMessageRequest(ctx, i + 1, numChunks, "Splitting", progressMessage);
  }

  return chunks;
};

// Function to send the chunks
const sendChunks = async (ctx, chunks, progressMessage) => {
  const totalChunks = chunks.length;
  for (let i = 0; i < totalChunks; i++) {
    await ctx.replyWithDocument({ source: chunks[i] }, { caption: `Part ${i + 1} of ${totalChunks}` });
    enqueueEditMessageRequest(ctx, i + 1, totalChunks, "Sending chunks", progressMessage);
  }
  enqueueEditMessageRequest(ctx, totalChunks, totalChunks, "All chunks sent", progressMessage);
};

// Queueing and handling function for `editMessageText` requests
const enqueueEditMessageRequest = (ctx, current, total, stage, progressMessage) => {
  const progress = Math.round((current / total) * 100);
  const chatId = ctx.chat.id;

  if (progressCache.get(chatId) !== progress) {
    progressCache.set(chatId, progress);
    statusTracking.set(chatId, `${stage}... ${progress}% completed`);

    requestQueue.push(async () => {
      try {
        await ctx.telegram.editMessageText(chatId, progressMessage.message_id, undefined, `${stage}... ${progress}% completed`);
      } catch (error) {
        if (error.code === 429) {
          const retryAfter = error.parameters.retry_after || 1;
          console.log(`Rate limit exceeded. Retrying in ${retryAfter} seconds...`);
          await delay(retryAfter * 1000);
        } else {
          console.error('Failed to update message:', error);
        }
      }
    });
  }

  processQueue();
};

// Function to process the request queue with a delay
const processQueue = async () => {
  if (requestQueue.length > 0) {
    const request = requestQueue.shift();
    await request();
    await delay(1000); // Delay between successive requests to avoid hitting the rate limit
    processQueue();
  }
};

// Delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Start command
bot.start((ctx) => {
  ctx.reply('Please send me the file link.');
  bot.on('text', async (ctx) => {
    const fileUrl = ctx.message.text;
    const chatId = ctx.chat.id;
    const filePath = path.basename(fileUrl);

    statusTracking.set(chatId, 'Downloading the file...');

    const progressMessage = await ctx.reply('Downloading the file...');

    try {
      await downloadFile(fileUrl, filePath, ctx, progressMessage);
      const fileSize = fs.statSync(filePath).size;

      if (fileSize > 50 * 1024 * 1024) { // Larger than 50 MB
        statusTracking.set(chatId, 'Splitting file into chunks...');
        await ctx.telegram.editMessageText(ctx.chat.id, progressMessage.message_id, undefined, 'The file is larger than 50 MB. Splitting it into chunks...');
        const chunks = splitFile(filePath, CHUNK_SIZE, ctx, progressMessage);
        await sendChunks(ctx, chunks, progressMessage);
        chunks.forEach((chunk) => fs.unlinkSync(chunk)); // Clean up chunks
      } else {
        statusTracking.set(chatId, 'Sending file...');
        await ctx.telegram.editMessageText(ctx.chat.id, progressMessage.message_id, undefined, 'The file is under 50 MB. Sending the file...');
        await ctx.replyWithDocument({ source: filePath });
      }

      fs.unlinkSync(filePath); // Clean up the downloaded file
      statusTracking.set(chatId, 'Completed');
      await ctx.telegram.editMessageText(ctx.chat.id, progressMessage.message_id, undefined, 'Process completed successfully.');
    } catch (error) {
      await ctx.telegram.editMessageText(ctx.chat.id, progressMessage.message_id, undefined, 'An error occurred: ' + error.message);
      statusTracking.set(chatId, 'Error');
    }
  });
});

// Status command
bot.command('status', (ctx) => {
  const chatId = ctx.chat.id;
  if (statusTracking.has(chatId)) {
    ctx.reply(`Current status: ${statusTracking.get(chatId)}`);
  } else {
    ctx.reply('No ongoing tasks found.');
  }
});

// Set up express server for port configuration
app.get('/', (req, res) => {
  res.send('Telegram bot is running.');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  bot.launch();
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
