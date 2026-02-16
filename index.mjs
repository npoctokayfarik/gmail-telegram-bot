import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import process from 'process'
import TelegramBot from 'node-telegram-bot-api'
import { google } from 'googleapis'

/**
 * CONFIG
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] // нужно, чтобы помечать письма
const CREDENTIALS_PATH = path.resolve('credentials.json')
const TOKEN_PATH = path.resolve('token.json')
const STATE_PATH = path.resolve('state.json')

const TG_TOKEN = process.env.TG_TOKEN
const TG_CHAT_ID = Number(process.env.TG_CHAT_ID || 0)
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 15)

// лимит писем за один тик
const MAX_PER_TICK = 10

// название метки, которую будем ставить после пересылки
const FORWARDED_LABEL_NAME = 'TG_FORWARDED'

if (!TG_TOKEN) throw new Error('❌ Нет TG_TOKEN в .env')

/**
 * Telegram
 */
const bot = new TelegramBot(TG_TOKEN, { polling: true })

bot.onText(/\/start/, async (msg) => {
  console.log('chatId =', msg.chat.id)
  await bot.sendMessage(
    msg.chat.id,
    `Йо! chatId: ${msg.chat.id}\nВставь его в TG_CHAT_ID в .env и перезапусти бота.`
  )
})

/**
 * Helpers
 */
function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function pickHeader(headers, name) {
  const h = (headers || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase())
  return (h && h.value) || ''
}

function normalizeText(s, maxLen = 3500) {
  const text = String(s || '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .trim()

  // Telegram limit ~4096, оставим запас
  if (text.length > maxLen) return text.slice(0, maxLen) + '…'
  return text
}

function decodeBase64Url(data) {
  if (!data) return ''
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  return Buffer.from(b64 + pad, 'base64').toString('utf8')
}

/**
 * Extract plain text from Gmail payload
 */
function extractBodyText(payload) {
  if (!payload) return ''

  const stack = [payload]
  let plain = ''
  let html = ''

  while (stack.length) {
    const part = stack.pop()
    const mimeType = part.mimeType || ''
    const bodyData = part.body?.data

    if (part.parts?.length) {
      for (const p of part.parts) stack.push(p)
    }

    if (mimeType === 'text/plain' && bodyData && !plain) {
      plain = decodeBase64Url(bodyData)
    }

    if (mimeType === 'text/html' && bodyData && !html) {
      html = decodeBase64Url(bodyData)
    }
  }

  if (plain) return plain

  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }

  return ''
}

function collectAttachments(payload) {
  const files = []
  if (!payload) return files

  const stack = [payload]
  while (stack.length) {
    const part = stack.pop()
    if (part.parts?.length) {
      for (const p of part.parts) stack.push(p)
    }

    const filename = part.filename
    const attachmentId = part.body?.attachmentId
    const size = part.body?.size || 0

    if (filename && attachmentId) {
      files.push({ filename, size })
    }
  }

  return files
}

/**
 * Gmail OAuth
 */
async function authorize() {
  console.log('🔐 Авторизация Gmail...')

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('❌ Не найден credentials.json')
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web || {}

  if (!client_id || !client_secret || !redirect_uris?.length) {
    throw new Error('❌ credentials.json неправильный (нужен OAuth Client)')
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')))
    console.log('✅ token.json найден')
    return oAuth2Client
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  console.log('\n👉 Открой ссылку:\n', authUrl, '\n')

  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = await rl.question('Вставь code сюда: ')
  rl.close()

  const { tokens } = await oAuth2Client.getToken(code.trim())
  oAuth2Client.setCredentials(tokens)
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8')
  console.log('✅ token.json сохранён')

  return oAuth2Client
}

/**
 * Gmail API helpers
 */
async function listMessageIds(gmail, q, maxResults) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  })
  return res.data.messages || []
}

