const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
    transports: ["websocket", "polling"]
});

// ═══════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ═══ Rate Limiting ═══
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { message: 'Too many attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const depositLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { message: 'Too many deposit attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiters to critical routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/deposit', depositLimiter);

// Serve static files from uploads directory
app.use('/uploads', express.static('uploads'));

// ═══════════════════════════════════════════════════
// MODELS (Import all to ensure schemas are registered)
// ═══════════════════════════════════════════════════

const User = require('./models/User');
const Settings = require('./models/Settings');
const FeatureFlag = require('./models/FeatureFlag');

// ═══════════════════════════════════════════════════
// SERVICES
// ═══════════════════════════════════════════════════

const QueueEngine = require('./services/queueEngine');
const queueEngine = new QueueEngine(io);

// ═══════════════════════════════════════════════════
// INJECT io & queueEngine INTO EVERY REQUEST
// ═══════════════════════════════════════════════════

app.use((req, res, next) => {
    req.io = io;
    req.queueEngine = queueEngine;
    next();
});

// ═══════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════

const logger = require('./utils/logger');

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({
    status: '1 Dollar App v5.0 Enterprise Running',
    time: new Date(),
    uptime: process.uptime(),
}));

// ═══════════════════════════════════════════════════
// ROUTE MODULES
// ═══════════════════════════════════════════════════

app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/deposit', require('./routes/deposit'));
app.use('/api/deposit-settings', (req, res, next) => {
    // Redirect legacy route to new deposit settings
    req.url = '/settings';
    require('./routes/deposit')(req, res, next);
});
app.use('/api/withdraw', require('./routes/withdrawal'));
app.use('/api/user', require('./routes/user'));
app.use('/api/config', require('./routes/config'));

// Admin routes
app.use('/api/admin', require('./routes/admin'));

// Bank details (public)
app.get('/api/bank-details', async (req, res) => {
    const BankDetail = require('./models/BankDetail');
    try {
        const activeDetail = await BankDetail.findOne({ isActive: true }).sort({ publishedAt: -1 });
        if (!activeDetail) return res.json({ message: 'No bank details published yet' });
        res.json(activeDetail);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch bank details', error: err.message });
    }
});

// Legacy transaction route (redirect to user module)
app.get('/api/transactions', require('./middleware/auth').auth, async (req, res) => {
    const Transaction = require('./models/Transaction');
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        Transaction.find({ userId: req.userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Transaction.countDocuments({ userId: req.userId })
    ]);

    res.json({
        transactions,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// Legacy invest routes (kept at original paths for backward compat)
const { auth, pinVerify } = require('./middleware/auth');

app.post('/api/invest', auth, pinVerify, async (req, res) => {
    try {
        const { amount } = req.body;
        const numDollars = parseInt(amount);
        if (!numDollars || numDollars < 1) {
            return res.status(400).json({ message: 'Minimum investment is $1' });
        }
        const result = await queueEngine.invest(req.userId, numDollars);
        res.json({
            message: `$${numDollars} invested into ${result.slots.length} queue slot(s)`,
            slots: result.slots,
            wallet: result.wallet
        });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

app.post('/api/reinvest', auth, pinVerify, async (req, res) => {
    const Transaction = require('./models/Transaction');
    try {
        const { amount } = req.body;
        const numDollars = parseInt(amount);
        if (!numDollars || numDollars < 1) {
            return res.status(400).json({ message: 'Minimum reinvestment is $1' });
        }

        await new Transaction({
            userId: req.userId,
            type: 'reinvest',
            amount: numDollars,
            status: 'completed',
            description: `Reinvested $${numDollars} from earnings`
        }).save();

        const result = await queueEngine.invest(req.userId, numDollars);
        res.json({
            message: `$${numDollars} reinvested into queue`,
            slots: result.slots,
            wallet: result.wallet
        });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ═══════════════════════════════════════════════════
// CENTRALIZED ERROR HANDLER
// ═══════════════════════════════════════════════════

app.use(require('./middleware/errorHandler'));

// ═══════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════

io.on('connection', (socket) => {
    queueEngine.broadcastState();
});

// ═══════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════

const initSettings = async () => {
    const settings = await Settings.findOne();
    if (!settings) {
        await new Settings({}).save();
        logger.info('INIT', 'Default settings created');
    }
};

const initAdmin = async () => {
    let admin = await User.findOne({ $or: [{ username: 'Admin' }, { email: 'admin@1dollar.app' }] });
    if (!admin) {
        try {
            admin = new User({
                username: 'Admin',
                email: 'admin@1dollar.app',
                password: 'admin123',
                status: 'admin'
            });
            await admin.save();
            logger.info('INIT', 'Admin created: Admin / admin123');
        } catch (err) {
            if (err.code === 11000) {
                logger.info('INIT', 'Admin already exists (duplicate key)');
            } else {
                throw err;
            }
        }
    } else {
        let needsSave = false;
        if (admin.status !== 'admin') {
            admin.status = 'admin';
            needsSave = true;
        }
        if (needsSave) {
            await admin.save();
            logger.info('INIT', 'Admin user updated (status fixed)');
        } else {
            logger.info('INIT', 'Admin already exists with correct status');
        }
    }
};

const initFeatureFlags = async () => {
    const defaultFlags = [
        { key: 'autoUpdateEnabled', value: true, description: 'Enable in-app auto-update system', category: 'system' },
        { key: 'notificationsEnabled', value: true, description: 'Enable push notifications', category: 'notification' },
        { key: 'maintenanceMode', value: false, description: 'Put app in maintenance mode', category: 'system' },
        { key: 'depositEnabled', value: true, description: 'Allow new deposits', category: 'feature' },
        { key: 'withdrawalEnabled', value: true, description: 'Allow withdrawals', category: 'feature' },
    ];

    for (const flag of defaultFlags) {
        await FeatureFlag.findOneAndUpdate(
            { key: flag.key },
            { $setOnInsert: flag },
            { upsert: true }
        );
    }
    logger.info('INIT', 'Feature flags initialized');
};

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        logger.info('DB', 'Connected to MongoDB Atlas');
        try {
            await initSettings();
            await initAdmin();
            await initFeatureFlags();
            await queueEngine.initialize();
        } catch (err) {
            logger.error('INIT', `Initialization error: ${err.message}`, err);
        }
    })
    .catch(err => logger.error('DB', `Connection error: ${err.message}`, err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => logger.info('SERVER', `1 Dollar App v5.0 Enterprise running on port ${PORT}`));
