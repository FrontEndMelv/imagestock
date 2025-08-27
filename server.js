// server.js
require('dotenv').config(); // Loads environment variables from a .env file
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
// IMPORTANT: The secret key is now loaded securely from the .env file
// It is no longer written directly in the code.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
// This is the critical fix for Render deployment
const port = process.env.PORT || 3000;
const host = '0.0.0.0'; // Listen on all available network interfaces

// This will be updated later with your live URL
const YOUR_DOMAIN = 'http://localhost:3000';

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from the current directory
app.use(express.static('.'));

// Initialize SQLite database
const db = new sqlite3.Database('./photostock.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the photostock SQLite database.');
});

// Create tables (no changes here)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        url TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imageId INTEGER,
        imageName TEXT NOT NULL,
        price REAL NOT NULL,
        buyerEmail TEXT NOT NULL,
        purchaseTime TEXT NOT NULL,
        transactionId TEXT NOT NULL
    )`);
});


// --- API Endpoints ---

// GET all images (no changes here)
app.get('/api/images', (req, res) => {
    db.all("SELECT * FROM images", [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({ data: rows });
    });
});

// --- Create a Stripe Checkout Session ---
app.post('/api/create-checkout-session', async (req, res) => {
    const { imageId, buyerEmail } = req.body;

    db.get("SELECT * FROM images WHERE id = ?", [imageId], async (err, image) => {
        if (err || !image) {
            return res.status(404).json({ error: "Image not found." });
        }

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                customer_email: buyerEmail,
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: image.name,
                                images: [image.url],
                            },
                            unit_amount: Math.round(image.price * 100),
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    imageId: image.id,
                    imageName: image.name,
                    price: image.price
                },
                success_url: `${YOUR_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${YOUR_DOMAIN}/index.html`,
            });
            res.json({ id: session.id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// --- Fulfill the order after successful payment ---
app.post('/api/fulfill-order', async (req, res) => {
    const { sessionId } = req.body;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const { imageId, imageName, price } = session.metadata;
            const buyerEmail = session.customer_details.email;
            const transactionId = session.payment_intent;
            const purchaseTime = new Date().toISOString();
            const sql = `INSERT INTO sales (imageId, imageName, price, buyerEmail, purchaseTime, transactionId) VALUES (?, ?, ?, ?, ?, ?)`;
            db.run(sql, [imageId, imageName, parseFloat(price), buyerEmail, purchaseTime, transactionId]);
            
            db.get("SELECT url FROM images WHERE id = ?", [imageId], (err, image) => {
                 if (err || !image) {
                    return res.status(404).json({ error: "Image not found for fulfillment." });
                }
                res.json({ success: true, downloadUrl: image.url, imageName: imageName });
            });

        } else {
            res.status(400).json({ success: false, message: 'Payment not successful.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// GET all sales (no changes here)
app.get('/api/sales', (req, res) => {
    const sql = "SELECT * FROM sales ORDER BY purchaseTime DESC";
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({ data: rows });
    });
});

// Start the server
// This is the second critical fix for Render
app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
});
