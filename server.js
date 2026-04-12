const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
    transports: ["websocket", "polling"]
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Models
const User = require('./models/User');
const QueueSlot = require('./models/QueueSlot');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');

// Middleware
const { auth, adminAuth, pinVerify } = require('./middleware/auth');

// Queue Engine
const QueueEngine = require('./services/queueEngine');
const queueEngine = new QueueEngine(io);

// Health check
app.get('/api/health', (req, res) => res.json({ status: '1 Dollar App v3.0 Running', time: new Date() }));

// ═══════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) {
            return res.status(400).json({
                message: existing.username === username ? 'Username already taken' : 'Email already in use'
            });
        }

        const user = new User({ username, email, password });
        await user.save();

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({
            message: 'Account created successfully',
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                wallet: user.wallet,
                status: user.status,
                pinSet: user.pinSet
            }
        });
    } catch (err) {
        console.error('[REGISTER ERROR]', err);
        res.status(500).json({ message: 'Registration failed', error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ message: 'Invalid username or password' });
        }
        if (user.status === 'suspended') {
            return res.status(403).json({ message: 'Account has been suspended' });
        }

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                wallet: user.wallet,
                status: user.status,
                pinSet: user.pinSet
            }
        });
    } catch (err) {
        res.status(500).json({ message: 'Login failed', error: err.message });
    }
});

app.post('/api/auth/pin/setup', auth, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ message: 'PIN must be exactly 4 digits' });
        }

        req.user.pin = pin;
        await req.user.save();

        res.json({ message: 'PIN set successfully', pinSet: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to set PIN', error: err.message });
    }
});

app.post('/api/auth/pin/verify', auth, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!req.user.pinSet) {
            return res.status(400).json({ message: 'PIN not set up yet' });
        }
        const isValid = await req.user.comparePin(pin);
        res.json({ valid: isValid });
    } catch (err) {
        res.status(500).json({ message: 'Verification failed' });
    }
});

