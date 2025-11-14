const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');
require('dotenv').config();

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

// Initialize Firebase (optional)
let db, bucket;
try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "",
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID || "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token"
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com/`
    });

    db = admin.firestore();
    bucket = admin.storage().bucket(`${process.env.FIREBASE_PROJECT_ID}.appspot.com`);
    console.log('✅ Firebase initialized successfully');
  } else {
    console.log('⚠️ Firebase disabled - using in-memory storage');
    db = null;
    bucket = null;
  }
} catch (error) {
  console.error('❌ Firebase init failed:', error.message);
  db = null;
  bucket = null;
}

// Bot setup
const bot = new TelegramBot(BOT_TOKEN);

// In-memory storage
const users = new Map();
const products = new Map();
const userStates = new Map();
let maintenanceMode = false;

// Initialize bot
async function initializeBot() {
  try {
    const botInfo = await bot.getMe();
    console.log('✅ Bot initialized:', botInfo.username);
  } catch (error) {
    console.error('❌ Bot initialization failed:', error);
  }
}

// Main menu
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
    `🏪 *Jimma University Marketplace*\n\nWelcome to JU Student Marketplace!\n\nChoose an option below:`,
    { parse_mode: 'Markdown', ...options }
  );
}

// Handle start command
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Register user
  if (!users.has(userId)) {
    users.set(userId, {
      telegramId: userId,
      username: msg.from.username || '',
      firstName: msg.from.first_name,
      joinedAt: new Date()
    });
  }

  await bot.sendMessage(chatId, 
    `🎓 Welcome to Jimma University Marketplace!\n\n🛍️ Buy & Sell within JU Community\n📚 Books, 📱 Electronics, 👕 Clothes & more\n\nStart by browsing items or selling yours!`,
    { parse_mode: 'Markdown' }
  );
  
  await showMainMenu(chatId);
}

// Handle messages
async function handleMessage(msg) {
  const text = msg.text;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (text.startsWith('/')) {
    await handleCommand(msg);
    return;
  }

  // Handle button clicks
  if (text === '🛍️ Browse Products') {
    await handleBrowse(msg);
  } else if (text === '💰 Sell Item') {
    await handleSell(msg);
  } else if (text === '📦 My Products') {
    await handleMyProducts(msg);
  } else if (text === '📞 Contact Admin') {
    await handleContact(msg);
  } else if (text === '❓ Help') {
    await handleHelp(msg);
  } else {
    await bot.sendMessage(chatId, 'Please use the menu buttons or commands.');
  }
}

// Handle commands
async function handleCommand(msg) {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (text === '/start') {
    await handleStart(msg);
  } else if (text === '/help') {
    await handleHelp(msg);
  } else if (text === '/browse') {
    await handleBrowse(msg);
  } else if (text === '/sell') {
    await handleSell(msg);
  } else if (text === '/myproducts') {
    await handleMyProducts(msg);
  } else if (text === '/contact') {
    await handleContact(msg);
  } else if (text === '/admin' && ADMIN_IDS.includes(msg.from.id)) {
    await handleAdmin(msg);
  } else {
    await bot.sendMessage(chatId, 'Unknown command. Use /help for available commands.');
  }
}

// Browse products
async function handleBrowse(msg) {
  const chatId = msg.chat.id;
  const productList = Array.from(products.values()).filter(p => p.status === 'approved');

  if (productList.length === 0) {
    await bot.sendMessage(chatId, 
      `🛍️ *Browse Products*\n\nNo products available yet.\n\nBe the first to list an item! Use "💰 Sell Item" to get started.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await bot.sendMessage(chatId, 
    `🛍️ *Available Products (${productList.length})*\n\nLatest items from JU students:`,
    { parse_mode: 'Markdown' }
  );

  for (const product of productList.slice(0, 5)) {
    const seller = users.get(product.sellerId);
    await bot.sendMessage(chatId,
      `*${product.title}*\n\n💰 *Price:* ${product.price} ETB\n📁 *Category:* ${product.category}\n👤 *Seller:* ${seller?.firstName || 'Unknown'}\n\n💬 Contact seller via main menu`,
      { parse_mode: 'Markdown' }
    );
    await new Promise(r => setTimeout(r, 300));
  }
}

