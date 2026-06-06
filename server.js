require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4
})
  .then(() => console.log('🔥 MongoDB Connected successfully!'))
  .catch(err => console.error('Database connection failed:', err));

// --- SCHEMAS ---
const CommentSchema = new mongoose.Schema({
    user: { type: String, default: 'Anonymous' },
    text: { type: String, required: true },
    reply: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

const ColorVariantSchema = new mongoose.Schema({
    colorName: { type: String, required: true },
    media: [{ type: String }]
});

const productSchema = new mongoose.Schema({
    id: Number,
    name: String,
    categories: [String], 
    category: String, 
    originalPrice: Number,
    price: Number,
    description: String,
    sizes: [String],
    media: [String], 
    colors: [ColorVariantSchema], 
    comments: [CommentSchema], 
    instaReel: String, // Added Instagram Reel Support
    inStock: Boolean
});
const Product = mongoose.model('Product', productSchema);

const userSchema = new mongoose.Schema({
    id: Number,
    name: String,
    phone: String,
    email: String,
    password: String,
    resetCode: String,
    resetExpiry: Number
});
const User = mongoose.model('User', userSchema);

const orderSchema = new mongoose.Schema({
    orderId: String,
    date: String,
    customer: Object,
    cart: Array,
    total: Number,
    status: String,
    cancellationReason: String,
    videoUrl: String
});
const Order = mongoose.model('Order', orderSchema);

// --- CLOUDINARY + MULTER ---
const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Use memory storage — files are buffered in RAM, then we upload to Cloudinary
// in parallel ourselves. This is MUCH faster than sequential CloudinaryStorage.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,  // 50MB max per file
        files: 20                     // max 20 files per request
    }
});

// Upload a single file buffer to Cloudinary and return the secure URL
const uploadToCloudinary = (fileBuffer, mimetype) => {
    return new Promise((resolve, reject) => {
        const isVideo = mimetype && mimetype.includes('video');
        const uploadOptions = {
            folder: 'zimal_uploads',
            resource_type: isVideo ? 'video' : 'image',
            ...(isVideo
                ? { allowed_formats: ['mp4', 'mov', 'webm'] }
                : {
                    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                    transformation: [
                        { width: 1080, crop: 'limit' },
                        { quality: 'auto', fetch_format: 'auto' }
                    ]
                })
        };
        const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
            if (error) return reject(error);
            resolve(result.secure_url);
        });
        stream.end(fileBuffer);
    });
};

// Upload ALL files in a request to Cloudinary simultaneously (parallel)
const uploadAllFiles = async (files) => {
    if (!files || files.length === 0) return {};
    const uploads = await Promise.all(
        files.map(async (file) => {
            const url = await uploadToCloudinary(file.buffer, file.mimetype);
            return { fieldname: file.fieldname, url };
        })
    );
    // Return a map of fieldname -> [url, url, ...]
    return uploads.reduce((acc, { fieldname, url }) => {
        if (!acc[fieldname]) acc[fieldname] = [];
        acc[fieldname].push(url);
        return acc;
    }, {});
};

// --- APP SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static('.')); 
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
    res.redirect('/website.html'); 
});

// ==================
// --- THE ADMIN BOUNCER ---
// ==================
const adminAuth = (req, res, next) => {
    const password = req.headers['admin-password'];
    if (password === process.env.ADMIN_PASSWORD) {
        next(); 
    } else {
        res.status(401).json({ message: "Intruder alert! Incorrect password." });
    }
};

app.post('/api/verify-admin', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false });
    }
});

// ==================
// PRODUCT ROUTES
// ==================

// ==================
// PRODUCT ROUTES
// ==================

app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (err) {
        res.status(500).json({ message: "Error fetching products." });
    }
});

// urlMap is the result of uploadAllFiles: { fieldname: [url, ...] }
const processColorData = (req, urlMap = {}) => {
    let parsedColors = [];
    if(req.body.colorData) {
        const colorData = JSON.parse(req.body.colorData);
        parsedColors = colorData.map((c, idx) => {
            const newMedia = urlMap[`media_color_${idx}`] || [];
            return {
                colorName: c.colorName || 'Standard',
                media: [...(c.existingMedia || []), ...newMedia]
            };
        });
    }
    return parsedColors;
};

