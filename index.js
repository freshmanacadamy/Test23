const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');
require('dotenv').config();

// Global error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '@jumarket';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN environment variable is required');
  process.exit(1);
}

// ========== FIREBASE SETUP ==========
try {
  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/`,
    storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
  });

  console.log('✅ Firebase initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ========== BOT SETUP (NO POLLING) ==========
const bot = new TelegramBot(BOT_TOKEN); // NO POLLING FOR VERCEL

// ========== IN-MEMORY CACHE ==========
const users = new Map();
const products = new Map();
const userStates = new Map();
const adminStates = new Map();
const activeChats = new Map();
const botSettings = new Map();

let productIdCounter = 1;
let maintenanceMode = false;

// Initialize settings
botSettings.set('welcome_message', `🎓 Welcome to Jimma University Marketplace!

🛍️ Buy & Sell within JU Community
📚 Books, 📱 Electronics, 👕 Clothes & more
🛡️ Safe campus transactions
📢 Join our channel: ${CHANNEL_ID}

Start by browsing items or selling yours!`);
botSettings.set('channel_link', CHANNEL_ID);
botSettings.set('bot_username', '');

// Categories
const CATEGORIES = [
  '📚 Academic Books',
  '📱 Electronics', 
  '👕 Clothes & Fashion',
  '🏠 Furniture & Home',
  '📖 Study Materials',
  '🎮 Entertainment',
  '🍔 Food & Drinks',
  '🚗 Transportation',
  '💍 Accessories',
  '📦 Others'
];

// Helper to convert Firestore Timestamps to Dates recursively
function convertTimestamps(data) {
  if (!data) return data;
  const newData = { ...data };
  for (const key in newData) {
    if (newData[key] instanceof admin.firestore.Timestamp) {
      newData[key] = newData[key].toDate();
    } else if (typeof newData[key] === 'object') {
      newData[key] = convertTimestamps(newData[key]);
    }
  }
  return newData;
}

// ========== FIREBASE FUNCTIONS ==========
// Save user to Firebase
async function saveUser(userId, userData) {
  try {
    await db.collection('users').doc(userId.toString()).set({
      ...userData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`✅ User ${userId} saved to Firebase`);
  } catch (error) {
    console.error('❌ Error saving user to Firebase:', error);
  }
}

// Get user from Firebase
async function getUser(userId) {
  try {
    const doc = await db.collection('users').doc(userId.toString()).get();
    if (doc.exists) {
      const userData = convertTimestamps(doc.data());
      users.set(userId, userData); // Update cache
      return userData;
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting user from Firebase:', error);
    return null;
  }
}

// Save product to Firebase
async function saveProduct(product) {
  try {
    // Upload images to Firebase Storage
    const imageUrls = [];
    for (const imageId of product.images) {
      const imageUrl = await uploadImageToStorage(imageId, product.id);
      if (imageUrl) imageUrls.push(imageUrl);
    }

    const productData = {
      ...product,
      images: imageUrls,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('products').doc(product.id.toString()).set(productData);

    // Fetch back to get actual timestamps
    const savedDoc = await db.collection('products').doc(product.id.toString()).get();
    const savedData = convertTimestamps(savedDoc.data());

    console.log(`✅ Product ${product.id} saved to Firebase`);
    return savedData;
  } catch (error) {
    console.error('❌ Error saving product to Firebase:', error);
    return product;
  }
}

// Get product from Firebase
async function getProduct(productId) {
  try {
    const doc = await db.collection('products').doc(productId.toString()).get();
    if (doc.exists) {
      const productData = convertTimestamps(doc.data());
      products.set(productId, productData); // Update cache
      return productData;
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting product from Firebase:', error);
    return null;
  }
}

// Get products with filtering
async function getProducts(filter = {}) {
  try {
    let query = db.collection('products');
    
    if (filter.status) {
      query = query.where('status', '==', filter.status);
    }
    if (filter.sellerId) {
      query = query.where('sellerId', '==', filter.sellerId);
    }
    
    const snapshot = await query.orderBy('createdAt', 'desc').get();
    const productsList = snapshot.docs.map(doc => {
      const product = convertTimestamps(doc.data());
      products.set(product.id, product); // Update cache
      return product;
    });
    
    return productsList;
  } catch (error) {
    console.error('❌ Error getting products from Firebase:', error);
    return Array.from(products.values()).filter(p => 
      (!filter.status || p.status === filter.status) &&
      (!filter.sellerId || p.sellerId === filter.sellerId)
    );
  }
}

// Upload image to Firebase Storage
async function uploadImageToStorage(imageId, productId) {
  try {
    const fileLink = await bot.getFileLink(imageId);
    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const fileName = `products/${productId}/${imageId}.jpg`;
    const file = bucket.file(fileName);
    
    await file.save(buffer, {
      metadata: {
        contentType: 'image/jpeg',
      },
    });
    
    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    
    console.log(`✅ Image uploaded to Firebase Storage: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error('❌ Error uploading image to Firebase:', error);
    return null;
  }
}

// Load all data from Firebase on startup
async function initializeFromFirebase() {
  try {
    console.log('🔄 Loading data from Firebase...');
    
    // Load users
    const usersSnapshot = await db.collection('users').get();
    usersSnapshot.forEach(doc => {
      const userData = convertTimestamps(doc.data());
      users.set(parseInt(doc.id), userData);
    });
    
    // Load products
    const productsSnapshot = await db.collection('products').get();
    productsSnapshot.forEach(doc => {
      const product = convertTimestamps(doc.data());
      products.set(product.id, product);
      // Update productIdCounter
      if (product.id >= productIdCounter) {
        productIdCounter = product.id + 1;
      }
    });
    
    console.log(`✅ Loaded ${users.size} users and ${products.size} products from Firebase`);
  } catch (error) {
    console.error('❌ Error loading data from Firebase:', error);
  }
}

// ========== UTILITY FUNCTIONS ==========
function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function formatUsernameForMarkdown(user) {
  if (!user) return 'No username';
  if (user.username) return '`@' + user.username + '`';
  return user.firstName || 'User';
}

function getBotUsernameForLink() {
  const u = botSettings.get('bot_username') || '';
  return u.startsWith('@') ? u.substring(1) : u;
}

function getChannelForLink() {
  const u = botSettings.get('channel_link') || CHANNEL_ID;
  return u.startsWith('@') ? u.substring(1) : u;
}

// ========== NAVIGATION SYSTEM ==========
function setAdminState(userId, state) {
  adminStates.set(userId, state);
}

function getAdminState(userId) {
  return adminStates.get(userId);
}

// ========== MAINTENANCE MODE ==========
async function handleMaintenanceMode(chatId) {
  await bot.sendMessage(chatId,
    `🔧 *Maintenance Mode*\n\n` +
    `The marketplace is currently undergoing maintenance.\n\n` +
    `We're working to improve your experience and will be back soon!\n\n` +
    `Thank you for your patience!`,
    { parse_mode: 'Markdown' }
  );
}

// ========== MAIN MENU ==========
async function showMainMenu(chatId) {
  const options = {
    reply_markup: {
      keyboard: [
        [{ text: '🛍️ Browse Products' }, { text: '💰 Sell Item' }],
        [{ text: '📦 My Products' }, { text: '📞 Contact Admin' }],
        [{ text: '❓ Help' }]
      ],
      resize_keyboard: true
    }
  };

  await bot.sendMessage(chatId, 
    `🏪 *Jimma University Marketplace*\n\n` +
    `Welcome to JU Student Marketplace!\n\n` +
    `Choose an option below:`,
    { parse_mode: 'Markdown', ...options }
  );
}

// Fetch bot username on startup
async function initializeBot() {
  try {
    const info = await bot.getMe();
    const username = info.username ? `@${info.username}` : '';
    botSettings.set('bot_username', username);
    console.log('✅ Bot username set:', username);
    
    // Load data from Firebase
    await initializeFromFirebase();
  } catch (err) {
    console.error('❌ Failed to initialize bot:', err);
  }
}

// Initialize the bot
initializeBot();

