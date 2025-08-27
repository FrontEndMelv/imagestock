const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
// IMPORTANT: Add your Stripe secret key here
// You can get this from your Stripe Dashboard: https://dashboard.stripe.com/apikeys
// Keep this key secret and never expose it on the frontend!
const stripe = require('stripe')('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');

const app = express();
const port = process.env.PORT || 3000;
const YOUR_DOMAIN = 'https://trendstock-shop.onrender.com'; // Change this if you deploy

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
    )`, (err) => {
        if (err) console.error("Error creating images table:", err.message);
        else {
            db.get("SELECT COUNT(*) as count FROM images", (err, row) => {
                if (row.count === 0) {
                    console.log("Populating images table with sample data...");
                    const stmt = db.prepare("INSERT INTO images (name, price, url) VALUES (?, ?, ?)");
                    const sampleImages = [
                        { name: "Mountain Landscape", price: 10.00, url: "https://placehold.co/600x400/000000/FFFFFF?text=Mountain" },
                        { name: "City at Night", price: 12.50, url: "https://placehold.co/600x400/333333/FFFFFF?text=City" },
                        { name: "Forest Path", price: 8.00, url: "https://placehold.co/600x400/228B22/FFFFFF?text=Forest" },
                        { name: "Ocean Waves", price: 15.00, url: "https://placehold.co/600x400/0000FF/FFFFFF?text=Ocean" }
                    ];
                    sampleImages.forEach(img => stmt.run(img.name, img.price, img.url));
                    stmt.finalize();
                }
            });
        }
    });

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

// --- NEW: Create a Stripe Checkout Session ---
app.post('/api/create-checkout-session', async (req, res) => {
    const { imageId, buyerEmail } = req.body;

    // 1. Find the image in our database
    db.get("SELECT * FROM images WHERE id = ?", [imageId], async (err, image) => {
        if (err || !image) {
            return res.status(404).json({ error: "Image not found." });
        }

        try {
            // 2. Create a Stripe Checkout Session
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                customer_email: buyerEmail, // Pre-fill the email
                line_items: [
                    {
                        price_data: {
                            currency: 'usd', // Change to your currency
                            product_data: {
                                name: image.name,
                                images: [image.url],
                            },
                            unit_amount: Math.round(image.price * 100), // Price in cents
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                // Store our internal image ID in Stripe's metadata
                metadata: {
                    imageId: image.id,
                    imageName: image.name,
                    price: image.price
                },
                success_url: `${YOUR_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${YOUR_DOMAIN}/index.html`,
            });

            // 3. Send the session ID back to the client
            res.json({ id: session.id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// --- NEW: Fulfill the order after successful payment ---
app.post('/api/fulfill-order', async (req, res) => {
    const { sessionId } = req.body;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Check if the payment was successful
        if (session.payment_status === 'paid') {
            // Retrieve image details from metadata
            const { imageId, imageName, price } = session.metadata;
            const buyerEmail = session.customer_details.email;
            const transactionId = session.payment_intent; // Stripe's payment ID

            // Save the sale to our database
            const purchaseTime = new Date().toISOString();
            const sql = `INSERT INTO sales (imageId, imageName, price, buyerEmail, purchaseTime, transactionId) VALUES (?, ?, ?, ?, ?, ?)`;
            db.run(sql, [imageId, imageName, parseFloat(price), buyerEmail, purchaseTime, transactionId]);

            // Look up the image URL to send back to the user
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
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);

});

