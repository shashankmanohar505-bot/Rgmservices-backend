require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const Product = require('./models/Product');
const ProductImage = require('./models/ProductImage');
const Admin = require('./models/Admin');
const ContactMessage = require('./models/ContactMessage');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'rgms_super_secret_jwt_key_2026';

// Middleware
app.use(cors({
  origin: [
    'https://rgms-frontend-9s7u.vercel.app',
    'https://rgms-backend.vercel.app',
    'https://www.rgmservices.in',
    'https://rgmservices.in',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
}));
app.options('*', cors());
app.use(express.json({ limit: '20mb' }));

// Configure Multer memory storage for image uploads
const storage = multer.memoryStorage();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Database Connection Flag
let isMongoConnected = false;
let mongoError = null;
let dbConnectionPromise = null;

// Connect to MongoDB
const connectDB = () => {
  const FALLBACK_MONGODB_URI = 'mongodb+srv://shashankmanohar1734_db_user:Shashankjee123@rgms-2.gm3a3hn.mongodb.net/rgms_db?retryWrites=true&w=majority&appName=RGMS-2';
  let connStr = process.env.MONGODB_URI;

  const tryConnect = (uri, isFallback = false) => {
    return mongoose.connect(uri, { 
      dbName: 'rgms_db', 
      serverSelectionTimeoutMS: 3000,
      maxPoolSize: 10,
    })
      .then(() => {
        isMongoConnected = true;
        mongoError = null;
        console.log(`✅ MongoDB Connected Successfully: ${mongoose.connection.host}`);
        // Non-blocking background admin check/seed so cold starts respond in < 150ms
        seedDefaultData().catch(err => console.warn('Background seed notice:', err.message));
      })
      .catch((err) => {
        if (!isFallback && uri !== FALLBACK_MONGODB_URI) {
          console.log(`⚠️ MongoDB connection failed (${err.message}). Retrying with fallback connection string...`);
          dbConnectionPromise = tryConnect(FALLBACK_MONGODB_URI, true);
          return dbConnectionPromise;
        } else {
          isMongoConnected = false;
          mongoError = err.message;
          console.log(`⚠️ MongoDB Connection Failed: ${err.message}`);
        }
      });
  };

  if (!connStr) {
    console.log('⚠️ MONGODB_URI env var is missing. Using fallback connection string.');
    connStr = FALLBACK_MONGODB_URI;
  }

  dbConnectionPromise = tryConnect(connStr, connStr === FALLBACK_MONGODB_URI);
};
connectDB();

// Database Connection Enforcement Middleware
const requireMongoDB = async (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  if (dbConnectionPromise) {
    try {
      await dbConnectionPromise;
    } catch (e) {
      // ignore connection error here, it is handled below
    }
  }
  if (!isMongoConnected) {
    return res.status(503).json({
      error: 'Database connection is offline. Please make sure MONGODB_URI is correctly configured and the database is accessible.',
      details: mongoError
    });
  }
  next();
};
app.use('/api', requireMongoDB);

// Seed default Admin in background without blocking API queries
const seedDefaultData = async () => {
  if (!isMongoConnected) return;
  try {
    const adminCount = await Admin.countDocuments();
    if (adminCount === 0) {
      const hashedPassword = await bcrypt.hash('rgmsadmin', 10);
      await Admin.create({
        username: 'admin',
        password: hashedPassword,
        email: 'rgmsadmin@gmail.com'
      });
      console.log('🔑 Default Admin created (Username: admin, Password: rgmsadmin)');
    }
  } catch (e) {
    console.error('Seeding error:', e.message);
  }
};

// JWT Authentication Middleware for Protecting Admin Routes
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No authentication token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
  }
};

// ================= ADMIN AUTH ROUTES ================= //

// POST /api/admin/login - Authenticate Admin & Issue JWT
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    let isValid = false;
    let adminObj = { username };

    const dbAdmin = await Admin.findOne({
      $or: [{ username: username }, { email: username }]
    }).lean();

    if (dbAdmin) {
      isValid = await bcrypt.compare(password, dbAdmin.password);
      adminObj.username = dbAdmin.username;
      adminObj.email = dbAdmin.email;
    }

    // Default hardcoded admin fallback for quick testing
    if (!isValid && (username === 'admin' || username === 'rgmsadmin@gmail.com') && (password === 'rgmsadmin' || password === 'rgmsadmin@gmail.com')) {
      isValid = true;
      adminObj.username = 'admin';
      adminObj.email = 'rgmsadmin@gmail.com';
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password credentials.' });
    }

    const token = jwt.sign(
      { username: adminObj.username, role: 'admin', email: adminObj.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Admin authentication successful',
      token,
      admin: { username: adminObj.username, email: adminObj.email }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error during authentication: ' + err.message });
  }
});

// GET /api/admin/verify - Verify Token Status
app.get('/api/admin/verify', verifyAdminToken, (req, res) => {
  res.json({ valid: true, admin: req.admin });
});

// ================= IMAGE UPLOAD & SERVING ROUTES ================= //