// ========== VERCEL WEBHOOK ENDPOINT ==========
app.post('/api', async (req, res) => {
  try {
    const update = req.body;
    console.log('📨 Received update:', update.update_id);
    
    if (update.message) {
      if (update.message.photo) {
        await handlePhoto(update.message);
      } else if (update.message.text) {
        await handleMessage(update.message);
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    message: 'JU Marketplace Bot is running!',
    timestamp: new Date().toISOString(),
    users: users.size,
    products: products.size,
    maintenance: maintenanceMode
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Export for Vercel
module.exports = app;

console.log('✅ JU Marketplace Bot started successfully with Firebase!');

// ========== PASTE PART 2 BELOW THIS LINE ==========
// ========== MESSAGE HANDLER ==========
async function handleMessage(msg) {
  const text = msg.text;
  if (!text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Handle commands
  if (text.startsWith('/')) {
    await handleCommand(msg);
    return;
  }

  // Handle chat relay first
  if (await handleChatRelay(msg)) return;

  // Handle admin text messages
  if (ADMIN_IDS.includes(userId)) {
    await handleAdminTextMessage(msg);
    return;
  }

  const userState = userStates.get(userId);
  if (userState) {
    await handleProductCreation(msg, userState, userId, chatId);
    return;
  }

  // Handle contact messages to admin
  if (userState && userState.state && userState.state.includes('awaiting_')) {
    await handleContactMessage(msg, userState.state);
    return;
  }
}

// ========== COMMAND HANDLER ==========
async function handleCommand(msg) {
  const text = msg.text;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (maintenanceMode && !ADMIN_IDS.includes(userId)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  const [command, ...args] = text.slice(1).split(' ');
  const lowerCommand = command.toLowerCase();

  switch (lowerCommand) {
    case 'start':
      await handleStart(msg, args[0]);
      break;
    case 'browse':
      await handleBrowse(msg);
      break;
    case 'sell':
      await handleSell(msg);
      break;
    case 'myproducts':
      await handleMyProducts(msg);
      break;
    case 'contact':
      await handleContact(msg);
      break;
    case 'help':
      await handleHelp(msg);
      break;
    case 'admin':
      await handleAdminCommand(msg);
      break;
    case 'cancel':
      await handleCancel(msg);
      break;
    default:
      // Check if it's a keyboard button
      if (text === '🛍️ Browse Products') await handleBrowse(msg);
      else if (text === '💰 Sell Item') await handleSell(msg);
      else if (text === '📦 My Products') await handleMyProducts(msg);
      else if (text === '📞 Contact Admin') await handleContact(msg);
      else if (text === '❓ Help') await handleHelp(msg);
      break;
  }
}

// ========== START COMMAND & USER REGISTRATION ==========
async function handleStart(msg, startParam = null) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (maintenanceMode && !ADMIN_IDS.includes(userId)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  // Register user in Firebase
  let user = users.get(userId);
  if (!user) {
    const userData = {
      telegramId: userId,
      username: msg.from.username || '',
      firstName: msg.from.first_name,
      lastName: msg.from.last_name || '',
      joinedAt: new Date(),
      department: '',
      year: '',
      isBanned: false
    };
    
    users.set(userId, userData);
    await saveUser(userId, userData);
    user = userData;
  }

  if (user.isBanned) {
    await bot.sendMessage(chatId, '🚫 Your account has been banned from using this bot.');
    return;
  }

  // Deep linking handlers
  if (startParam === 'sell') {
    await handleSell(msg);
    return;
  }

  if (startParam && startParam.startsWith('product_')) {
    const productId = parseInt(startParam.replace('product_', ''));
    await handleProductDeepLink(chatId, productId);
    return;
  }

  if (startParam && startParam.startsWith('contact_')) {
    const productId = parseInt(startParam.replace('contact_', ''));
    await handleContactSellerDirect(chatId, userId, productId);
    return;
  }

  // Normal start
  const welcomeMessage = botSettings.get('welcome_message')
    .replace(/{name}/g, msg.from.first_name)
    .replace(/{channel}/g, botSettings.get('channel_link'));

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  await showMainMenu(chatId);
}

// ========== PRODUCT DEEP LINK ==========
async function handleProductDeepLink(chatId, productId) {
  let product = products.get(productId);
  if (!product) {
    product = await getProduct(productId);
  }

  if (!product || product.status !== 'approved') {
    await bot.sendMessage(chatId, '❌ Product not found or no longer available.');
    return;
  }

  const seller = users.get(product.sellerId) || await getUser(product.sellerId);
  const botUsername = getBotUsernameForLink();

  try {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Contact Seller', callback_data: `contact_seller_${productId}` }],
          [{ text: '💰 Sell Item', url: `https://t.me/${botUsername}?start=sell` }],
          [{ text: '⚠️ Report', callback_data: `report_${productId}` }]
        ]
      }
    };

    if (product.images && product.images.length > 0 && product.images[0].startsWith('http')) {
      await bot.sendPhoto(chatId, product.images[0], {
        caption: `🛒 *PRODUCT DETAILS*\n\n` +
                 `*${product.title}*\n` +
                 `💰 *Price:* ${product.price} ETB\n` +
                 `📁 *Category:* ${product.category}\n` +
                 `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
                 `${product.description ? `📝 *Description:* ${product.description}\n` : ''}\n` +
                 `🏫 *Campus Meetup Recommended*`,
        parse_mode: 'Markdown',
        ...keyboard
      });
    } else {
      await bot.sendMessage(chatId,
        `🛒 *PRODUCT DETAILS*\n\n` +
        `*${product.title}*\n` +
        `💰 *Price:* ${product.price} ETB\n` +
        `📁 *Category:* ${product.category}\n` +
        `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
        `${product.description ? `📝 *Description:* ${product.description}\n` : ''}\n` +
        `🏫 *Campus Meetup Recommended*`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    }
  } catch (error) {
    console.error('Error in product deep link:', error);
    await bot.sendMessage(chatId, '❌ Error loading product.');
  }
}

// ========== BROWSE PRODUCTS ==========
async function handleBrowse(msg) {
  const chatId = msg.chat.id;
  if (maintenanceMode && !ADMIN_IDS.includes(msg.from.id)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  const approvedProducts = await getProducts({ status: 'approved' });
  const displayProducts = approvedProducts.slice(0, 10);

  if (displayProducts.length === 0) {
    await bot.sendMessage(chatId,
      `🛍️ *Browse Products*\n\n` +
      `No products available yet.\n\n` +
      `Be the first to list an item!\n` +
      `Use "💰 Sell Item" to get started.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await bot.sendMessage(chatId,
    `🛍️ *Available Products (${displayProducts.length})*\n\n` +
    `Latest items from JU students:`,
    { parse_mode: 'Markdown' }
  );

  for (const product of displayProducts) {
    const seller = users.get(product.sellerId) || await getUser(product.sellerId);
    const botUsername = getBotUsernameForLink();
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Contact Seller', callback_data: `contact_seller_${product.id}` }],
          [{ text: '💰 Sell Item', url: `https://t.me/${botUsername}?start=sell` }]
        ]
      }
    };

    try {
      if (product.images && product.images.length > 0 && product.images[0].startsWith('http')) {
        await bot.sendPhoto(chatId, product.images[0], {
          caption: `*${product.title}*\n\n` +
                   `💰 *Price:* ${product.price} ETB\n` +
                   `📁 *Category:* ${product.category}\n` +
                   `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
                   `${product.description ? `📝 *Description:* ${product.description}\n` : ''}` +
                   `\n🏫 *Campus Meetup*`,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } else {
        await bot.sendMessage(chatId,
          `*${product.title}*\n\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `📁 *Category:* ${product.category}\n` +
          `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
          `${product.description ? `📝 *Description:* ${product.description}\n` : ''}`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }
    } catch (error) {
      console.error(`Error loading product ${product.id}:`, error);
      await bot.sendMessage(chatId, `❌ Error loading product ${product.id}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ========== SELL ITEM ==========
async function handleSell(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (maintenanceMode && !ADMIN_IDS.includes(userId)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  userStates.set(userId, {
    state: 'awaiting_product_image',
    productData: {}
  });

  await bot.sendMessage(chatId,
    `💰 *Sell Your Item - Step 1/5*\n\n` +
    `📸 *Send Product Photo*\n\n` +
    `Please send ONE photo of your item.`,
    { parse_mode: 'Markdown' }
  );
}

// ========== MY PRODUCTS ==========
async function handleMyProducts(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (maintenanceMode && !ADMIN_IDS.includes(userId)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  const userProducts = await getProducts({ sellerId: userId });

  if (userProducts.length === 0) {
    await bot.sendMessage(chatId,
      `📦 *My Products*\n\n` +
      `You haven't listed any products yet.\n\n` +
      `Start selling with "💰 Sell Item"!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let message = `📦 *Your Products (${userProducts.length})*\n\n`;
  userProducts.forEach((p, i) => {
    const statusIcon = p.status === 'approved' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
    const status = p.status === 'approved' ? 'Approved' : p.status === 'pending' ? 'Pending' : 'Rejected';
    message += `${i + 1}. ${statusIcon} *${p.title}*\n`;
    message += `   💰 ${p.price} ETB | 📁 ${p.category}\n\n`;
  });

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ========== PHOTO HANDLER ==========
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates.get(userId);

  if (userState?.state === 'awaiting_product_image') {
    const photo = msg.photo[msg.photo.length - 1];
    userState.productData.images = [photo.file_id];
    userState.state = 'awaiting_product_title';
    userStates.set(userId, userState);

    await bot.sendMessage(chatId,
      `✅ Photo received!\n\n` +
      `💰 *Step 2/5 - Product Title*\n\n` +
      `Enter a clear title:\n\n` +
      `📝 Examples:\n` +
      `• "Calculus Textbook 3rd Edition"\n` +
      `• "iPhone 12 - 128GB - Like New"`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ========== PRODUCT CREATION FLOW ==========
async function handleProductCreation(msg, userState, userId, chatId) {
  const text = msg.text;

  try {
    switch (userState.state) {
      case 'awaiting_product_title':
        if (!text?.trim()) {
          await bot.sendMessage(chatId, '❌ Please enter a title.');
          return;
        }
        userState.productData.title = text.trim();
        userState.state = 'awaiting_product_price';
        userStates.set(userId, userState);

        await bot.sendMessage(chatId,
          `✅ Title: "${text.trim()}"\n\n` +
          `💰 *Step 3/5 - Price*\n\n` +
          `Enter price in ETB (e.g., 1500):`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'awaiting_product_price':
        const price = parseInt(text.replace(/[^\d]/g, ''));
        if (isNaN(price) || price <= 0) {
          await bot.sendMessage(chatId, '❌ Enter valid price (numbers only).');
          return;
        }
        userState.productData.price = price;
        userState.state = 'awaiting_product_description';
        userStates.set(userId, userState);

        await bot.sendMessage(chatId,
          `✅ Price: ${price} ETB\n\n` +
          `💰 *Step 4/5 - Description (optional)*\n\n` +
          `Type /skip to skip`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'awaiting_product_description':
        userState.productData.description = text === '/skip' ? 'No description' : text;
        userState.state = 'awaiting_product_category';
        userStates.set(userId, userState);
        await selectProductCategory(chatId, userId, userState);
        break;
    }
  } catch (error) {
    console.error('Error in product creation:', error);
    await bot.sendMessage(chatId, '❌ Error. Start over with /sell');
    userStates.delete(userId);
  }
}

// ========== CATEGORY SELECTION ==========
async function selectProductCategory(chatId, userId, userState) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        ...CATEGORIES.map(c => [{ text: c, callback_data: `category_${c}` }]),
        [{ text: '❌ Cancel', callback_data: 'cancel_product' }]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `💰 *Step 5/5 - Select Category*\n\n` +
    `Choose the best category:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

// ========== COMPLETE PRODUCT CREATION ==========
async function completeProductCreation(chatId, userId, userState, category, callbackQueryId = null) {
  const product = {
    id: productIdCounter++,
    sellerId: userId,
    title: userState.productData.title,
    description: userState.productData.description,
    price: userState.productData.price,
    category: category,
    images: userState.productData.images || [],
    status: 'pending',
    createdAt: new Date(),
    approvedBy: null
  };

  // Save to Firebase (this will upload images and save product data)
  const savedProduct = await saveProduct(product);
  
  products.set(savedProduct.id, savedProduct);
  userStates.delete(userId);
  await notifyAdminsAboutNewProduct(savedProduct);

  if (callbackQueryId) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '✅ Submitted for approval!' });
  }

  await bot.sendMessage(chatId,
    `✅ *Product Submitted!*\n\n` +
    `*${savedProduct.title}*\n` +
    `💰 ${savedProduct.price} ETB | 📁 ${savedProduct.category}\n\n` +
    `⏳ Waiting for admin approval.`,
    { parse_mode: 'Markdown' }
  );
  await showMainMenu(chatId);
}

// ========== NOTIFY ADMINS ABOUT NEW PRODUCT ==========
async function notifyAdminsAboutNewProduct(product) {
  const seller = users.get(product.sellerId) || await getUser(product.sellerId);
  
  for (const adminId of ADMIN_IDS) {
    try {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Approve', callback_data: `approve_${product.id}` }],
            [{ text: '❌ Reject', callback_data: `reject_${product.id}` }],
            [{ text: '📞 Message Seller', callback_data: `message_seller_${product.sellerId}` }]
          ]
        }
      };

      if (product.images?.length > 0 && product.images[0].startsWith('http')) {
        await bot.sendPhoto(adminId, product.images[0], {
          caption: `🆕 *NEW PRODUCT*\n\n` +
                   `📝 *Title:* ${product.title}\n` +
                   `💰 *Price:* ${product.price} ETB\n` +
                   `📁 *Category:* ${product.category}\n` +
                   `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
                   `${product.description ? `📋 *Desc:* ${product.description}\n` : ''}` +
                   `⏰ *Submitted:* ${product.createdAt.toLocaleString()}`,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } else {
        await bot.sendMessage(adminId,
          `🆕 *NEW PRODUCT*\n\n` + 
          `📝 *Title:* ${product.title}\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `📁 *Category:* ${product.category}\n` +
          `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
          `${product.description ? `📋 *Desc:* ${product.description}\n` : ''}`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }
    } catch (err) {
      console.error(`❌ Notify admin ${adminId} failed:`, err.message);
    }
  }
}

// ========== CANCEL COMMAND ==========
async function handleCancel(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (userStates.has(userId)) {
    userStates.delete(userId);
    await bot.sendMessage(chatId, '✅ Action cancelled.', { parse_mode: 'Markdown' });
    await showMainMenu(chatId);
  }
}

// ========== PASTE PART 3 BELOW THIS LINE ==========
// ========== CALLBACK QUERY HANDLER ==========
async function handleCallbackQuery(callbackQuery) {
  const message = callbackQuery.message;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const chatId = message.chat.id;

  try {
    console.log(`🔄 Processing callback: ${data} from user ${userId}`);

    // ========== PRODUCT CATEGORY SELECTION ==========
    if (data.startsWith('category_')) {
      const category = data.replace('category_', '');
      const userState = userStates.get(userId);
      if (userState?.state === 'awaiting_product_category') {
        await completeProductCreation(chatId, userId, userState, category, callbackQuery.id);
      }
      return;
    }

    // ========== CANCEL PRODUCT CREATION ==========
    if (data === 'cancel_product') {
      userStates.delete(userId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Cancelled' });
      await bot.sendMessage(chatId, '❌ Product creation cancelled.');
      return;
    }

    // ========== CONTACT SELLER ==========
    if (data.startsWith('contact_seller_')) {
      const productId = parseInt(data.replace('contact_seller_', ''));
      await handleContactSeller(chatId, userId, productId, callbackQuery.id);
      return;
    }

    // ========== ADMIN NAVIGATION ==========
    if (data === 'admin_back') {
      await handleAdminBack(callbackQuery);
      return;
    }

    if (data === 'admin_home') {
      await handleAdminHome(callbackQuery);
      return;
    }

    // ========== ADMIN PANEL ==========
    if (data === 'admin_panel') {
      await showAdminPanel(chatId, userId);
      return;
    }

    if (data === 'admin_pending') {
      await showPendingProducts(chatId, userId);
      return;
    }

    if (data === 'admin_users') {
      await showUserManagement(chatId, userId);
      return;
    }

    if (data === 'admin_chats') {
      await showActiveChats(chatId, userId);
      return;
    }

    if (data === 'admin_broadcast') {
      await showBroadcastPanel(chatId, userId);
      return;
    }

    if (data === 'admin_settings') {
      await showBotSettings(chatId, userId);
      return;
    }

    if (data === 'admin_stats') {
      await showAdminStats(chatId, userId);
      return;
    }

    // ========== PRODUCT APPROVAL ==========
    if (data.startsWith('approve_')) {
      const productId = parseInt(data.replace('approve_', ''));
      await handleAdminApproval(productId, callbackQuery, true);
      return;
    }

    if (data.startsWith('reject_')) {
      const productId = parseInt(data.replace('reject_', ''));
      await handleAdminApproval(productId, callbackQuery, false);
      return;
    }

    // ========== ADMIN ACTIONS ==========
    if (data.startsWith('message_seller_')) {
      const sellerId = parseInt(data.replace('message_seller_', ''));
      await handleAdminMessageUser(chatId, userId, sellerId, callbackQuery.id);
      return;
    }

    if (data.startsWith('view_user_')) {
      const targetUserId = parseInt(data.replace('view_user_', ''));
      await handleViewUser(chatId, userId, targetUserId, callbackQuery.id);
      return;
    }

    // ========== BROADCAST ACTIONS ==========
    if (data === 'broadcast_all') {
      await handleBroadcastAll(chatId, userId, callbackQuery.id);
      return;
    }

    if (data === 'broadcast_test') {
      await handleBroadcastTest(chatId, userId, callbackQuery.id);
      return;
    }

    // ========== SETTINGS ACTIONS ==========
    if (data === 'change_bot_username') {
      await handleChangeBotUsername(chatId, userId, callbackQuery.id);
      return;
    }

    if (data === 'change_channel') {
      await handleChangeChannel(chatId, userId, callbackQuery.id);
      return;
    }

    if (data === 'edit_welcome_message') {
      await handleEditWelcomeMessage(chatId, userId, callbackQuery.id);
      return;
    }

    if (data === 'toggle_maintenance') {
      await handleToggleMaintenance(chatId, userId, callbackQuery.id);
      return;
    }

    // ========== CONTACT & REPORTS ==========
    if (data.startsWith('report_')) {
      await handleReportProduct(chatId, userId, data, callbackQuery.id);
      return;
    }

    if (['report_issue', 'give_suggestion', 'urgent_help', 'general_question'].includes(data)) {
      await handleContactAdmin(chatId, userId, data, callbackQuery.id);
      return;
    }

    // ========== END CHAT ==========
    if (data === 'end_chat') {
      await handleEndChat(callbackQuery);
      return;
    }

    // ========== USER MANAGEMENT ==========
    if (data === 'list_all_users') {
      await handleListAllUsers(chatId, userId, 0);
      return;
    }

    if (data.startsWith('users_page_')) {
      const page = parseInt(data.replace('users_page_', ''));
      await handleListAllUsers(chatId, userId, page);
      return;
    }

    if (data.startsWith('ban_user_')) {
      const targetUserId = parseInt(data.replace('ban_user_', ''));
      await handleBanUser(chatId, userId, targetUserId, true, callbackQuery.id);
      return;
    }

    if (data.startsWith('unban_user_')) {
      const targetUserId = parseInt(data.replace('unban_user_', ''));
      await handleBanUser(chatId, userId, targetUserId, false, callbackQuery.id);
      return;
    }

    // ========== BROADCAST CONFIRMATION ==========
    if (data.startsWith('confirm_broadcast_')) {
      await handleConfirmBroadcast(callbackQuery);
      return;
    }

    if (data === 'cancel_broadcast') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Broadcast cancelled' });
      await bot.deleteMessage(chatId, message.message_id);
      return;
    }

    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Unknown action' });

  } catch (error) {
    console.error('❌ Callback error:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error processing request' });
  }
}

// ========== ADMIN PANEL ==========
async function showAdminPanel(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) {
    await bot.sendMessage(chatId, '❌ Admin access required.');
    return;
  }

  const stats = {
    users: users.size,
    products: products.size,
    pending: (await getProducts({ status: 'pending' })).length,
    activeChats: Array.from(activeChats.values()).filter((chat, index, array) => 
      array.findIndex(c => c.productId === chat.productId) === index
    ).length,
    approved: (await getProducts({ status: 'approved' })).length
  };

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: `📋 Pending (${stats.pending})`, callback_data: 'admin_pending' }, { text: `👥 Users (${stats.users})`, callback_data: 'admin_users' }],
        [{ text: `💬 Active Chats (${stats.activeChats})`, callback_data: 'admin_chats' }, { text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
        [{ text: '⚙️ Settings', callback_data: 'admin_settings' }, { text: '📊 Stats', callback_data: 'admin_stats' }],
        [{ text: '🔄 Refresh', callback_data: 'admin_panel' }]
      ]
    }
  };

  setAdminState(userId, { current: 'admin_panel', previous: null });

  await bot.sendMessage(chatId,
    `🛠️ *ADMIN PANEL*\n\n` +
    `📊 *Statistics Overview:*\n` +
    `• 👥 Total Users: ${stats.users}\n` +
    `• 🛒 Total Products: ${stats.products}\n` +
    `• ✅ Approved: ${stats.approved}\n` +
    `• ⏳ Pending: ${stats.pending}\n` +
    `• 💬 Active Chats: ${stats.activeChats}\n\n` +
    `🔧 *Choose an action:*`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

// ========== ADMIN NAVIGATION ==========
async function handleAdminBack(callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const currentState = getAdminState(userId);

  if (currentState?.previous) {
    await currentState.previous(chatId, userId);
  } else {
    await showAdminPanel(chatId, userId);
  }
  
  await bot.answerCallbackQuery(callbackQuery.id, { text: '↩️ Going back...' });
}

async function handleAdminHome(callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  
  adminStates.delete(userId);
  await showAdminPanel(chatId, userId);
  await bot.answerCallbackQuery(callbackQuery.id, { text: '🏠 Returning to admin home...' });
}

// ========== PENDING PRODUCTS ==========
async function showPendingProducts(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const pendingProducts = await getProducts({ status: 'pending' });
  const displayProducts = pendingProducts.slice(0, 10);

  if (displayProducts.length === 0) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
        ]
      }
    };

    await bot.sendMessage(chatId,
      `⏳ *Pending Products*\n\n` +
      `No products waiting for approval.`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    return;
  }

  setAdminState(userId, { 
    current: 'admin_pending', 
    previous: () => showAdminPanel(chatId, userId) 
  });

  for (const product of displayProducts) {
    const seller = users.get(product.sellerId) || await getUser(product.sellerId);
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Approve', callback_data: `approve_${product.id}` }, { text: '❌ Reject', callback_data: `reject_${product.id}` }],
          [{ text: '📞 Message Seller', callback_data: `message_seller_${product.sellerId}` }, { text: '👤 View Seller', callback_data: `view_user_${product.sellerId}` }],
          [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
        ]
      }
    };

    try {
      if (product.images?.length > 0 && product.images[0].startsWith('http')) {
        await bot.sendPhoto(chatId, product.images[0], {
          caption: `⏳ *PENDING PRODUCT*\n\n` +
                   `📝 *Title:* ${product.title}\n` +
                   `💰 *Price:* ${product.price} ETB\n` +
                   `📁 *Category:* ${product.category}\n` +
                   `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
                   `${product.description ? `📋 *Description:* ${product.description}\n` : ''}` +
                   `⏰ *Submitted:* ${getTimeAgo(product.createdAt)}`,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } else {
        await bot.sendMessage(chatId,
          `⏳ *PENDING PRODUCT*\n\n` +
          `📝 *Title:* ${product.title}\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `📁 *Category:* ${product.category}\n` +
          `👤 *Seller:* ${formatUsernameForMarkdown(seller)}\n` +
          `${product.description ? `📋 *Description:* ${product.description}\n` : ''}`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }
    } catch (error) {
      console.error('Error sending pending product:', error);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ========== ADMIN APPROVAL SYSTEM ==========
async function handleAdminApproval(productId, callbackQuery, approve) {
  const adminId = callbackQuery.from.id;
  const message = callbackQuery.message;
  
  if (!ADMIN_IDS.includes(adminId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Admin access required' });
    return;
  }

  let product = products.get(productId);
  if (!product) {
    product = await getProduct(productId);
  }

  if (!product) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Product not found' });
    return;
  }

  // Remove buttons immediately
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: message.chat.id,
      message_id: message.message_id
    });
  } catch (error) {
    console.error('Error removing buttons:', error);
  }

  if (approve) {
    product.status = 'approved';
    product.approvedBy = adminId;
    product.approvedAt = new Date();

    // Update in Firebase
    await saveProduct(product);

    const botUsername = getBotUsernameForLink();
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Contact Seller', url: `https://t.me/${botUsername}?start=contact_${product.id}` }],
          [{ text: '💰 Sell Item', url: `https://t.me/${botUsername}?start=sell` }]
        ]
      }
    };

    try {
      if (product.images?.length > 0 && product.images[0].startsWith('http')) {
        await bot.sendPhoto(CHANNEL_ID, product.images[0], {
          caption: `🛒 *${product.title}*\n\n` +
                   `💰 *Price:* ${product.price} ETB\n` +
                   `📁 *Category:* ${product.category}\n` +
                   `${product.description ? `📝 *Description:* ${product.description}\n` : ''}` +
                   `\n🏫 *Jimma University Campus*\n` +
                   `\n💬 Contact via @${botUsername}`,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } else {
        await bot.sendMessage(CHANNEL_ID,
          `🛒 *${product.title}*\n\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `📁 *Category:* ${product.category}\n` +
          `${product.description ? `📝 *Description:* ${product.description}\n` : ''}` +
          `\n💬 Contact via @${botUsername}`,
          { parse_mode: 'Markdown', ...keyboard }
        );
      }

      // Notify seller
      await bot.sendMessage(product.sellerId,
        `✅ *Your product has been approved!*\n\n` +
        `*${product.title}*\n` +
        `💰 ${product.price} ETB | 📁 ${product.category}\n\n` +
        `📢 Now live in ${botSettings.get('channel_link')}\n` +
        `🎉 Start receiving buyer messages!`,
        { parse_mode: 'Markdown' }
      );

      await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Product approved & posted!' });
      
      // Update admin message
      try {
        if (message.photo) {
          await bot.editMessageCaption(
            `✅ *APPROVED PRODUCT*\n\n` +
            `📝 *Title:* ${product.title}\n` +
            `💰 *Price:* ${product.price} ETB\n` +
            `👤 *Seller:* ${formatUsernameForMarkdown(users.get(product.sellerId))}\n` +
            `✅ *Approved by:* You\n` +
            `⏰ *Approved at:* ${new Date().toLocaleString()}`,
            {
              chat_id: message.chat.id,
              message_id: message.message_id,
              parse_mode: 'Markdown'
            }
          );
        } else {
          await bot.editMessageText(
            `✅ *APPROVED PRODUCT*\n\n` +
            `📝 *Title:* ${product.title}\n` +
            `💰 *Price:* ${product.price} ETB\n` +
            `👤 *Seller:* ${formatUsernameForMarkdown(users.get(product.sellerId))}\n` +
            `✅ *Approved by:* You\n` +
            `⏰ *Approved at:* ${new Date().toLocaleString()}`,
            {
              chat_id: message.chat.id,
              message_id: message.message_id,
              parse_mode: 'Markdown'
            }
          );
        }
      } catch (editError) {
        console.error('Error updating message:', editError);
      }

    } catch (err) {
      console.error('❌ Channel post failed:', err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Channel post failed' });
    }
  } else {
    product.status = 'rejected';
    
    // Update in Firebase
    await saveProduct(product);
    
    // Notify seller
    await bot.sendMessage(product.sellerId,
      `❌ *Product Not Approved*\n\n` +
      `*${product.title}*\n` +
      `💰 ${product.price} ETB | 📁 ${product.category}\n\n` +
      `Your product did not meet our guidelines.\n` +
      `Please ensure:\n` +
      `• Clear photos\n` +
      `• Accurate description\n` +
      `• Reasonable pricing\n\n` +
      `You can submit again with /sell`,
      { parse_mode: 'Markdown' }
    );

    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Product rejected' });
    
    // Update admin message
    try {
      if (message.photo) {
        await bot.editMessageCaption(
          `❌ *REJECTED PRODUCT*\n\n` +
          `📝 *Title:* ${product.title}\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `👤 *Seller:* ${formatUsernameForMarkdown(users.get(product.sellerId))}\n` +
          `❌ *Rejected by:* You\n` +
          `⏰ *Rejected at:* ${new Date().toLocaleString()}`,
          {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'Markdown'
          }
        );
      } else {
        await bot.editMessageText(
          `❌ *REJECTED PRODUCT*\n\n` +
          `📝 *Title:* ${product.title}\n` +
          `💰 *Price:* ${product.price} ETB\n` +
          `👤 *Seller:* ${formatUsernameForMarkdown(users.get(product.sellerId))}\n` +
          `❌ *Rejected by:* You\n` +
          `⏰ *Rejected at:* ${new Date().toLocaleString()}`,
          {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'Markdown'
          }
        );
      }
    } catch (editError) {
      console.error('Error updating message:', editError);
    }
  }
}

// ========== ADMIN COMMANDS ==========
async function handleAdminCommand(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await showAdminPanel(chatId, userId);
}

// ========== PASTE PART 4 BELOW THIS LINE ==========
// ========== CONTACT SELLER SYSTEM ==========
async function handleContactSeller(chatId, userId, productId, callbackQueryId) {
  let product = products.get(productId);
  if (!product) {
    product = await getProduct(productId);
  }

  if (!product || product.status !== 'approved') {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Product not available' });
    return;
  }

  const buyerId = userId;
  const sellerId = product.sellerId;

  if (buyerId === sellerId) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ You are the seller!' });
    return;
  }

  // Check if chat already exists
  if (activeChats.has(buyerId) || activeChats.has(sellerId)) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ Chat already active' });
    return;
  }

  // Create chat session
  const chatSession = {
    buyerId: buyerId,
    sellerId: sellerId,
    productId: productId,
    startTime: new Date(),
    messages: []
  };

  activeChats.set(buyerId, chatSession);
  activeChats.set(sellerId, chatSession);

  const endButton = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔚 End Chat', callback_data: 'end_chat' }]
      ]
    }
  };

  // Notify buyer
  await bot.sendMessage(buyerId,
    `💬 *Chat Started with Seller*\n\n` +
    `🛒 *Product:* ${product.title}\n` +
    `💰 *Price:* ${product.price} ETB\n\n` +
    `💡 Type your message below to contact the seller.\n` +
    `🛡️ Meet in safe campus locations.\n` +
    `💵 Use cash for transactions.`,
    { parse_mode: 'Markdown', ...endButton }
  );

  // Notify seller
  await bot.sendMessage(sellerId,
    `💬 *Buyer Interested in Your Product*\n\n` +
    `🛒 *Product:* ${product.title}\n` +
    `💰 *Price:* ${product.price} ETB\n\n` +
    `👤 *Buyer:* ${formatUsernameForMarkdown(users.get(buyerId))}\n` +
    `💡 Reply to this chat to communicate with the buyer.\n` +
    `🛡️ Meet in safe campus locations.\n` +
    `💵 Use cash for transactions.`,
    { parse_mode: 'Markdown', ...endButton }
  );

  // Notify all admins
  for (const adminId of ADMIN_IDS) {
    try {
      const adminKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '👀 View Chat', callback_data: `admin_view_chat_${productId}` }],
            [{ text: '📞 Join Chat', callback_data: `admin_join_chat_${productId}` }]
          ]
        }
      };

      const buyer = users.get(buyerId) || await getUser(buyerId);
      const seller = users.get(sellerId) || await getUser(sellerId);

      await bot.sendMessage(adminId,
        `💬 *NEW CHAT STARTED*\n\n` +
        `🛒 *Product:* ${product.title}\n` +
        `👤 *Buyer:* ${formatUsernameForMarkdown(buyer)} (\`${buyerId}\`)\n` +
        `👤 *Seller:* ${formatUsernameForMarkdown(seller)} (\`${sellerId}\`)\n` +
        `⏰ *Started:* ${new Date().toLocaleString()}`,
        { parse_mode: 'Markdown', ...adminKeyboard }
      );
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err.message);
    }
  }

  await bot.answerCallbackQuery(callbackQueryId, { text: '💬 Chat opened with seller!' });
}

// ========== CHAT RELAY SYSTEM ==========
async function handleChatRelay(msg) {
  const userId = msg.from.id;
  const text = msg.text;
  const chatInfo = activeChats.get(userId);
  
  if (!chatInfo) return false;

  const partnerId = userId === chatInfo.buyerId ? chatInfo.sellerId : chatInfo.buyerId;
  const product = products.get(chatInfo.productId);
  const userRole = userId === chatInfo.buyerId ? 'Buyer' : 'Seller';

  // Store message
  chatInfo.messages.push({
    from: userId,
    text: text,
    time: new Date(),
    role: userRole
  });

  // Update both chat sessions
  activeChats.set(userId, chatInfo);
  activeChats.set(partnerId, chatInfo);

  // Forward message to partner
  const forwardMessage = `💬 *${userRole}:* ${text}\n\n` +
                        `🛒 *Item:* ${product.title}`;

  await bot.sendMessage(partnerId, forwardMessage, { parse_mode: 'Markdown' });
  await bot.sendMessage(msg.chat.id, '✅ Message sent!', { parse_mode: 'Markdown' });

  return true;
}

// ========== END CHAT ==========
async function handleEndChat(callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const chatInfo = activeChats.get(userId);

  if (!chatInfo) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ No active chat' });
    return;
  }

  const partnerId = userId === chatInfo.buyerId ? chatInfo.sellerId : chatInfo.buyerId;
  
  // Remove chat sessions
  activeChats.delete(userId);
  activeChats.delete(partnerId);

  // Notify both parties
  await bot.sendMessage(userId, '🔚 Chat ended. Thank you for using JU Marketplace!');
  await bot.sendMessage(partnerId, '🔚 The other party ended the chat.');

  await bot.answerCallbackQuery(callbackQuery.id, { text: '🔚 Chat ended' });
  
  // Remove end chat button
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id
    });
  } catch (error) {
    console.error('Error removing end chat button:', error);
  }
}