// Sell item
async function handleSell(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  userStates.set(userId, {
    state: 'awaiting_product_title',
    productData: {}
  });

  await bot.sendMessage(chatId,
    `💰 *Sell Your Item - Step 1/4*\n\n📝 *Product Title*\n\nEnter a clear title for your item:`,
    { parse_mode: 'Markdown' }
  );
}

// My products
async function handleMyProducts(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const userProducts = Array.from(products.values()).filter(p => p.sellerId === userId);

  if (userProducts.length === 0) {
    await bot.sendMessage(chatId,
      `📦 *My Products*\n\nYou haven't listed any products yet.\n\nStart selling with "💰 Sell Item"!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let message = `📦 *Your Products (${userProducts.length})*\n\n`;
  userProducts.forEach((p, i) => {
    const statusIcon = p.status === 'approved' ? '✅' : p.status === 'pending' ? '⏳' : '❌';
    message += `${i + 1}. ${statusIcon} *${p.title}*\n`;
    message += `   💰 ${p.price} ETB | ${p.status}\n\n`;
  });

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Contact admin
async function handleContact(msg) {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId,
    `📞 *Contact Administration*\n\nFor support, please contact the admin team directly.\n\nYou can also report issues or make suggestions here.`,
    { parse_mode: 'Markdown' }
  );
}

// Help
async function handleHelp(msg) {
  const chatId = msg.chat.id;

  const helpText = `❓ *JU Marketplace Help*\n\n
🛍️ *How to Buy:*
1. Click "🛍️ Browse Products"
2. Contact sellers via the bot
3. Arrange campus meetup

💰 *How to Sell:*
1. Click "💰 Sell Item" 
2. Follow the steps
3. Wait for admin approval

🔧 *Commands:*
/start - Start bot
/help - This message  
/browse - Browse products
/sell - Sell item
/myproducts - Your products
/contact - Contact admin`;

  await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
}

// Admin panel
async function handleAdmin(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMIN_IDS.includes(userId)) {
    await bot.sendMessage(chatId, '❌ Admin access required.');
    return;
  }

  const stats = {
    users: users.size,
    products: products.size,
    pending: Array.from(products.values()).filter(p => p.status === 'pending').length
  };

  await bot.sendMessage(chatId,
    `🛠️ *ADMIN PANEL*\n\n
📊 *Statistics:*
• 👥 Users: ${stats.users}
• 🛒 Products: ${stats.products} 
• ⏳ Pending: ${stats.pending}

Use /help for available commands.`,
    { parse_mode: 'Markdown' }
  );
}

// Webhook endpoint
app.post('/api', async (req, res) => {
  try {
    const update = req.body;
    
    // Respond immediately
    res.status(200).json({ ok: true });
    
    // Process async
    setTimeout(async () => {
      try {
        if (update.message) {
          if (update.message.photo) {
            // Handle photos later
          } else if (update.message.text) {
            await handleMessage(update.message);
          }
        } else if (update.callback_query) {
          // Handle callbacks later
        }
      } catch (error) {
        console.error('Error processing update:', error);
      }
    }, 0);
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ ok: true });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'JU Marketplace Bot',
    timestamp: new Date().toISOString(),
    users: users.size,
    products: products.size
  });
});

app.get('/api', (req, res) => {
  res.json({ 
    status: 'online', 
    message: 'JU Marketplace Bot is running!',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.redirect('/api');
});

// Initialize and start
initializeBot().then(() => {
  console.log('✅ Bot started successfully');
}).catch(err => {
  console.error('❌ Bot start failed:', err);
});

// Export for Vercel
module.exports = app;