async function getMessageFull(gmail, id) {
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  })

  const payload = msg.data.payload
  const headers = payload?.headers || []

  const from = normalizeText(pickHeader(headers, 'From'), 200)
  const subject = normalizeText(pickHeader(headers, 'Subject') || '(без темы)', 200)
  const date = normalizeText(pickHeader(headers, 'Date'), 200)

  const bodyText = normalizeText(extractBodyText(payload) || msg.data.snippet || '(нет текста)')
  const attachments = collectAttachments(payload)

  return { from, subject, date, bodyText, attachments }
}

async function ensureLabel(gmail, labelName) {
  const labelsRes = await gmail.users.labels.list({ userId: 'me' })
  const labels = labelsRes.data.labels || []

  const existing = labels.find((l) => l.name === labelName)
  if (existing?.id) return existing.id

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  })

  return created.data.id
}

async function markForwarded(gmail, messageId, labelId) {
  // помечаем как прочитанное + добавляем нашу метку
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: labelId ? [labelId] : [],
      removeLabelIds: ['UNREAD'],
    },
  })
}

/**
 * MAIN
 * - игнорим старые письма: начинаем с момента старта (state.startAfterUnix)
 * - пересылаем в TG
 * - потом помечаем в Gmail: TG_FORWARDED + read
 */
async function main() {
  console.log('🚀 Бот запускается...')

  if (!TG_CHAT_ID) {
    console.log('⚠️ TG_CHAT_ID не задан. Напиши /start боту, возьми chatId, вставь в .env и перезапусти.')
  }

  const auth = await authorize()
  const gmail = google.gmail({ version: 'v1', auth })

  // создаём/находим label один раз
  let forwardedLabelId = null
  try {
    forwardedLabelId = await ensureLabel(gmail, FORWARDED_LABEL_NAME)
    console.log(`🏷️ Метка "${FORWARDED_LABEL_NAME}" готова`)
  } catch (e) {
    console.log('⚠️ Не смог создать/найти метку, продолжу без неё:', e?.message || e)
  }

  const state = readJSON(STATE_PATH, {
    startAfterUnix: null,
    processed: {},
  })

  if (!state.startAfterUnix) {
    state.startAfterUnix = Date.now()
    writeJSON(STATE_PATH, state)
    console.log('✅ Первый запуск. Старые письма игнорим. Старт с:', new Date(state.startAfterUnix).toLocaleString())
  } else {
    console.log('✅ Продолжаем. Стартовая точка:', new Date(state.startAfterUnix).toLocaleString())
  }

  console.log(`📡 Проверка каждые ${POLL_SECONDS} сек`)

  while (true) {
    try {
      const minutes = Math.max(1, Math.floor((Date.now() - state.startAfterUnix) / 60000))
      const query = `in:inbox newer_than:${minutes}m`

      const list = await listMessageIds(gmail, query, MAX_PER_TICK)
      const messages = list.reverse()

      if (messages.length) console.log('📩 Писем к обработке:', messages.length)

      for (const m of messages) {
        const id = m.id
        if (!id) continue
        if (state.processed[id]) continue

        const { from, subject, date, bodyText, attachments } = await getMessageFull(gmail, id)

        let text =
          `📩 Новое письмо\n` +
          `От: ${from}\n` +
          `Тема: ${subject}\n` +
          `Дата: ${date}\n\n` +
          `${bodyText}`

        if (attachments.length) {
          const files = attachments
            .slice(0, 10)
            .map((a) => `📎 ${a.filename} (${a.size} bytes)`)
            .join('\n')
          text += `\n\nВложения:\n${files}`
        }

        // 1) отправляем в Telegram
        if (TG_CHAT_ID) await bot.sendMessage(TG_CHAT_ID, text)

        // 2) помечаем письмо в Gmail
        await markForwarded(gmail, id, forwardedLabelId)

        // 3) сохраняем как обработанное
        state.processed[id] = Date.now()
      }

      // чистка processed
      const keys = Object.keys(state.processed)
      if (keys.length > 800) {
        keys
          .sort((a, b) => state.processed[a] - state.processed[b])
          .slice(0, keys.length - 500)
          .forEach((k) => delete state.processed[k])
      }

      writeJSON(STATE_PATH, state)
    } catch (e) {
      console.error('❌ Ошибка:', e?.message || e)
    }

    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
  }
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e)
})
