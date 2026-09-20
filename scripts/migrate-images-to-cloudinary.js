require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://shashankmanohar1734_db_user:Shashankjee123@rgms-2.gm3a3hn.mongodb.net/rgms_db?retryWrites=true&w=majority&appName=RGMS-2';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function migrateImages() {
  console.log('🚀 Starting Base64 to Cloudinary Migration (Streaming Batch Mode)...');
  console.log(`Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
  
  await mongoose.connect(MONGODB_URI, { dbName: 'rgms_db', serverSelectionTimeoutMS: 5000 });
  console.log('✅ Connected to MongoDB Atlas\n');

  const db = mongoose.connection.db;
  const productsColl = db.collection('products');

  let processedCount = 0;
  let migratedCount = 0;
  let failedCount = 0;
  let totalBytesSaved = 0;

  while (true) {
    // Fetch 5 products with base64 images at a time
    const batch = await productsColl.find(
      { image: { $regex: '^data:image' } },
      { projection: { _id: 1, id: 1, name: 1, image: 1 } }
    ).limit(5).toArray();

    if (!batch || batch.length === 0) {
      console.log('✨ No more Base64 images found in database! All products migrated.');
      break;
    }

    for (const prod of batch) {
      processedCount++;
      const imageSize = Buffer.byteLength(prod.image || '');
      console.log(`[#${processedCount}] Migrating "${prod.name}" (${prod.id}) - ${(imageSize / 1024).toFixed(1)} KB...`);

      try {
        const uploadResult = await cloudinary.uploader.upload(prod.image, {
          folder: 'rgms_products',
          resource_type: 'image',
          transformation: [
            { quality: 'auto', fetch_format: 'auto' }
          ]
        });

        const cdnUrl = uploadResult.secure_url;
        const bytesSaved = imageSize - cdnUrl.length;
        totalBytesSaved += bytesSaved;

        await productsColl.updateOne(
          { _id: prod._id },
          { $set: { image: cdnUrl } }
        );

        migratedCount++;
        console.log(`   ✅ Success -> ${cdnUrl} (Saved ${(bytesSaved / 1024).toFixed(1)} KB)`);
      } catch (err) {
        failedCount++;
        console.error(`   ❌ Failed to upload "${prod.name}":`, err.message);
        // Break out of loop if bad credentials so we don't spin infinitely
        if (err.message && err.message.includes('Invalid API key')) {
          console.error('Invalid Cloudinary credentials. Aborting.');
          await mongoose.disconnect();
          return;
        }
      }
    }
  }

  console.log('\n================ MIGRATION REPORT ================');
  console.log(`Total Products Migrated: ${migratedCount}`);
  console.log(`Failed Migrations: ${failedCount}`);
  console.log(`Total DB Payload Saved: ${(totalBytesSaved / (1024 * 1024)).toFixed(2)} MB`);
  console.log('==================================================\n');

  await mongoose.disconnect();
}

migrateImages().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
