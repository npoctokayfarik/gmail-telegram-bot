import http from 'http'

const PORT = Number(process.env.PORT || 10000)

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('gmail2tg alive')
})

server.listen(PORT, () => {
  console.log(`Health server on :${PORT}`)
})
