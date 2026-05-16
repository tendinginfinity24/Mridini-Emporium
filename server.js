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
const productSchema = new mongoose.Schema({
    id: Number,
    name: String,
    category: String,
    originalPrice: Number,
    price: Number,
    description: String,
    sizes: [String],
    media: [String],
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
// --- THE ADMIN BOUNCER ---
const adminAuth = (req, res, next) => {
    const password = req.headers['admin-password'];
    // Now it checks the secret vault instead of a typed-out string!
    if (password === process.env.ADMIN_PASSWORD) {
        next(); 
    } else {
        res.status(401).json({ message: "Intruder alert! Incorrect password." });
    }
};

// --- NEW: THE FRONT DOOR CHECKER ---
// The HTML page will call this to verify the password safely
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

app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (err) {
        res.status(500).json({ message: "Error fetching products." });
    }
});

// Protected Route!
app.post('/api/upload', adminAuth, upload.array('mediaFiles', 10), async (req, res) => {
    try {
        const { name, category, originalPrice, price, description, sizes, inStock } = req.body;
        const mediaUrls = req.files ? req.files.map(file => file.path || file.secure_url || file.url).filter(url => url) : [];

        const newProduct = new Product({
            id: Date.now(),
            name, category, 
            originalPrice: Number(originalPrice), price: Number(price),
            description, sizes: sizes ? sizes.split(',') : [],
            media: mediaUrls,
            inStock: inStock === 'true' || inStock === true
        });

        await newProduct.save();
        res.json({ message: "Product uploaded successfully!", product: newProduct });
    } catch (error) {
        res.status(500).json({ message: "Error uploading product." });
    }
});

// Protected Route!
app.put('/api/products/:id', adminAuth, upload.array('mediaFiles', 10), async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const existingProduct = await Product.findOne({ id: productId });
        if (!existingProduct) return res.status(404).json({ message: "Product not found!" });

        let keptMedia = [];
        if (req.body.existingMedia !== undefined) {
            if (req.body.existingMedia === '') keptMedia = []; 
            else keptMedia = Array.isArray(req.body.existingMedia) ? req.body.existingMedia : [req.body.existingMedia];
        } else {
            keptMedia = existingProduct.media || []; 
        }

        const newMediaUrls = req.files ? req.files.map(file => file.path || file.secure_url || file.url).filter(url => url) : [];
        const combinedMedia = [...keptMedia, ...newMediaUrls].filter(url => url !== null && url !== undefined && url !== '');

        const updated = await Product.findOneAndUpdate(
            { id: productId },
            {
                name: req.body.name, originalPrice: parseFloat(req.body.originalPrice),
                price: parseFloat(req.body.price), category: req.body.category,
                media: combinedMedia, inStock: req.body.inStock === 'true' || req.body.inStock === true,
                description: req.body.description, sizes: req.body.sizes ? req.body.sizes.split(',') : existingProduct.sizes
            },
            { new: true }
        );
        res.json({ message: "Product updated!", product: updated });
    } catch (err) { res.status(500).json({ message: "Error updating product." }); }
});

// Protected Route!
app.delete('/api/products/:id', adminAuth, async (req, res) => {
    try {
        const deleted = await Product.findOneAndDelete({ id: parseInt(req.params.id) });
        if (!deleted) return res.status(404).json({ message: "Product not found!" });
        res.json({ message: "Product deleted successfully!" });
    } catch (err) { res.status(500).json({ message: "Error deleting product." }); }
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

// Protected Route!
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

app.listen(3000, () => console.log('Server is running on http://localhost:3000'));