// Extend timeout for upload routes (5 minutes)
const uploadTimeout = (req, res, next) => {
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    next();
};

// NEW: Cloudinary Error Interceptor
const uploadMiddleware = (req, res, next) => {
    const uploader = upload.any();
    uploader(req, res, function (err) {
        if (err) {
            console.error("❌ CLOUDINARY UPLOAD ERROR:", err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ message: "File too large. Max size is 50MB per file." });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ message: "Too many files. Max 20 files per upload." });
            }
            return res.status(500).json({ message: "Upload Error", details: err.message || JSON.stringify(err) });
        }
        next();
    });
};

// Protected Upload Route
app.post('/api/upload', adminAuth, uploadTimeout, uploadMiddleware, async (req, res) => {
    try {
        const { name, categories, originalPrice, price, description, sizes, inStock, instaReel } = req.body;
        
        let catArray = categories ? categories.split(',').map(s=>s.trim()) : [];
        const urlMap = await uploadAllFiles(req.files);  // parallel upload to Cloudinary
        let parsedColors = processColorData(req, urlMap);
        let allMedia = parsedColors.flatMap(c => c.media); 

        const newProduct = new Product({
            id: Date.now(),
            name, 
            categories: catArray, 
            category: catArray[0] || '', 
            originalPrice: Number(originalPrice) || undefined, 
            price: Number(price),
            description, 
            sizes: sizes ? sizes.split(',').map(s=>s.trim()) : [],
            colors: parsedColors,
            media: allMedia,
            instaReel,
            inStock: inStock === 'true' || inStock === true
        });

        await newProduct.save();
        res.json({ message: "Product uploaded successfully!", product: newProduct });
    } catch (error) {
        console.error("❌ DATABASE CRASH:", error);
        res.status(500).json({ message: "Database Error", details: error.message || JSON.stringify(error) });
    }
});

// Protected Update Route
app.put('/api/products/:id', adminAuth, uploadTimeout, uploadMiddleware, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const existingProduct = await Product.findOne({ id: productId });
        if (!existingProduct) return res.status(404).json({ message: "Product not found!" });

        let catArray = req.body.categories ? req.body.categories.split(',').map(s=>s.trim()) : existingProduct.categories;
        const urlMap = await uploadAllFiles(req.files);  // parallel upload to Cloudinary
        let parsedColors = processColorData(req, urlMap);
        let allMedia = parsedColors.flatMap(c => c.media);

        const updated = await Product.findOneAndUpdate(
            { id: productId },
            {
                name: req.body.name, 
                originalPrice: req.body.originalPrice ? parseFloat(req.body.originalPrice) : undefined,
                price: parseFloat(req.body.price), 
                categories: catArray,
                category: catArray[0] || '',
                colors: parsedColors,
                media: allMedia, 
                instaReel: req.body.instaReel,
                inStock: req.body.inStock === 'true' || req.body.inStock === true,
                description: req.body.description, 
                sizes: req.body.sizes ? req.body.sizes.split(',').map(s=>s.trim()) : existingProduct.sizes
            },
            { returnDocument: 'after' } 
        );
        res.json({ message: "Product updated!", product: updated });
    } catch (error) { 
        console.error("❌ DATABASE CRASH:", error);
        res.status(500).json({ message: "Database Error", details: error.message || JSON.stringify(error) }); 
    }
});

app.delete('/api/products/:id', adminAuth, async (req, res) => {
    try {
        const deleted = await Product.findOneAndDelete({ id: parseInt(req.params.id) });
        if (!deleted) return res.status(404).json({ message: "Product not found!" });
        res.json({ message: "Product deleted successfully!" });
    } catch (err) { res.status(500).json({ message: "Error deleting product." }); }
});

