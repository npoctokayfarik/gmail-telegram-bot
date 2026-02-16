import TelegramBot from 'node-telegram-bot-api'

const bot = new TelegramBot("ТВОЙ_TOKEN", { polling: true })

bot.on('message', (msg) => {
  console.log(msg.text)
  bot.sendMessage(msg.chat.id, "Работает 🔥")
})
