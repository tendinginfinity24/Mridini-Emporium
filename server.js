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
const cloudinaryStoragePackage = require('multer-storage-cloudinary');
const CloudinaryStorage = cloudinaryStoragePackage.CloudinaryStorage || cloudinaryStoragePackage;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: require('cloudinary'),
    params: {
        folder: 'zimal_uploads',
        allowed_formats: ['jpg', 'png', 'jpeg', 'mp4', 'mov', 'webm'],
        resource_type: 'auto'
    }
});
const upload = multer({ storage });

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

const processColorData = (req) => {
    let parsedColors = [];
    if(req.body.colorData) {
        const colorData = JSON.parse(req.body.colorData);
        parsedColors = colorData.map((c, idx) => {
            const files = req.files ? req.files.filter(f => f.fieldname === `media_color_${idx}`) : [];
            const newMedia = files.map(f => f.path || f.secure_url || f.url);
            return {
                colorName: c.colorName || 'Standard',
                media: [...(c.existingMedia || []), ...newMedia]
            };
        });
    }
    return parsedColors;
};

// NEW: Cloudinary Error Interceptor
const uploadMiddleware = (req, res, next) => {
    const uploader = upload.any();
    uploader(req, res, function (err) {
        if (err) {
            console.error("❌ CLOUDINARY UPLOAD ERROR:", err);
            return res.status(500).json({ message: "Cloudinary Error", details: err.message || JSON.stringify(err) });
        }
        next();
    });
};

// Protected Upload Route
app.post('/api/upload', adminAuth, uploadMiddleware, async (req, res) => {
    try {
        const { name, categories, originalPrice, price, description, sizes, inStock, instaReel } = req.body;
        
        let catArray = categories ? categories.split(',').map(s=>s.trim()) : [];
        let parsedColors = processColorData(req);
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
app.put('/api/products/:id', adminAuth, uploadMiddleware, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const existingProduct = await Product.findOne({ id: productId });
        if (!existingProduct) return res.status(404).json({ message: "Product not found!" });

        let catArray = req.body.categories ? req.body.categories.split(',').map(s=>s.trim()) : existingProduct.categories;
        let parsedColors = processColorData(req);
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});