// ========== ACTIVE CHATS MANAGEMENT ==========
async function showActiveChats(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const activeChatList = Array.from(activeChats.values())
    .filter((chat, index, array) => 
      array.findIndex(c => c.productId === chat.productId) === index
    )
    .slice(0, 10);

  if (activeChatList.length === 0) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
        ]
      }
    };

    await bot.sendMessage(chatId,
      `💬 *Active Chats*\n\n` +
      `No active chats at the moment.`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    return;
  }

  setAdminState(userId, { 
    current: 'admin_chats', 
    previous: () => showAdminPanel(chatId, userId) 
  });

  let message = `💬 *Active Chats (${activeChatList.length})*\n\n`;
  
  activeChatList.forEach((chat, index) => {
    const product = products.get(chat.productId);
    const buyer = users.get(chat.buyerId);
    const seller = users.get(chat.sellerId);
    const duration = Math.floor((new Date() - chat.startTime) / 60000); // minutes
    
    message += `${index + 1}. *${product.title}*\n`;
    message += `   👤 ${buyer?.firstName || 'Unknown'} ↔ ${seller?.firstName || 'Unknown'}\n`;
    message += `   💬 ${chat.messages.length} msgs | ⏰ ${duration}m\n\n`;
  });

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👀 View All Chats', callback_data: 'admin_view_all_chats' }],
        [{ text: '🔄 Refresh', callback_data: 'admin_chats' }],
        [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
}