// POST /api/upload - Upload Image (Cloudinary or internal ProductImage store)
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    let base64Image = null;
    let mimeType = 'image/jpeg';
    if (req.file) {
      mimeType = req.file.mimetype;
      base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    } else if (req.body.image) {
      base64Image = req.body.image;
      const match = base64Image.match(/^data:([A-Za-z-+\/]+);base64,/);
      if (match) mimeType = match[1];
    }

    if (!base64Image) {
      return res.status(400).json({ error: 'No image file or image data provided.' });
    }

    // Check if Cloudinary credentials are configured
    const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET && process.env.CLOUDINARY_CLOUD_NAME !== 'rgms_cloud';

    if (hasCloudinary) {
      try {
        const uploadResult = await cloudinary.uploader.upload(base64Image, {
          folder: 'rgms_products',
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }]
        });
        return res.json({
          url: uploadResult.secure_url,
          public_id: uploadResult.public_id,
          source: 'cloudinary'
        });
      } catch (cloudErr) {
        console.warn('Cloudinary upload error, using optimized internal image store:', cloudErr.message);
      }
    }

    // Store in dedicated ProductImage collection with a temp ID
    const tempId = `temp-${Date.now()}`;
    await ProductImage.create({
      productId: tempId,
      data: base64Image,
      mimeType
    });

    return res.json({
      url: `/api/products/${tempId}/image`,
      tempId,
      source: 'local'
    });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Image upload failed: ' + err.message });
  }
});

// GET /api/products/:id/image - Serve cached binary product image with Edge CDN headers
app.get('/api/products/:id/image', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Check ProductImage collection first
    const imgDoc = await ProductImage.findOne({ productId: id }).lean();
    if (imgDoc && imgDoc.data) {
      const match = imgDoc.data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (match) {
        const contentType = match[1] || imgDoc.mimeType || 'image/jpeg';
        const buffer = Buffer.from(match[2], 'base64');
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
        return res.send(buffer);
      }
    }

    // 2. Fallback to Product collection
    const product = await Product.findOne({ id }).select('image').lean();
    if (product && product.image) {
      if (product.image.startsWith('data:image')) {
        const match = product.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (match) {
          const contentType = match[1] || 'image/jpeg';
          const buffer = Buffer.from(match[2], 'base64');
          res.set('Content-Type', contentType);
          res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
          return res.send(buffer);
        }
      } else if (!product.image.includes('/image')) {
        return res.redirect(product.image);
      }
    }

    res.redirect('/assets/asset-1.png');
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

// ================= PRODUCT REST API ROUTES ================= //

// GET /api/products - Fetch All Products (with Vercel Edge CDN Caching & Lean JSON Query)
app.get('/api/products', async (req, res) => {
  try {
    // Edge Caching: 60s Fresh, 5min Stale-While-Revalidate
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    const category = req.query.category;
    const filter = category && category !== 'all' ? { category } : {};
    const products = await Product.find(filter).sort({ createdAt: -1 }).lean();

    // Map any raw base64 images to lightweight image endpoints
    const optimizedProducts = products.map((p) => {
      if (p.image && p.image.startsWith('data:image')) {
        return { ...p, image: `/api/products/${p.id}/image` };
      }
      return p;
    });

    res.json(optimizedProducts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products: ' + err.message });
  }
});

// GET /api/products/:id - Fetch Single Product
app.get('/api/products/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    const product = await Product.findOne({ id: req.params.id }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (product.image && product.image.startsWith('data:image')) {
      product.image = `/api/products/${product.id}/image`;
    }

    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product: ' + err.message });
  }
});

