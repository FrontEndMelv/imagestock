// server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // Use the pg library for PostgreSQL
const cors = require('cors');
const utils = require('./utils.js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sharp = require('sharp'); // <--- added for image processing

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';
const YOUR_DOMAIN = 'https://imagestock-shop.onrender.com';

// --- Connect to PostgreSQL ---
// The DATABASE_URL is provided by Render as an environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// --- Initialize Database Tables ---
const initializeDatabase = async () => {
    try {
        // Create images table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS images (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                url TEXT NOT NULL
            );
        `);

        // Create sales table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sales (
                id SERIAL PRIMARY KEY,
                imageId INTEGER,
                imageName TEXT NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                buyerEmail TEXT NOT NULL,
                purchaseTime TIMESTAMPTZ NOT NULL,
                transactionId TEXT NOT NULL
            );
        `);
        
        // Check if images table is empty and populate it with sample data
        const res = await pool.query('SELECT COUNT(*) FROM images');
        if (res.rows[0].count === '0') {
            console.log("Database is empty. Populating images table with sample data...");
            // NOTE: In a real application, you would add your own images via DBeaver.
            // These are just placeholders so the site isn't empty on first deploy.
            const sampleImages = [
                { name: "Sample: Mountain", price: 10.00, url: "https://placehold.co/600x400/000000/FFFFFF?text=Mountain" },
                { name: "Sample: City", price: 12.50, url: "https://placehold.co/600x400/333333/FFFFFF?text=City" }
            ];
            for (const img of sampleImages) {
                await pool.query('INSERT INTO images (name, price, url) VALUES ($1, $2, $3)', [img.name, img.price, img.url]);
            }
        }
        console.log('Database tables are ready.');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
};


// --- API Endpoints (Updated for PostgreSQL) ---

// GET all images
app.get('/api/images', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM images");
        // Return preview URLs instead of original stored URL
        const rowsWithPreview = result.rows.map(r => ({
            ...r,
            url: `${YOUR_DOMAIN}/preview/${r.id}`
        }));
        res.json({ data: rowsWithPreview });
    } catch (err) {
        res.status(500).json({ "error": err.message });
    }
});

// Create a preview endpoint that downloads the original image, rescales and applies a centered translucent text watermark.
// URL: GET /preview/:id
app.get('/preview/:id', async (req, res) => {
  const imageId = req.params.id;
  try {
    const imageResult = await pool.query("SELECT * FROM images WHERE id = $1", [imageId]);
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: "Image not found." });
    }
    const image = imageResult.rows[0];

    // Fetch the original image bytes
    const fetchRes = await fetch(image.url);
    if (!fetchRes.ok) {
      return res.status(502).json({ error: "Failed to fetch remote image." });
    }
    const arrayBuffer = await fetchRes.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Use sharp to resize (max width 1200) and composite an SVG watermark centered
    const metadata = await sharp(inputBuffer).metadata();
    const targetWidth = Math.min(metadata.width || 1200, 1200);

    // Create an SVG watermark sized relative to the image width
    const fontSize = Math.round(targetWidth / 8);
    const svg = `
      <svg width="${targetWidth}" height="${fontSize * 2}" xmlns="http://www.w3.org/2000/svg">
        <style>
          .title { fill: rgba(255,255,255,0.5); font-size: ${fontSize}px; font-weight: 700; font-family: Arial, sans-serif; }
        </style>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" class="title">Watermark</text>
      </svg>
    `;

    // Resize and composite watermark centered
    const composited = await sharp(inputBuffer)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .composite([{
        input: Buffer.from(svg),
        gravity: 'center'
      }])
      .toBuffer();

    // Determine output mime type (preserve original format if possible)
    const outFormat = (metadata.format === 'png' || metadata.format === 'webp' || metadata.format === 'jpeg') ? metadata.format : 'jpeg';
    const contentType = outFormat === 'png' ? 'image/png' : 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // small cache for preview
    return res.end(composited);
  } catch (err) {
    console.error('Error generating preview:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Create a Stripe Checkout Session
app.post('/api/create-checkout-session', async (req, res) => {
    const { imageId, buyerEmail } = req.body;
    try {
        const imageResult = await pool.query("SELECT * FROM images WHERE id = $1", [imageId]);
        if (imageResult.rows.length === 0) {
            return res.status(404).json({ error: "Image not found." });
        }
        const image = imageResult.rows[0];

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: buyerEmail,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { 
                        name: image.name,
                        // Use our preview endpoint so Stripe shows the watermarked/downsized preview
                        images: [`${YOUR_DOMAIN}/preview/${image.id}`]
                    },
                    unit_amount: Math.round(image.price * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: { imageId: image.id, imageName: image.name, price: image.price },
            success_url: `${YOUR_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${YOUR_DOMAIN}/index.html`,
        });
        res.json({ id: session.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fulfill the order after successful payment
app.post('/api/fulfill-order', async (req, res) => {
    const { sessionId } = req.body;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === 'paid') {
            const { imageId, imageName, price } = session.metadata;
            const buyerEmail = session.customer_details.email;
            const transactionId = session.payment_intent;
            const purchaseTime = new Date();

            await pool.query(
                `INSERT INTO sales (imageId, imageName, price, buyerEmail, purchaseTime, transactionId) VALUES ($1, $2, $3, $4, $5, $6)`,
                [imageId, imageName, parseFloat(price), buyerEmail, purchaseTime, transactionId]
            );

            const imageResult = await pool.query("SELECT url FROM images WHERE id = $1", [imageId]);
            if (imageResult.rows.length === 0) {
                return res.status(404).json({ error: "Image not found for fulfillment." });
            }

            const signedUrl = utils.generateSignedUrl(`${YOUR_DOMAIN}/api/download/${imageId}?tx=${transactionId}`, 900);

            res.json({ success: true, downloadUrl: signedUrl, imageName: imageName });
        } else {
            res.status(400).json({ success: false, message: 'Payment not successful.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET all sales
app.get('/api/sales', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM sales ORDER BY purchaseTime DESC");
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ "error": err.message });
    }
});

app.get('/api/download/:id', async (req, res) => {
    const imageId = req.params.id;
    const transactionId = req.query.tx; // passed as ?tx=abc123

    if (!transactionId) {
        return res.status(401).json({ error: "Missing transaction token" });
    }

    // Verify signature & expiry
    if (!utils.verifySignedUrl(`${YOUR_DOMAIN}${req.originalUrl}`)) {
        return res.status(403).json({ error: "Invalid or expired link" });
    }

    // Verify sale exists for this image & transaction
    const saleResult = await pool.query(
        "SELECT * FROM sales WHERE imageid = $1 AND transactionid = $2",
        [imageId, transactionId]
    );

    if (saleResult.rows.length === 0) {
        return res.status(403).json({ error: "Unauthorized download" });
    }

    // Fetch image
    const imageResult = await pool.query("SELECT * FROM images WHERE id = $1", [imageId]);
    if (imageResult.rows.length === 0) {
        return res.status(404).json({ error: "Image not found" });
    }
    const image = imageResult.rows[0];
    fetch(image.url).then(({ body, headers }) => {
      body.pipeTo(
        new WritableStream({
          start() {
            headers.forEach((v, n) => res.setHeader(n, v));
          },
          write(chunk) {
            res.write(chunk);
          },
          close() {
            res.end();
          },
        })
      );
    });
});

// Start the server
app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
    initializeDatabase(); // Initialize the database when the server starts
});