// ========== BROADCAST SYSTEM ==========
async function showBroadcastPanel(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Broadcast to All', callback_data: 'broadcast_all' }],
        [{ text: '👨‍💼 Test with Admins', callback_data: 'broadcast_test' }],
        [{ text: '👤 Message Specific User', callback_data: 'message_specific_user' }],
        [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  setAdminState(userId, { 
    current: 'admin_broadcast', 
    previous: () => showAdminPanel(chatId, userId) 
  });

  await bot.sendMessage(chatId,
    `📢 *Broadcast System*\n\n` +
    `Send messages to users:\n` +
    `• 👥 All users (${users.size} total)\n` +
    `• 👨‍💼 Admin team only\n` +
    `• 👤 Specific user by ID\n\n` +
    `Choose an option:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function handleBroadcastAll(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  userStates.set(userId, {
    state: 'awaiting_broadcast_message',
    broadcastType: 'all'
  });

  await bot.sendMessage(chatId,
    `📢 *Broadcast to All Users*\n\n` +
    `Send the message you want to broadcast to *${users.size}* users:\n\n` +
    `💡 Tips:\n` +
    `• Use Markdown formatting\n` +
    `• Keep it clear and concise\n` +
    `• Include important details`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Type your broadcast message' });
}

async function handleBroadcastTest(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  userStates.set(userId, {
    state: 'awaiting_broadcast_message',
    broadcastType: 'test'
  });

  await bot.sendMessage(chatId,
    `👨‍💼 *Test Broadcast with Admins*\n\n` +
    `Send the message to test with *${ADMIN_IDS.length}* admins first:\n\n` +
    `💡 This helps you preview before sending to all users.`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Type test message' });
}

// ========== BOT SETTINGS MANAGEMENT ==========
async function showBotSettings(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const currentBotUsername = botSettings.get('bot_username') || 'Not set';
  const currentChannel = botSettings.get('channel_link') || CHANNEL_ID;
  const maintenanceStatus = maintenanceMode ? '🔴 ON' : '🟢 OFF';

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Change Bot Username', callback_data: 'change_bot_username' }],
        [{ text: '✏️ Change Channel', callback_data: 'change_channel' }],
        [{ text: '📝 Edit Welcome Message', callback_data: 'edit_welcome_message' }],
        [{ text: `🔧 Maintenance: ${maintenanceStatus}`, callback_data: 'toggle_maintenance' }],
        [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  setAdminState(userId, { 
    current: 'admin_settings', 
    previous: () => showAdminPanel(chatId, userId) 
  });

  await bot.sendMessage(chatId,
    `⚙️ *Bot Settings*\n\n` +
    `🤖 *Bot Username:* ${currentBotUsername}\n` +
    `📢 *Channel:* ${currentChannel}\n` +
    `🔧 *Maintenance Mode:* ${maintenanceStatus}\n\n` +
    `Manage bot configuration:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function handleChangeBotUsername(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  userStates.set(userId, {
    state: 'awaiting_bot_username'
  });

  await bot.sendMessage(chatId,
    `✏️ *Change Bot Username*\n\n` +
    `Current: ${botSettings.get('bot_username') || 'Not set'}\n\n` +
    `Send the new bot username (include @):\n` +
    `Example: @JU_MarketplaceBot\n\n` +
    `💡 This will update all product links immediately.`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '✏️ Type new bot username' });
}

async function handleChangeChannel(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  userStates.set(userId, {
    state: 'awaiting_channel_username'
  });

  await bot.sendMessage(chatId,
    `✏️ *Change Channel*\n\n` +
    `Current: ${botSettings.get('channel_link')}\n\n` +
    `Send the new channel username (include @):\n` +
    `Example: @jumarket\n\n` +
    `💡 This will update all channel references immediately.`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '✏️ Type new channel username' });
}

async function handleEditWelcomeMessage(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  userStates.set(userId, {
    state: 'awaiting_welcome_message'
  });

  const currentWelcome = botSettings.get('welcome_message');

  await bot.sendMessage(chatId,
    `📝 *Edit Welcome Message*\n\n` +
    `*Current Message:*\n${currentWelcome}\n\n` +
    `Send the new welcome message:\n\n` +
    `💡 Available variables:\n` +
    `• {name} - User's first name\n` +
    `• {channel} - Channel username\n` +
    `• Use Markdown for formatting`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Type new welcome message' });
}

async function handleToggleMaintenance(chatId, userId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  maintenanceMode = !maintenanceMode;
  
  await bot.sendMessage(chatId,
    `🔧 *Maintenance Mode ${maintenanceMode ? 'ENABLED' : 'DISABLED'}*\n\n` +
    `The bot is now ${maintenanceMode ? 'in maintenance mode' : 'operational'}.\n` +
    `${maintenanceMode ? 'Regular users will see maintenance message.' : 'All features are available.'}`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { 
    text: `Maintenance ${maintenanceMode ? 'ON' : 'OFF'}` 
  });

  // Refresh settings panel
  await showBotSettings(chatId, userId);
}

// ========== ADMIN STATISTICS ==========
async function showAdminStats(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const stats = {
    totalUsers: users.size,
    activeUsers: Array.from(users.values()).filter(u => 
      new Date() - u.joinedAt < 30 * 24 * 60 * 60 * 1000
    ).length,
    totalProducts: products.size,
    approvedProducts: (await getProducts({ status: 'approved' })).length,
    pendingProducts: (await getProducts({ status: 'pending' })).length,
    rejectedProducts: (await getProducts({ status: 'rejected' })).length,
    activeChats: Array.from(activeChats.values()).filter((chat, index, array) => 
      array.findIndex(c => c.productId === chat.productId) === index
    ).length
  };

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_stats' }],
        [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `📊 *Detailed Statistics*\n\n` +
    `👥 *Users:*\n` +
    `• Total: ${stats.totalUsers}\n` +
    `• Active (30 days): ${stats.activeUsers}\n\n` +
    `🛒 *Products:*\n` +
    `• Total: ${stats.totalProducts}\n` +
    `• ✅ Approved: ${stats.approvedProducts}\n` +
    `• ⏳ Pending: ${stats.pendingProducts}\n` +
    `• ❌ Rejected: ${stats.rejectedProducts}\n\n` +
    `💬 *Chats:*\n` +
    `• Active: ${stats.activeChats}\n\n` +
    `⚙️ *System:*\n` +
    `• Maintenance: ${maintenanceMode ? '🔴 ON' : '🟢 OFF'}\n` +
    `• Admins: ${ADMIN_IDS.length}`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

// ========== PASTE PART 5 BELOW THIS LINE ==========
// ========== USER MANAGEMENT ==========
async function showUserManagement(chatId, userId) {
  if (!ADMIN_IDS.includes(userId)) return;

  const totalUsers = users.size;
  const activeUsers = Array.from(users.values()).filter(u => 
    new Date() - u.joinedAt < 30 * 24 * 60 * 60 * 1000
  ).length;
  const bannedUsers = Array.from(users.values()).filter(u => u.isBanned).length;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: `📋 List All Users (${totalUsers})`, callback_data: 'list_all_users' }],
        [{ text: `🔍 Search User`, callback_data: 'search_user' }],
        [{ text: `📊 User Statistics`, callback_data: 'user_statistics' }],
        [{ text: `🚫 Banned Users (${bannedUsers})`, callback_data: 'banned_users' }],
        [{ text: '⬅️ Back', callback_data: 'admin_back' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  setAdminState(userId, { 
    current: 'admin_users', 
    previous: () => showAdminPanel(chatId, userId) 
  });

  await bot.sendMessage(chatId,
    `👥 *User Management*\n\n` +
    `📊 *Overview:*\n` +
    `• 👥 Total Users: ${totalUsers}\n` +
    `• 🟢 Active (30 days): ${activeUsers}\n` +
    `• 🔴 Banned: ${bannedUsers}\n\n` +
    `Manage users and permissions:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function handleListAllUsers(chatId, userId, page = 0) {
  if (!ADMIN_IDS.includes(userId)) return;

  const usersList = Array.from(users.values());
  const pageSize = 10;
  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedUsers = usersList.slice(startIndex, endIndex);

  if (paginatedUsers.length === 0) {
    await bot.sendMessage(chatId, '❌ No users found.');
    return;
  }

  let message = `📋 *All Users (Page ${page + 1})*\n\n`;
  
  paginatedUsers.forEach((user, index) => {
    const userNumber = startIndex + index + 1;
    const status = user.isBanned ? '🔴 BANNED' : '🟢 ACTIVE';
    const productsCount = Array.from(products.values()).filter(p => p.sellerId === user.telegramId).length;
    
    message += `${userNumber}. *${user.firstName}* ${user.username ? `(@${user.username})` : ''}\n`;
    message += `   🆔: \`${user.telegramId}\` | ${status}\n`;
    message += `   📅 Joined: ${user.joinedAt.toLocaleDateString()}\n`;
    message += `   🛒 Products: ${productsCount}\n\n`;
  });

  const keyboardButtons = [];
  
  // User action buttons for first user on page
  if (paginatedUsers.length > 0) {
    const firstUser = paginatedUsers[0];
    keyboardButtons.push([
      { text: '👤 View User', callback_data: `view_user_${firstUser.telegramId}` },
      { text: '📞 Message', callback_data: `message_user_${firstUser.telegramId}` }
    ]);
    
    if (firstUser.isBanned) {
      keyboardButtons[0].push({ text: '🔓 Unban', callback_data: `unban_user_${firstUser.telegramId}` });
    } else {
      keyboardButtons[0].push({ text: '🚫 Ban', callback_data: `ban_user_${firstUser.telegramId}` });
    }
  }

  // Pagination buttons
  const paginationButtons = [];
  if (page > 0) {
    paginationButtons.push({ text: '⬅️ Previous', callback_data: `users_page_${page - 1}` });
  }
  if (endIndex < usersList.length) {
    paginationButtons.push({ text: 'Next ➡️', callback_data: `users_page_${page + 1}` });
  }
  
  if (paginationButtons.length > 0) {
    keyboardButtons.push(paginationButtons);
  }

  keyboardButtons.push([
    { text: '⬅️ Back', callback_data: 'admin_users' },
    { text: '🏠 Home', callback_data: 'admin_home' }
  ]);

  const keyboard = {
    reply_markup: {
      inline_keyboard: keyboardButtons
    }
  };

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
}

async function handleViewUser(chatId, userId, targetUserId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  let targetUser = users.get(targetUserId);
  if (!targetUser) {
    targetUser = await getUser(targetUserId);
  }

  if (!targetUser) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ User not found' });
    return;
  }

  const userProducts = await getProducts({ sellerId: targetUserId });
  const approvedProducts = userProducts.filter(p => p.status === 'approved').length;
  const pendingProducts = userProducts.filter(p => p.status === 'pending').length;
  const rejectedProducts = userProducts.filter(p => p.status === 'rejected').length;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📞 Message User', callback_data: `message_user_${targetUserId}` }],
        [{ text: '🛒 View Products', callback_data: `view_user_products_${targetUserId}` }],
        [
          { text: targetUser.isBanned ? '🔓 Unban User' : '🚫 Ban User', 
            callback_data: targetUser.isBanned ? `unban_user_${targetUserId}` : `ban_user_${targetUserId}` 
          }
        ],
        [{ text: '⬅️ Back to Users', callback_data: 'admin_users' }, { text: '🏠 Home', callback_data: 'admin_home' }]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `👤 *User Profile*\n\n` +
    `*Name:* ${targetUser.firstName} ${targetUser.lastName || ''}\n` +
    `*Username:* ${targetUser.username ? `@${targetUser.username}` : 'Not set'}\n` +
    `*User ID:* \`${targetUser.telegramId}\`\n` +
    `*Status:* ${targetUser.isBanned ? '🔴 BANNED' : '🟢 ACTIVE'}\n` +
    `*Joined:* ${targetUser.joinedAt.toLocaleString()}\n\n` +
    `🛒 *Product Stats:*\n` +
    `• ✅ Approved: ${approvedProducts}\n` +
    `• ⏳ Pending: ${pendingProducts}\n` +
    `• ❌ Rejected: ${rejectedProducts}\n` +
    `• 📊 Total: ${userProducts.length}`,
    { parse_mode: 'Markdown', ...keyboard }
  );

  if (callbackQueryId) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '✅ User profile loaded' });
  }
}

