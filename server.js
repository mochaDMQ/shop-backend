const express = require('express')
const cors = require('cors')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))


// API routes
app.use('/api/categories', require('./routes/categories'))
app.use('/api/products', require('./routes/products'))

app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`)
})