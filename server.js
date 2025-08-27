// server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // Use the pg library for PostgreSQL
const cors = require('cors');
const utils = require('./utils.js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ "error": err.message });
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
                    product_data: { name: image.name, images: [image.url] },
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
    if (!utils.verifySignedUrl(req.originalUrl)) {
        return res.status(403).json({ error: "Invalid or expired link" });
    }


    try {
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

        const response = await fetch(image.url);
        if (!response.ok) {
            return res.status(500).send("Failed to fetch file.");
        }

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${image.name}"`
        );
        res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");

        response.body.pipe(res);

    } catch (err) {
        console.error("Download error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Start the server
app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
    initializeDatabase(); // Initialize the database when the server starts
});