async function handleAdminMessageUser(chatId, userId, targetUserId, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  let targetUser = users.get(targetUserId);
  if (!targetUser) {
    targetUser = await getUser(targetUserId);
  }

  if (!targetUser) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ User not found' });
    return;
  }

  userStates.set(userId, {
    state: 'awaiting_individual_message',
    targetUserId: targetUserId
  });

  await bot.sendMessage(chatId,
    `📨 *Message User*\n\n` +
    `*Recipient:* ${targetUser.firstName} ${targetUser.username ? `(@${targetUser.username})` : ''}\n` +
    `*User ID:* \`${targetUserId}\`\n\n` +
    `Type your message to send:`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Type your message' });
}

async function handleBanUser(chatId, userId, targetUserId, ban, callbackQueryId) {
  if (!ADMIN_IDS.includes(userId)) return;

  let targetUser = users.get(targetUserId);
  if (!targetUser) {
    targetUser = await getUser(targetUserId);
  }

  if (!targetUser) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '❌ User not found' });
    return;
  }

  targetUser.isBanned = ban;
  users.set(targetUserId, targetUser);
  await saveUser(targetUserId, targetUser);

  const action = ban ? 'banned' : 'unbanned';
  await bot.sendMessage(chatId,
    `✅ *User ${action}*\n\n` +
    `*${targetUser.firstName}* ${targetUser.username ? `(@${targetUser.username})` : ''}\n` +
    `User ID: \`${targetUserId}\`\n\n` +
    `${ban ? '🚫 User can no longer use the bot.' : '🟢 User can now use the bot again.'}`,
    { parse_mode: 'Markdown' }
  );

  if (ban) {
    await bot.sendMessage(targetUserId,
      `🚫 *Account Banned*\n\n` +
      `Your account has been banned from using JU Marketplace.\n\n` +
      `If you believe this is a mistake, please contact the admin team.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await bot.sendMessage(targetUserId,
      `✅ *Account Unbanned*\n\n` +
      `Your account has been restored. You can now use JU Marketplace again.\n\n` +
      `Welcome back!`,
      { parse_mode: 'Markdown' }
    );
  }

  await bot.answerCallbackQuery(callbackQueryId, { text: `User ${action}` });
}

// ========== BROADCAST MESSAGE HANDLER ==========
async function handleBroadcastMessage(userId, chatId, text, broadcastType) {
  if (!ADMIN_IDS.includes(userId)) return;

  let recipients = [];
  let recipientType = '';

  if (broadcastType === 'all') {
    recipients = Array.from(users.keys());
    recipientType = `all ${recipients.length} users`;
  } else if (broadcastType === 'test') {
    recipients = ADMIN_IDS;
    recipientType = `${recipients.length} admins`;
  }

  const confirmKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirm Send', callback_data: `confirm_broadcast_${broadcastType}_${encodeURIComponent(text)}` }],
        [{ text: '❌ Cancel', callback_data: 'cancel_broadcast' }]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `📢 *Broadcast Preview*\n\n` +
    `*Recipients:* ${recipientType}\n\n` +
    `*Message:*\n${text}\n\n` +
    `⚠️ *Are you sure you want to send this?*`,
    { parse_mode: 'Markdown', ...confirmKeyboard }
  );
}

async function handleConfirmBroadcast(callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (!ADMIN_IDS.includes(userId)) return;

  const parts = data.split('_').slice(2); // Skip 'confirm' and 'broadcast'
  const broadcastType = data.split('_')[2];
  const messageText = decodeURIComponent(parts.slice(1).join('_'));

  let recipients = [];
  let recipientType = '';

  if (broadcastType === 'all') {
    recipients = Array.from(users.keys());
    recipientType = 'all users';
  } else if (broadcastType === 'test') {
    recipients = ADMIN_IDS;
    recipientType = 'admins';
  }

  let sent = 0;
  let failed = 0;

  // Update message to show sending status
  await bot.editMessageText(
    `📢 *Sending Broadcast...*\n\n` +
    `*Recipients:* ${recipientType} (${recipients.length})\n\n` +
    `*Message:*\n${messageText}\n\n` +
    `⏳ Sending... 0/${recipients.length}`,
    {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown'
    }
  );

  for (const recipientId of recipients) {
    try {
      await bot.sendMessage(recipientId,
        `📢 *Announcement from JU Marketplace*\n\n${messageText}\n\n*JU Marketplace Team*`,
        { parse_mode: 'Markdown' }
      );
      sent++;
      
      // Update progress every 10 messages
      if (sent % 10 === 0) {
        await bot.editMessageText(
          `📢 *Sending Broadcast...*\n\n` +
          `*Recipients:* ${recipientType} (${recipients.length})\n\n` +
          `*Message:*\n${messageText}\n\n` +
          `⏳ Sent: ${sent}/${recipients.length}`,
          {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'Markdown'
          }
        );
      }
      
      await new Promise(r => setTimeout(r, 100)); // Rate limiting
    } catch (error) {
      failed++;
      console.error(`Failed to send to ${recipientId}:`, error.message);
    }
  }

  // Final update
  await bot.editMessageText(
    `✅ *Broadcast Completed*\n\n` +
    `*Recipients:* ${recipientType}\n\n` +
    `*Message:*\n${messageText}\n\n` +
    `📊 *Results:*\n` +
    `• ✅ Sent: ${sent}\n` +
    `• ❌ Failed: ${failed}\n` +
    `• 📈 Success Rate: ${Math.round((sent / recipients.length) * 100)}%`,
    {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown'
    }
  );

  await bot.answerCallbackQuery(callbackQuery.id, { text: `Sent to ${sent} users` });
}

// ========== SETTINGS MESSAGE HANDLERS ==========
async function handleSettingsMessage(userId, chatId, text, settingType) {
  if (!ADMIN_IDS.includes(userId)) return;

  let successMessage = '';
  let errorMessage = '';

  try {
    switch (settingType) {
      case 'bot_username':
        if (!text.startsWith('@')) {
          errorMessage = '❌ Bot username must start with @';
          break;
        }
        botSettings.set('bot_username', text);
        successMessage = `✅ Bot username updated to: ${text}\n\n💡 All product links will use the new username immediately.`;
        break;

      case 'channel_username':
        if (!text.startsWith('@')) {
          errorMessage = '❌ Channel username must start with @';
          break;
        }
        botSettings.set('channel_link', text);
        successMessage = `✅ Channel updated to: ${text}\n\n💡 All channel references have been updated.`;
        break;

      case 'welcome_message':
        botSettings.set('welcome_message', text);
        successMessage = `✅ Welcome message updated!\n\n💡 New users will see this message.`;
        break;

      case 'broadcast_message':
        const broadcastType = userStates.get(userId)?.broadcastType;
        await handleBroadcastMessage(userId, chatId, text, broadcastType);
        userStates.delete(userId);
        return;

      case 'individual_message':
        const targetUserId = userStates.get(userId)?.targetUserId;
        let targetUser = users.get(targetUserId);
        if (!targetUser) {
          targetUser = await getUser(targetUserId);
        }
        
        if (targetUser) {
          await bot.sendMessage(targetUserId,
            `📨 *Message from Admin*\n\n${text}\n\n` +
            `*JU Marketplace Team*`,
            { parse_mode: 'Markdown' }
          );
          successMessage = `✅ Message sent to ${targetUser.firstName} ${targetUser.username ? `(@${targetUser.username})` : ''}`;
        } else {
          errorMessage = '❌ Target user not found';
        }
        break;
    }

    if (errorMessage) {
      await bot.sendMessage(chatId, errorMessage, { parse_mode: 'Markdown' });
    } else if (successMessage) {
      await bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });
      // Return to settings panel
      await showBotSettings(chatId, userId);
    }

    userStates.delete(userId);

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error updating setting: ${error.message}`);
    userStates.delete(userId);
  }
}