// ═══════════════════════════════════════════════════
// WALLET ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/wallet', auth, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        const activeSlots = await QueueSlot.find({ userId: req.userId, status: 'queued' });
        const maturedSlots = await QueueSlot.find({ userId: req.userId, status: 'matured' });

        res.json({
            wallet: user.wallet,
            activeSlots: activeSlots.length,
            maturedSlots: maturedSlots.length,
            pinSet: user.pinSet
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch wallet', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// INVEST ROUTES
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
// QUEUE ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/queue', auth, async (req, res) => {
    try {
        const settings = await queueEngine.getSettings();
        const mainQueue = await QueueSlot.find({ status: 'queued', queueType: 'main' })
            .sort({ position: 1 })
            .populate('userId', 'username');
        const waitlist = await QueueSlot.find({ status: 'queued', queueType: 'waitlist' })
            .sort({ waitlistNumber: 1 })
            .populate('userId', 'username');

        res.json({
            mainQueue,
            waitlist,
            queueSize: settings.queueSize,
            mainCount: mainQueue.length,
            waitlistCount: waitlist.length,
            timer: queueEngine.cycleTimer,
            timerRunning: queueEngine.timerRunning
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch queue', error: err.message });
    }
});

app.get('/api/queue/my-positions', auth, async (req, res) => {
    try {
        const slots = await QueueSlot.find({
            userId: req.userId,
            status: { $in: ['queued', 'matured'] }
        }).sort({ position: 1 });

        res.json({
            queued: slots.filter(s => s.status === 'queued' && s.queueType === 'main'),
            waitlisted: slots.filter(s => s.status === 'queued' && s.queueType === 'waitlist'),
            matured: slots.filter(s => s.status === 'matured'),
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch positions', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// DEPOSIT ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/deposit', auth, async (req, res) => {
    try {
        const { amount, screenshot } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ message: 'Invalid deposit amount' });
        }
        if (!screenshot) {
            return res.status(400).json({ message: 'Payment screenshot required' });
        }

        const deposit = new Transaction({
            userId: req.userId,
            type: 'deposit',
            amount: parseFloat(amount),
            screenshot,
            status: 'pending',
            description: `Deposit request for $${amount}`
        });
        await deposit.save();
        res.json({ message: 'Deposit submitted! Awaiting admin verification.' });
    } catch (err) {
        res.status(500).json({ message: 'Deposit failed', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// WITHDRAWAL ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/withdraw', auth, pinVerify, async (req, res) => {
    try {
        const { amount, accountDetails } = req.body;
        const withdrawAmount = parseFloat(amount);

        if (!withdrawAmount || withdrawAmount <= 0) {
            return res.status(400).json({ message: 'Invalid withdrawal amount' });
        }

        // Atomic deduction
        const user = await User.findOneAndUpdate(
            { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
            { $inc: { 'wallet.balance': -withdrawAmount } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        // Save account details
        if (accountDetails) {
            user.accountDetails = accountDetails;
            await user.save();
        }

        const withdrawal = new Transaction({
            userId: req.userId,
            type: 'withdrawal',
            amount: withdrawAmount,
            accountDetails: accountDetails || user.accountDetails,
            status: 'pending',
            description: `Withdrawal request for $${withdrawAmount}`
        });
        await withdrawal.save();

        res.json({ message: 'Withdrawal request submitted!', wallet: user.wallet });
    } catch (err) {
        res.status(500).json({ message: 'Withdrawal failed', error: err.message });
    }
});

app.post('/api/withdraw/all', auth, pinVerify, async (req, res) => {
    try {
        const { accountDetails } = req.body;
        const user = await User.findById(req.userId);

        if (!user || user.wallet.balance <= 0) {
            return res.status(400).json({ message: 'No balance to withdraw' });
        }

        const withdrawAmount = user.wallet.balance;

        const updated = await User.findOneAndUpdate(
            { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
            { $inc: { 'wallet.balance': -withdrawAmount } },
            { new: true }
        );

        if (!updated) return res.status(400).json({ message: 'Failed to process' });

        if (accountDetails) {
            updated.accountDetails = accountDetails;
            await updated.save();
        }

        const withdrawal = new Transaction({
            userId: req.userId,
            type: 'withdrawal',
            amount: withdrawAmount,
            accountDetails: accountDetails || updated.accountDetails,
            status: 'pending',
            description: `Full withdrawal of $${withdrawAmount}`
        });
        await withdrawal.save();

        res.json({ message: 'Full withdrawal submitted!', wallet: updated.wallet });
    } catch (err) {
        res.status(500).json({ message: 'Withdrawal failed', error: err.message });
    }
});

app.post('/api/withdraw/:id/cancel', auth, async (req, res) => {
    try {
        const transaction = await Transaction.findOne({
            _id: req.params.id,
            userId: req.userId,
            type: 'withdrawal',
            status: 'pending'
        });

        if (!transaction) return res.status(404).json({ message: 'Pending withdrawal not found' });

        // Refund
        await User.findByIdAndUpdate(req.userId, {
            $inc: { 'wallet.balance': transaction.amount }
        });

        transaction.status = 'rejected';
        transaction.description += ' (Cancelled by user)';
        await transaction.save();

        const user = await User.findById(req.userId);
        res.json({ message: 'Withdrawal cancelled and refunded', wallet: user.wallet });
    } catch (err) {
        res.status(500).json({ message: 'Cancellation failed', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// REINVEST ROUTE
// ═══════════════════════════════════════════════════

app.post('/api/reinvest', auth, pinVerify, async (req, res) => {
    try {
        const { amount } = req.body;
        const numDollars = parseInt(amount);

        if (!numDollars || numDollars < 1) {
            return res.status(400).json({ message: 'Minimum reinvestment is $1' });
        }

        // Record reinvest transaction
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
// TRANSACTION HISTORY
// ═══════════════════════════════════════════════════

app.get('/api/transactions', auth, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .limit(50);
        res.json(transactions);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch transactions' });
    }
});

// ═══════════════════════════════════════════════════
// USER STATUS (for polling)
// ═══════════════════════════════════════════════════

app.get('/api/user/status', auth, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        const activeSlots = await QueueSlot.find({
            userId: req.userId,
            status: 'queued'
        }).sort({ position: 1 });

        const maturedSlots = await QueueSlot.find({
            userId: req.userId,
            status: 'matured'
        });

        res.json({
            wallet: user.wallet,
            status: user.status,
            pinSet: user.pinSet,
            username: user.username,
            activeSlots: activeSlots.map(s => ({
                id: s._id,
                position: s.position,
                queueType: s.queueType,
                waitlistNumber: s.waitlistNumber
            })),
            maturedCount: maturedSlots.length,
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch status' });
    }
});

// ═══════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ status: { $ne: 'admin' } });
        const activeUsers = await User.countDocuments({ status: 'active' });
        const suspendedUsers = await User.countDocuments({ status: 'suspended' });
        const mainQueueCount = await QueueSlot.countDocuments({ status: 'queued', queueType: 'main' });
        const waitlistCount = await QueueSlot.countDocuments({ status: 'queued', queueType: 'waitlist' });

        const deposits = await Transaction.aggregate([
            { $match: { type: 'deposit', status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const withdrawals = await Transaction.aggregate([
            { $match: { type: 'withdrawal', status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const pendingDeposits = await Transaction.countDocuments({ type: 'deposit', status: 'pending' });
        const pendingWithdrawals = await Transaction.countDocuments({ type: 'withdrawal', status: 'pending' });

        const userBalances = await User.aggregate([
            { $match: { status: { $ne: 'admin' } } },
            { $group: { _id: null, total: { $sum: '$wallet.balance' } } }
        ]);

        res.json({
            totalUsers, activeUsers, suspendedUsers,
            mainQueueCount, waitlistCount,
            totalDeposits: deposits[0]?.total || 0,
            totalWithdrawals: withdrawals[0]?.total || 0,
            pendingDeposits, pendingWithdrawals,
            totalUserBalances: userBalances[0]?.total || 0
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch stats', error: err.message });
    }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const users = await User.find({ status: { $ne: 'admin' } })
            .select('-password -pin')
            .sort({ createdAt: -1 })
            .lean();

        const usersWithSlots = await Promise.all(users.map(async user => {
            const activeSlots = await QueueSlot.countDocuments({ userId: user._id, status: 'queued' });
            return { ...user, activeSlots };
        }));

        res.json(usersWithSlots);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users', error: err.message });
    }
});

app.get('/api/admin/deposits', adminAuth, async (req, res) => {
    try {
        const deposits = await Transaction.find({ type: 'deposit' })
            .populate('userId', 'username')
            .sort({ createdAt: -1 });
        res.json(deposits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/deposits/:id/verify', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.status !== 'pending' || transaction.type !== 'deposit') {
            return res.status(404).json({ message: 'Pending deposit not found' });
        }

        transaction.status = 'completed';
        await transaction.save();

        await User.findByIdAndUpdate(transaction.userId, {
            $inc: { 'wallet.balance': transaction.amount }
        });

        console.log(`[ADMIN] Deposit $${transaction.amount} verified for user ${transaction.userId}`);
        res.json({ message: 'Deposit verified and credited' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/deposits/:id/reject', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.status !== 'pending') {
            return res.status(404).json({ message: 'Pending deposit not found' });
        }

        transaction.status = 'rejected';
        await transaction.save();
        res.json({ message: 'Deposit rejected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
    try {
        const withdrawals = await Transaction.find({ type: 'withdrawal' })
            .populate('userId', 'username')
            .sort({ createdAt: -1 });
        res.json(withdrawals);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/withdrawals/:id/pay', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
            return res.status(404).json({ message: 'Pending withdrawal not found' });
        }

        transaction.status = 'completed';
        await transaction.save();
        console.log(`[ADMIN] Withdrawal $${transaction.amount} paid to user ${transaction.userId}`);
        res.json({ message: 'Withdrawal marked as paid' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
            return res.status(404).json({ message: 'Pending withdrawal not found' });
        }

        // Refund the user
        await User.findByIdAndUpdate(transaction.userId, {
            $inc: { 'wallet.balance': transaction.amount }
        });

        transaction.status = 'rejected';
        await transaction.save();
        res.json({ message: 'Withdrawal rejected and refunded' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/:id/suspend', adminAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        await User.findByIdAndUpdate(userId, { status: 'suspended' });

        // Cancel active queue slots and refund
        const activeSlots = await QueueSlot.find({ userId, status: 'queued' });
        if (activeSlots.length > 0) {
            const refundAmount = activeSlots.reduce((sum, s) => sum + s.amount, 0);
            await QueueSlot.updateMany({ userId, status: 'queued' }, { status: 'cancelled' });
            await User.findByIdAndUpdate(userId, {
                $inc: { 'wallet.balance': refundAmount, 'wallet.activeInQueue': -refundAmount }
            });
        }

        await queueEngine.broadcastState();
        res.json({ message: 'User suspended and queue slots cancelled' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/:id/activate', adminAuth, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.params.id, { status: 'active' });
        res.json({ message: 'User activated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/:id/add-balance', adminAuth, async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $inc: { 'wallet.balance': amount } },
            { new: true }
        );
        res.json({ message: `$${amount} added`, wallet: user.wallet });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/queue', adminAuth, async (req, res) => {
    try {
        const mainQueue = await QueueSlot.find({ status: 'queued', queueType: 'main' })
            .sort({ position: 1 })
            .populate('userId', 'username');
        const waitlist = await QueueSlot.find({ status: 'queued', queueType: 'waitlist' })
            .sort({ waitlistNumber: 1 })
            .populate('userId', 'username');
        const settings = await queueEngine.getSettings();

        res.json({ mainQueue, waitlist, settings, timer: queueEngine.cycleTimer });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/settings', adminAuth, async (req, res) => {
    try {
        const allowedFields = ['queueSize', 'waitlistStart', 'waitlistMax', 'maturityMultiplier', 'cycleTimerSeconds', 'autoPromote', 'minDeposit'];
        const updates = {};
        allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        await Settings.findOneAndUpdate({}, updates, { upsert: true });
        res.json({ message: 'Settings updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
    try {
        const settings = await Settings.findOne();
        res.json(settings || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/update-credentials', adminAuth, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (username) req.user.username = username;
        if (password) req.user.password = password;
        await req.user.save();
        res.json({ message: 'Admin credentials updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        console.log('[INIT] Default settings created');
    }
};

const initAdmin = async () => {
    let admin = await User.findOne({ status: 'admin' });
    if (!admin) {
        admin = new User({
            username: 'Admin',
            email: 'admin@1dollar.app',
            password: 'admin123',
            status: 'admin'
        });
        await admin.save();
        console.log('[INIT] Admin created: Admin / admin123');
    }
};

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('[DB] Connected to MongoDB Atlas');
        try {
            await initSettings();
            await initAdmin();
            await queueEngine.initialize();
        } catch (err) {
            console.error('[INIT ERROR]', err);
        }
    })
    .catch(err => console.error('[DB ERROR]', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`[1 DOLLAR APP] Server running on port ${PORT}`));
