const mongoose = require('mongoose');

const productImageSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true, index: true },
  data: { type: String, required: true },
  mimeType: { type: String, default: 'image/jpeg' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductImage', productImageSchema);