// POST /api/products - Create Product (Protected by JWT)
app.post('/api/products', verifyAdminToken, async (req, res) => {
  const { name, category, price, oldPrice, badge, rating, reviews, image, stock, description, features, isDeal, isNewArrival, isBestSeller } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Product title is required.' });
  }

  const newId = `prod-${Date.now()}`;
  let finalImage = image || '/assets/asset-1.png';

  // If image is Base64, save to ProductImage collection and store lightweight URL
  if (finalImage.startsWith('data:image')) {
    let mimeType = 'image/jpeg';
    const match = finalImage.match(/^data:([A-Za-z-+\/]+);base64,/);
    if (match) mimeType = match[1];

    try {
      await ProductImage.findOneAndUpdate(
        { productId: newId },
        { productId: newId, data: finalImage, mimeType, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      finalImage = `/api/products/${newId}/image`;
    } catch (e) {
      console.warn('Failed to save ProductImage separately:', e.message);
    }
  }

  const newProduct = {
    id: newId,
    name,
    category: category || 'wifi-cameras',
    price: price !== undefined && price !== null && price !== '' ? Number(price) : null,
    oldPrice: oldPrice ? Number(oldPrice) : null,
    badge: badge || 'NEW',
    rating: Number(rating) || 5.0,
    reviews: Number(reviews) || 0,
    image: finalImage,
    stock: stock !== undefined ? Number(stock) : 20,
    description: description || 'Official RGMS Smart Security Device.',
    features: Array.isArray(features) ? features : (features ? [features] : ['Dedicated Tech Support']),
    isDeal: isDeal !== undefined ? Boolean(isDeal) : false,
    isNewArrival: isNewArrival !== undefined ? Boolean(isNewArrival) : true,
    isBestSeller: isBestSeller !== undefined ? Boolean(isBestSeller) : false
  };

  try {
    const createdProduct = await Product.create(newProduct);
    res.status(201).json({ message: 'Product added successfully to inventory', product: createdProduct });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save product: ' + err.message });
  }
});

// PUT /api/products/:id - Update Product (Protected by JWT)
app.put('/api/products/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  const updateData = { ...req.body };

  // If image is Base64, save to ProductImage collection and store lightweight URL
  if (updateData.image && updateData.image.startsWith('data:image')) {
    let mimeType = 'image/jpeg';
    const match = updateData.image.match(/^data:([A-Za-z-+\/]+);base64,/);
    if (match) mimeType = match[1];

    try {
      await ProductImage.findOneAndUpdate(
        { productId: id },
        { productId: id, data: updateData.image, mimeType, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      updateData.image = `/api/products/${id}/image`;
    } catch (e) {
      console.warn('Failed to save ProductImage separately on update:', e.message);
    }
  }

  try {
    const updatedProduct = await Product.findOneAndUpdate(
      { id },
      { $set: updateData },
      { new: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product updated successfully', product: updatedProduct });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product: ' + err.message });
  }
});

// DELETE /api/products/all - Clear All Products (Protected by JWT)
app.delete('/api/products/all', verifyAdminToken, async (req, res) => {
  try {
    await Product.deleteMany({});
    await ProductImage.deleteMany({});
    res.json({ message: 'All products deleted successfully from inventory' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear products: ' + err.message });
  }
});

// DELETE /api/products/:id - Delete Product (Protected by JWT)
app.delete('/api/products/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;

  try {
    const deleteResult = await Product.deleteOne({ id });
    await ProductImage.deleteOne({ productId: id });
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product deleted successfully', id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product: ' + err.message });
  }
});

// ================= CONTACT MESSAGES API ROUTES ================= //

// POST /api/contact - Public submission from Contact Page
app.post('/api/contact', async (req, res) => {
  const { name, phone, email, subject, message } = req.body;
  if (!name || !phone || !message) {
    return res.status(400).json({ error: 'Name, phone number, and message are required.' });
  }

  const newMessage = {
    id: `msg-${Date.now()}`,
    name: name.trim(),
    phone: phone.trim(),
    email: (email || '').trim(),
    subject: subject || 'General Inquiry',
    message: message.trim(),
    status: 'unread',
    createdAt: new Date().toISOString()
  };

  try {
    const createdMsg = await ContactMessage.create(newMessage);
    res.status(201).json({ message: 'Contact message received successfully', contact: createdMsg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save contact message: ' + err.message });
  }
});

// GET /api/contact - Fetch All Contact Messages for Admin (Protected by JWT)
app.get('/api/contact', verifyAdminToken, async (req, res) => {
  try {
    const msgs = await ContactMessage.find().sort({ createdAt: -1 }).lean();
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch contact messages: ' + err.message });
  }
});

// PUT /api/contact/:id/read - Mark message as read (Protected by JWT)
app.put('/api/contact/:id/read', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const updatedMsg = await ContactMessage.findOneAndUpdate({ id }, { $set: { status: 'read' } }, { new: true });
    if (!updatedMsg) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ message: 'Message marked as read', id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update message status: ' + err.message });
  }
});

// DELETE /api/contact/:id - Delete message (Protected by JWT)
app.delete('/api/contact/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const deleteResult = await ContactMessage.deleteOne({ id });
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ message: 'Message deleted successfully', id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message: ' + err.message });
  }
});

// Root welcome route
app.get('/', (req, res) => {
  res.send('Hello from RGMS Backend!');
});

app.get('/api', (req, res) => {
  res.json({ message: 'Hello from RGMS Backend!' });
});

// Health check
app.get('/api/health', async (req, res) => {
  if (dbConnectionPromise) {
    try {
      await dbConnectionPromise;
    } catch (e) {
      // ignore rejection, it is handled in catch block
    }
  }
  res.json({
    message: 'Hello from RGMS Backend!',
    status: 'ok',
    mongoDB: isMongoConnected ? 'connected' : 'offline_fallback',
    mongoError: mongoError,
    time: new Date().toISOString()
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 RGMS Express Backend REST API running on http://localhost:${PORT}`);
  console.log(`🔐 JWT Auth Protection & ⚡ High-Speed Edge Caching & 📩 Contact Messages System Active.`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const FALLBACK_PORT = Number(PORT) + 1;
    console.log(`⚠️ Port ${PORT} busy, starting Express server on http://localhost:${FALLBACK_PORT}`);
    app.listen(FALLBACK_PORT, () => {
      console.log(`🚀 RGMS Express Backend REST API running on http://localhost:${FALLBACK_PORT}`);
      console.log(`🔐 JWT Auth Protection & ⚡ High-Speed Edge Caching & 📩 Contact Messages System Active.`);
    });
  }
});
