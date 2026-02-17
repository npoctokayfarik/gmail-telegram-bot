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

// Render secret files paths
const SECRET_CREDENTIALS = '/etc/secrets/credentials.json'
const SECRET_TOKEN = '/etc/secrets/token.json'

// Local fallback
const LOCAL_CREDENTIALS = path.resolve('credentials.json')
const LOCAL_TOKEN = path.resolve('token.json')

// State
const STATE_PATH = path.resolve('state.json')

if (!TG_TOKEN) throw new Error('❌ TG_TOKEN отсутствует (добавь в Render Env)')
if (!TG_CHAT_ID) console.log('⚠️ TG_CHAT_ID пустой (добавь в Render Env)')

/**
 * HEALTH SERVER (для UptimeRobot)
 */
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('gmail2tg alive')
  })
  .listen(PORT, () => console.log(`🌐 Health server on :${PORT}`))

/**
 * TELEGRAM BOT (Polling)
 */
const bot = new TelegramBot(TG_TOKEN, { polling: true })

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `chatId: ${msg.chat.id}`)
})

/**
 * Helpers
 */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function pickHeader(headers, name) {
  const h = (headers || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase())
  return (h && h.value) || ''
}

function pickFile(primary, fallback) {
  if (primary && fs.existsSync(primary)) return primary
  if (fallback && fs.existsSync(fallback)) return fallback
  return null
}

/**
 * Gmail OAuth
 */
async function authorize() {
  const credentialsPath = pickFile(SECRET_CREDENTIALS, LOCAL_CREDENTIALS)
  const tokenPath = pickFile(SECRET_TOKEN, LOCAL_TOKEN)

  if (!credentialsPath) {
    throw new Error('❌ credentials.json не найден. На Render добавь Secret File credentials.json')
  }
  if (!tokenPath) {
    throw new Error('❌ token.json не найден. На Render добавь Secret File token.json')
  }

  const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web || {}

  if (!client_id || !client_secret || !redirect_uris?.length) {
    throw new Error('❌ credentials.json неправильный (нужен client_id/client_secret/redirect_uris)')
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')))

  console.log('✅ Gmail auth OK')
  return oAuth2Client
}

/**
 * MAIN LOOP
 * - игнорим старые письма (с момента старта)
 * - пересылаем
 * - помечаем прочитанным
 */
async function main() {
  console.log('🚀 Bot starting...')

  const auth = await authorize()
  const gmail = google.gmail({ version: 'v1', auth })

  const state = readJSON(STATE_PATH, { startAfter: null, processed: {} })
  if (!state.startAfter) {
    state.startAfter = Date.now()
    writeJSON(STATE_PATH, state)
    console.log('⏳ Ignore old emails from now')
  }

  while (true) {
    try {
      const minutes = Math.max(1, Math.floor((Date.now() - state.startAfter) / 60000))
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox newer_than:${minutes}m`,
        maxResults: 10,
      })

      const messages = (res.data.messages || []).reverse()

      for (const m of messages) {
        const id = m.id
        if (!id) continue
        if (state.processed[id]) continue

        const msg = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        })

        const headers = msg.data.payload?.headers || []
        const from = pickHeader(headers, 'From')
        const subject = pickHeader(headers, 'Subject') || '(без темы)'
        const date = pickHeader(headers, 'Date')
        const snippet = msg.data.snippet || '(нет текста)'

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
          id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        })

        state.processed[id] = Date.now()
      }

      writeJSON(STATE_PATH, state)
    } catch (e) {
      console.error('❌ Loop error:', e?.message || e)
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
  }
}

main().catch((e) => console.error('❌ Fatal:', e?.message || e))
