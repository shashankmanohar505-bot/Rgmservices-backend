require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://shashankmanohar1734_db_user:Shashankjee123@rgms-2.gm3a3hn.mongodb.net/rgms_db?retryWrites=true&w=majority&appName=RGMS-2';

const Product = require('../models/Product');
const ProductImage = require('../models/ProductImage');

async function separateImages() {
  console.log('🚀 Starting Base64 Separation to ProductImage Collection...');
  await mongoose.connect(MONGODB_URI, { dbName: 'rgms_db', serverSelectionTimeoutMS: 5000 });
  console.log('✅ Connected to MongoDB Atlas\n');

  let processed = 0;
  let migrated = 0;
  let totalSavedBytes = 0;

  while (true) {
    const products = await Product.find(
      { image: { $regex: '^data:image' } },
      { id: 1, name: 1, image: 1 }
    ).limit(10).lean();

    if (!products || products.length === 0) {
      console.log('✨ All products successfully updated! No more raw base64 images in products collection.');
      break;
    }

    for (const p of products) {
      processed++;
      const imgLen = Buffer.byteLength(p.image || '');
      console.log(`[#${processed}] Moving image for "${p.name}" (${p.id}) - ${(imgLen / 1024).toFixed(1)} KB...`);

      try {
        let mimeType = 'image/jpeg';
        const match = p.image.match(/^data:([A-Za-z-+\/]+);base64,/);
        if (match) {
          mimeType = match[1];
        }

        // Save into ProductImage collection
        await ProductImage.findOneAndUpdate(
          { productId: p.id },
          { productId: p.id, data: p.image, mimeType, updatedAt: new Date() },
          { upsert: true, new: true }
        );

        // Update Product with lightweight URL
        const imageUrl = `/api/products/${p.id}/image`;
        await Product.updateOne(
          { _id: p._id },
          { $set: { image: imageUrl } }
        );

        migrated++;
        totalSavedBytes += (imgLen - imageUrl.length);
        console.log(`   ✅ Moved -> ${imageUrl}`);
      } catch (e) {
        console.error(`   ❌ Failed for "${p.name}":`, e.message);
      }
    }
  }

  console.log('\n================ SEPARATION REPORT ================');
  console.log(`Total Products Migrated: ${migrated}`);
  console.log(`Payload Space Freed in Catalog: ${(totalSavedBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log('===================================================\n');

  await mongoose.disconnect();
}

separateImages().catch(err => {
  console.error('Fatal separation error:', err);
  process.exit(1);
});
