const https = require("https");

async function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });

    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

async function sendDiscord(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    await postJson(url, { content: message });
  } catch (error) {
    console.error("Erro Discord:", error.message);
  }
}

async function sendTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await postJson(url, {
      chat_id: chatId,
      text: message
    });
  } catch (error) {
    console.error("Erro Telegram:", error.message);
  }
}

async function notifyAll(message) {
  await Promise.allSettled([
    sendDiscord(message),
    sendTelegram(message)
  ]);
}

module.exports = {
  notifyAll
};