import 'dotenv/config'
import http from 'http'
import fs from 'fs'
import path from 'path'
import TelegramBot from 'node-telegram-bot-api'
import { google } from 'googleapis'

/**
 * CONFIG
 */
const PORT = Number(process.env.PORT || 10000)

const TG_TOKEN = process.env.TG_TOKEN
const TG_CHAT_ID = Number(process.env.TG_CHAT_ID || 0)
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 15)

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

// Render secret files
const CREDENTIALS_PATH = '/etc/secrets/credentials.json'
const TOKEN_PATH = '/etc/secrets/token.json'

// fallback (локально)
const LOCAL_CREDENTIALS = path.resolve('credentials.json')
const LOCAL_TOKEN = path.resolve('token.json')

const STATE_PATH = path.resolve('state.json')

if (!TG_TOKEN) throw new Error('❌ Нет TG_TOKEN')

/**
 * WEB SERVER (для UptimeRobot)
 */
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  res.writeHead(200)
  res.end('gmail2tg running')
})

server.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`)
})

/**
 * TELEGRAM
 */
const bot = new TelegramBot(TG_TOKEN, { polling: true })

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `chatId: ${msg.chat.id}`)
})

/**
 * HELPERS
 */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file)) } catch { return fallback }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}
function pickHeader(headers, name) {
  return headers.find(h => h.name === name)?.value || ''
}

/**
 * AUTH
 */
async function authorize() {
  const credsPath = fs.existsSync(CREDENTIALS_PATH) ? CREDENTIALS_PATH : LOCAL_CREDENTIALS
  const tokenPath = fs.existsSync(TOKEN_PATH) ? TOKEN_PATH : LOCAL_TOKEN

  if (!fs.existsSync(credsPath)) throw new Error('Нет credentials.json')
  if (!fs.existsSync(tokenPath)) throw new Error('Нет token.json')

  const creds = JSON.parse(fs.readFileSync(credsPath))
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web

  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])
  auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)))

  console.log('✅ Gmail auth OK')
  return auth
}

/**
 * MAIN BOT
 */
async function startBot() {
  console.log('🚀 Bot starting...')

  const auth = await authorize()
  const gmail = google.gmail({ version: 'v1', auth })

  const state = readJSON(STATE_PATH, {
    startAfter: null,
    processed: {}
  })

  if (!state.startAfter) {
    state.startAfter = Date.now()
    writeJSON(STATE_PATH, state)
    console.log('⏳ Ignore old emails')
  }

  while (true) {
    try {
      const minutes = Math.max(1, Math.floor((Date.now() - state.startAfter) / 60000))

      const res = await gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox newer_than:${minutes}m`,
        maxResults: 10
      })

      const messages = (res.data.messages || []).reverse()

      if (messages.length) console.log('📩 New:', messages.length)

      for (const m of messages) {
        if (state.processed[m.id]) continue

        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date']
        })

        const headers = msg.data.payload.headers

        const from = pickHeader(headers, 'From')
        const subject = pickHeader(headers, 'Subject')
        const date = pickHeader(headers, 'Date')
        const snippet = msg.data.snippet

        const text =
          `📩 Новое письмо\n` +
          `От: ${from}\n` +
          `Тема: ${subject}\n` +
          `Дата: ${date}\n\n` +
          `${snippet}`

        await bot.sendMessage(TG_CHAT_ID, text)

        // помечаем прочитанным
        await gmail.users.messages.modify({
          userId: 'me',
          id: m.id,
          requestBody: { removeLabelIds: ['UNREAD'] }
        })

        state.processed[m.id] = Date.now()
      }

      writeJSON(STATE_PATH, state)

    } catch (e) {
      console.log('❌ Error:', e.message)
    }

    await new Promise(r => setTimeout(r, POLL_SECONDS * 1000))
  }
}

startBot()