app.post('/api/products/:id/comments', async (req, res) => {
    try {
        const product = await Product.findOne({ id: parseInt(req.params.id) });
        if(!product) return res.status(404).json({message: "Not found"});
        
        product.comments.push({
            user: req.body.user || 'Anonymous',
            text: req.body.text
        });
        await product.save();
        res.json(product);
    } catch(err) { res.status(500).json({error: "Failed to post comment"}); }
});

app.put('/api/products/:productId/comments/:commentId/reply', adminAuth, async (req, res) => {
    try {
        const product = await Product.findOne({ id: parseInt(req.params.productId) });
        if (!product) return res.status(404).json({ message: "Product not found" });

        const comment = product.comments.id(req.params.commentId);
        if (!comment) return res.status(404).json({ message: "Comment not found" });

        comment.reply = req.body.reply;
        await product.save();
        
        res.json({ message: "Reply posted successfully!", product });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error replying to comment." });
    }
});

// ==================
// ORDER & USER ROUTES
// ==================

app.get('/api/orders', async (req, res) => {
    try { const orders = await Order.find(); res.json(orders); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        const { customer, cart, total } = req.body;
        const newOrder = new Order({ orderId: 'ORD-' + Date.now(), date: new Date().toLocaleString(), customer, cart, total, status: 'Processing' });
        await newOrder.save();
        res.status(201).json({ message: "Order placed!", orderId: newOrder.orderId });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.put('/api/orders/:orderId/status', adminAuth, async (req, res) => {
    try { await Order.findOneAndUpdate({ orderId: req.params.orderId }, { status: req.body.status }); res.json({ message: "Updated!" }); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.post('/api/orders/:orderId/cancel', upload.single('videoFile'), async (req, res) => {
    try {
        const order = await Order.findOne({ orderId: req.params.orderId });
        let videoUrl = req.file ? (req.file.path || req.file.secure_url || req.file.url) : null;
        if (order.status !== 'Delivered') { order.status = 'Cancelled'; } else { order.status = 'Cancellation Requested'; if (videoUrl) order.videoUrl = videoUrl; }
        order.cancellationReason = req.body.reason; await order.save();
        res.json({ message: "Processed." });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.post('/api/register', async (req, res) => {
    try {
        const { name, phone, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ id: Date.now(), name, phone, email, password: hashedPassword });
        await newUser.save(); res.status(201).json({ message: "Account created!" });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ $or: [{ phone: req.body.identifier }, { email: req.body.identifier }] });
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(401).json({ message: "Invalid." });
        res.json({ message: "Login successful!", user });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

// ==========================================
// ONE-TIME MASS IMAGE COMPRESSION ROUTE
// ==========================================
app.get('/api/fix-all-images', adminAuth, async (req, res) => {
    try {
        const products = await Product.find();
        let updatedCount = 0;

        // This injects the AI compression rules into the URL
        const optimize = (url) => {
            if (url && url.includes('cloudinary.com') && url.includes('/upload/') && !url.includes('q_auto')) {
                return url.replace('/upload/', '/upload/w_1080,c_limit,q_auto,f_auto/');
            }
            return url;
        };

        for (let p of products) {
            let changed = false;

            // Update older standard media arrays
            if (p.media && p.media.length > 0) {
                const newMedia = p.media.map(optimize);
                if (newMedia.join() !== p.media.join()) { 
                    p.media = newMedia; 
                    changed = true; 
                }
            }

            // Update new Color Variant media arrays
            if (p.colors && p.colors.length > 0) {
                p.colors.forEach(c => {
                    if (c.media && c.media.length > 0) {
                        const newCMedia = c.media.map(optimize);
                        if (newCMedia.join() !== c.media.join()) { 
                            c.media = newCMedia; 
                            changed = true; 
                        }
                    }
                });
            }

            if (changed) { 
                await p.save(); 
                updatedCount++; 
            }
        }
        
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: green;">🎉 Success!</h1>
                <h3>Successfully injected AI compression into ${updatedCount} products!</h3>
                <p>Your database is completely updated. Your live site will now load incredibly fast.</p>
            </div>
        `);
    } catch(e) { 
        res.send("Error: " + e.message); 
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});