// ========== TEXT MESSAGE HANDLER FOR ADMIN STATES ==========
async function handleAdminTextMessage(msg) {
  const text = msg.text;
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!ADMIN_IDS.includes(userId)) return;

  const userState = userStates.get(userId);
  if (!userState) return;

  try {
    switch (userState.state) {
      case 'awaiting_bot_username':
        await handleSettingsMessage(userId, chatId, text, 'bot_username');
        break;

      case 'awaiting_channel_username':
        await handleSettingsMessage(userId, chatId, text, 'channel_username');
        break;

      case 'awaiting_welcome_message':
        await handleSettingsMessage(userId, chatId, text, 'welcome_message');
        break;

      case 'awaiting_broadcast_message':
        await handleSettingsMessage(userId, chatId, text, 'broadcast_message');
        break;

      case 'awaiting_individual_message':
        await handleSettingsMessage(userId, chatId, text, 'individual_message');
        break;
    }
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    userStates.delete(userId);
  }
}

// ========== CONTACT ADMIN HANDLERS ==========
async function handleContactAdmin(chatId, userId, contactType, callbackQueryId) {
  const contactTypes = {
    'report_issue': 'Report Issue',
    'give_suggestion': 'Give Suggestion', 
    'urgent_help': 'Urgent Help',
    'general_question': 'General Question'
  };

  userStates.set(userId, {
    state: `awaiting_${contactType}`
  });

  await bot.sendMessage(chatId,
    `📞 *Contact Admin - ${contactTypes[contactType]}*\n\n` +
    `Please describe your ${contactType.replace('_', ' ').toLowerCase()}:\n\n` +
    `💡 Be specific and provide relevant details.`,
    { parse_mode: 'Markdown' }
  );

  await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Please type your message' });
}

async function handleContactMessage(msg, state) {
  const userId = msg.from.id;
  const text = msg.text;
  const user = users.get(userId);

  const contactType = state.replace('awaiting_', '');
  const typeLabels = {
    'report_issue': '🚨 ISSUE REPORT',
    'give_suggestion': '💡 SUGGESTION',
    'urgent_help': '🆘 URGENT HELP',
    'general_question': '❓ GENERAL QUESTION'
  };

  const adminMessage = `${typeLabels[contactType]}\n\n` +
                      `*From:* ${user.firstName} ${user.username ? `(@${user.username})` : ''}\n` +
                      `*User ID:* \`${userId}\`\n\n` +
                      `*Message:*\n${text}\n\n` +
                      `_Time: ${new Date().toLocaleString()}_`;

  // Notify all admins
  let notifiedAdmins = 0;
  for (const adminId of ADMIN_IDS) {
    try {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📨 Reply', callback_data: `message_user_${userId}` }],
            [{ text: '👤 View User', callback_data: `view_user_${userId}` }]
          ]
        }
      };

      await bot.sendMessage(adminId, adminMessage, {
        parse_mode: 'Markdown',
        ...keyboard
      });
      notifiedAdmins++;
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err.message);
    }
  }

  await bot.sendMessage(msg.chat.id,
    `✅ *Message Sent!*\n\n` +
    `Your ${contactType.replace('_', ' ')} has been sent to ${notifiedAdmins} admin(s).\n` +
    `We'll respond as soon as possible.\n\n` +
    `📋 *Reference:* ${contactType}-${Date.now()}`,
    { parse_mode: 'Markdown' }
  );

  userStates.delete(userId);
  await showMainMenu(msg.chat.id);
}

// ========== HELP & CONTACT COMMANDS ==========
async function handleHelp(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdmin = ADMIN_IDS.includes(userId);

  let helpText = `❓ *JU Marketplace Help*\n\n` +
    `🛍️ *How to Buy:*\n` +
    `1. Click "🛍️ Browse Products"\n` +
    `2. Click "💬 Contact Seller"\n` +
    `3. Chat via bot\n` +
    `4. Arrange campus meetup\n\n` +
    `💰 *How to Sell:*\n` +
    `1. Click "💰 Sell Item"\n` +
    `2. Follow the 5 steps\n` +
    `3. Wait for admin approval\n` +
    `4. Get posted in ${botSettings.get('channel_link')}\n\n` +
    `🛡️ *Safety Tips:*\n` +
    `• Meet in public campus areas\n` +
    `• Verify item before paying\n` +
    `• Use cash for transactions\n` +
    `• Report suspicious activity\n\n` +
    `📞 *Support:*\n` +
    `Use "📞 Contact Admin" for help\n\n` +
    `🔧 *Commands:*\n` +
    `/start - Start bot\n` +
    `/help - This message\n` +
    `/browse - Browse products\n` +
    `/sell - Sell item\n` +
    `/myproducts - Your products\n` +
    `/contact - Contact admin\n` +
    `/cancel - Cancel current action`;

  if (isAdmin) {
    helpText += `\n\n👨‍💼 *Admin Commands:*\n` +
      `/admin - Admin panel\n` +
      `All other features in admin panel`;
  }

  await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  
  if (maintenanceMode && !ADMIN_IDS.includes(msg.from.id)) {
    await handleMaintenanceMode(chatId);
    return;
  }

  const contactKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚨 Report Issue', callback_data: 'report_issue' }],
        [{ text: '💡 Give Suggestion', callback_data: 'give_suggestion' }],
        [{ text: '🆘 Urgent Help', callback_data: 'urgent_help' }],
        [{ text: '❓ General Question', callback_data: 'general_question' }],
        [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `📞 *Contact Administration*\n\n` +
    `How can we help you today?\n\n` +
    `Select your issue type:`,
    { parse_mode: 'Markdown', ...contactKeyboard }
  );
}

// ========== MAIN MENU CALLBACK ==========
async function handleMainMenuCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  
  userStates.delete(userId);
  await showMainMenu(chatId);
  await bot.answerCallbackQuery(callbackQuery.id, { text: '🏠 Main menu' });
}

// ========== MISSING FUNCTION PLACEHOLDERS ==========
async function handleContactSellerDirect(chatId, userId, productId) {
  await handleContactSeller(chatId, userId, productId, null);
}

async function handleReportProduct(chatId, userId, data, callbackQueryId) {
  const productId = parseInt(data.replace('report_', ''));
  userStates.set(userId, {
    state: 'awaiting_report_reason',
    reportProductId: productId
  });
  
  await bot.sendMessage(chatId, `⚠️ *Report Product*\n\nDescribe the issue with this product:`, { parse_mode: 'Markdown' });
  if (callbackQueryId) {
    await bot.answerCallbackQuery(callbackQueryId, { text: '📝 Describe the issue' });
  }
}

// ========== FINAL EXPORT ==========
console.log('✅ JU Marketplace Bot fully loaded with Firebase integration!');
console.log('🚀 Bot is ready for Vercel deployment with webhooks!');

// Export the app for Vercel
module.exports = app;
```
