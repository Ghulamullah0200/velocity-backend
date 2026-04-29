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

// Serve static files from uploads directory
app.use('/uploads', express.static('uploads'));

// Models
const User = require('./models/User');
const QueueSlot = require('./models/QueueSlot');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');
const BankDetail = require('./models/BankDetail');

// Middleware
const { auth, adminAuth, pinVerify } = require('./middleware/auth');
const upload = require('./middleware/upload');

// Queue Engine
const QueueEngine = require('./services/queueEngine');
const queueEngine = new QueueEngine(io);

// Health check
app.get('/api/health', (req, res) => res.json({ status: '1 Dollar App v4.0 Running', time: new Date() }));

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
                pinSet: user.pinSet,
                queueStatus: user.queueStatus,
                hasDeposited: user.hasDeposited,
                depositStatus: user.depositStatus,
                lifecyclePhase: user.lifecyclePhase
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
        if (user.status === 'terminated') {
            return res.status(403).json({ message: 'Account has been terminated. No further actions allowed.' });
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
                pinSet: user.pinSet,
                queueStatus: user.queueStatus,
                hasDeposited: user.hasDeposited,
                depositStatus: user.depositStatus,
                lifecyclePhase: user.lifecyclePhase
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
        const activeSlots = await QueueSlot.countDocuments({ userId: req.userId, status: 'active' });
        const completedSlots = await QueueSlot.countDocuments({ userId: req.userId, status: 'completed' });

        res.json({
            wallet: user.wallet,
            activeSlots,
            maturedSlots: completedSlots,
            pinSet: user.pinSet,
            queueStatus: user.queueStatus
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch wallet', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// QUEUE ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/queue', auth, async (req, res) => {
    try {
        const settings = await queueEngine.getSettings();
        const mainQueue = await QueueSlot.find({ status: 'active', queueType: 'main' })
            .sort({ position: 1 })
            .populate('userId', 'username');
        const waitlist = await QueueSlot.find({ status: 'waiting', queueType: 'waitlist' })
            .sort({ waitlistNumber: 1 })
            .populate('userId', 'username');

        // Get withdrawal timer for top slot
        const topSlot = mainQueue.find(s => s.position === 1);
        let withdrawalTimer = null;
        if (topSlot && topSlot.withdrawalDeadline) {
            const remaining = Math.max(0, new Date(topSlot.withdrawalDeadline).getTime() - Date.now());
            withdrawalTimer = {
                slotId: topSlot._id,
                userId: topSlot.userId,
                deadline: topSlot.withdrawalDeadline,
                remainingMs: remaining,
                remainingHours: Math.floor(remaining / (1000 * 60 * 60)),
                remainingMinutes: Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60)),
            };
        }

        res.json({
            mainQueue,
            waitlist,
            queueSize: settings.queueSize,
            mainCount: mainQueue.length,
            waitlistCount: waitlist.length,
            timer: queueEngine.cycleTimer,
            timerRunning: queueEngine.timerRunning,
            withdrawalTimer,
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch queue', error: err.message });
    }
});

app.get('/api/queue/my-positions', auth, async (req, res) => {
    try {
        const slots = await QueueSlot.find({
            userId: req.userId,
            status: { $in: ['active', 'waiting', 'completed'] }
        }).sort({ position: 1 });

        res.json({
            queued: slots.filter(s => s.status === 'active' && s.queueType === 'main'),
            waitlisted: slots.filter(s => s.status === 'waiting' && s.queueType === 'waitlist'),
            matured: slots.filter(s => s.status === 'completed'),
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch positions', error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// BANK DETAILS ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/bank-details', async (req, res) => {
    try {
        const activeDetail = await BankDetail.findOne({ isActive: true }).sort({ publishedAt: -1 });
        if (!activeDetail) {
            return res.json({ message: 'No bank details published yet' });
        }
        res.json(activeDetail);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch bank details', error: err.message });
    }
});

app.get('/api/admin/bank-details', adminAuth, async (req, res) => {
    try {
        const records = await BankDetail.find().sort({ publishedAt: -1 });
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/bank-details', adminAuth, async (req, res) => {
    try {
        const { accountNumber, bankName, accountTitle, additionalInstructions } = req.body;
        if (!accountNumber || !accountTitle) {
            return res.status(400).json({ message: 'Account Title and Account Number are required' });
        }

        await BankDetail.updateMany({}, { $set: { isActive: false } });

        const newDetail = new BankDetail({
            accountNumber,
            bankName: bankName || '',
            accountTitle,
            additionalInstructions: additionalInstructions || '',
            isActive: true,
            publishedAt: new Date()
        });
        await newDetail.save();

        io.emit('bankDetailsUpdated', newDetail);
        res.json({ message: 'Bank details published successfully', bankDetail: newDetail });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// DEPOSIT SETTINGS (Public — no auth required)
// ═══════════════════════════════════════════════════

app.get('/api/deposit-settings', async (req, res) => {
    try {
        const settings = await Settings.findOne().lean();
        res.json({
            depositAmount: settings?.depositAmount ?? 1.00,
            maturityMultiplier: settings?.maturityMultiplier ?? 10,
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch deposit settings' });
    }
});

// ═══════════════════════════════════════════════════
// DEPOSIT ROUTES (Dynamic amount from admin settings)
// ═══════════════════════════════════════════════════

app.post('/api/deposit', auth, upload.single('screenshot'), async (req, res) => {
    try {
        const settings = await Settings.findOne();
        const requiredAmount = settings?.depositAmount ?? 1.00;

        const { amount } = req.body;
        const depositAmount = parseFloat(amount);

        // Validate against dynamic deposit amount (float comparison with tolerance)
        if (!depositAmount || Math.abs(depositAmount - requiredAmount) > 0.001) {
            return res.status(400).json({ message: `Only $${requiredAmount.toFixed(2)} deposits are allowed` });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'Payment screenshot required' });
        }

        // ═══ ONE-TIME DEPOSIT CHECK ═══
        const user = await User.findById(req.userId);

        // Block terminated accounts
        if (user.status === 'terminated') {
            return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
        }
        // Block if already deposited permanently
        if (user.hasDeposited === true) {
            return res.status(403).json({ message: 'Deposit already used. Wait for queue completion.' });
        }
        // Block if a pending deposit exists
        if (user.depositStatus === 'pending') {
            return res.status(403).json({ message: 'You already have a pending deposit awaiting approval.' });
        }
        // Block expired users
        if (user.queueStatus === 'expired') {
            return res.status(403).json({ message: 'Your account has expired. Please contact admin for reactivation.' });
        }

        // ═══ IMAGE FIX: Store RELATIVE path ═══
        const screenshotPath = `/uploads/${req.file.filename}`;

        const deposit = new Transaction({
            userId: req.userId,
            type: 'deposit',
            amount: requiredAmount,
            screenshot: screenshotPath,
            status: 'pending',
            description: `Deposit request for $${requiredAmount.toFixed(2)}`
        });
        await deposit.save();

        // Update user deposit status
        user.depositStatus = 'pending';
        user.lifecyclePhase = 'deposited';
        await user.save();

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

        // Block terminated accounts
        const userCheck = await User.findById(req.userId);
        if (userCheck.status === 'terminated') {
            return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
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
        // Block terminated accounts
        if (user.status === 'terminated') {
            return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
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
// QUEUE WITHDRAWAL (User at #1 claims their earning)
// ═══════════════════════════════════════════════════

app.post('/api/queue/claim', auth, pinVerify, async (req, res) => {
    try {
        // Find user's slot at position #1
        const topSlot = await QueueSlot.findOne({
            userId: req.userId,
            status: 'active',
            queueType: 'main',
            position: 1
        });

        if (!topSlot) {
            return res.status(400).json({ message: 'You are not at the top of the queue' });
        }

        // Block terminated accounts
        const userCheck = await User.findById(req.userId);
        if (userCheck?.status === 'terminated') {
            return res.status(403).json({ message: 'Account terminated. No further actions allowed.' });
        }

        const result = await queueEngine.completeWithdrawal(topSlot._id, req.userId);

        res.json({
            message: `Queue completed! You earned $${result.earning}`,
            earning: result.earning,
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
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const transactions = await Transaction.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Transaction.countDocuments({ userId: req.userId });

        res.json({
            transactions,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
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
            status: 'active'
        }).sort({ position: 1 });

        const completedSlots = await QueueSlot.countDocuments({
            userId: req.userId,
            status: 'completed'
        });

        // Check if user is at #1 with active timer
        const atTopOfQueue = activeSlots.some(s => s.position === 1 && s.queueType === 'main');
        let withdrawalTimer = null;
        if (atTopOfQueue) {
            const topSlot = activeSlots.find(s => s.position === 1);
            if (topSlot?.withdrawalDeadline) {
                const remaining = Math.max(0, new Date(topSlot.withdrawalDeadline).getTime() - Date.now());
                withdrawalTimer = {
                    slotId: topSlot._id,
                    deadline: topSlot.withdrawalDeadline,
                    remainingMs: remaining,
                    remainingHours: Math.floor(remaining / (1000 * 60 * 60)),
                    remainingMinutes: Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60)),
                };
            }
        }

        res.json({
            wallet: user.wallet,
            status: user.status,
            pinSet: user.pinSet,
            username: user.username,
            queueStatus: user.queueStatus,
            activeSlots: activeSlots.map(s => ({
                id: s._id,
                position: s.position,
                queueType: s.queueType,
                waitlistNumber: s.waitlistNumber,
                withdrawalDeadline: s.withdrawalDeadline,
            })),
            maturedCount: completedSlots,
            atTopOfQueue,
            withdrawalTimer,
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
        // Single aggregation pipeline for efficiency
        const [userStats] = await User.aggregate([
            { $match: { status: { $ne: 'admin' } } },
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    activeUsers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                    suspendedUsers: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
                    expiredUsers: { $sum: { $cond: [{ $eq: ['$queueStatus', 'expired'] }, 1, 0] } },
                    totalUserBalances: { $sum: '$wallet.balance' },
                }
            }
        ]);

        const [queueStats] = await QueueSlot.aggregate([
            { $match: { status: { $in: ['active', 'waiting'] } } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]);

        const mainQueueCount = (await QueueSlot.countDocuments({ status: 'active', queueType: 'main' }));
        const waitlistCount = (await QueueSlot.countDocuments({ status: 'waiting', queueType: 'waitlist' }));

        const [depositStats] = await Transaction.aggregate([
            { $match: { type: 'deposit' } },
            {
                $group: {
                    _id: null,
                    totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                    pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                }
            }
        ]);

        const [withdrawalStats] = await Transaction.aggregate([
            { $match: { type: 'withdrawal' } },
            {
                $group: {
                    _id: null,
                    totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                    pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                }
            }
        ]);

        res.json({
            totalUsers: userStats?.totalUsers || 0,
            activeUsers: userStats?.activeUsers || 0,
            suspendedUsers: userStats?.suspendedUsers || 0,
            expiredUsers: userStats?.expiredUsers || 0,
            mainQueueCount,
            waitlistCount,
            totalDeposits: depositStats?.totalCompleted || 0,
            totalWithdrawals: withdrawalStats?.totalCompleted || 0,
            pendingDeposits: depositStats?.pendingCount || 0,
            pendingWithdrawals: withdrawalStats?.pendingCount || 0,
            totalUserBalances: userStats?.totalUserBalances || 0
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch stats', error: err.message });
    }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;
        const search = req.query.search || '';

        let query = { status: { $ne: 'admin' } };
        if (search) {
            query.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        const [users, total] = await Promise.all([
            User.find(query)
                .select('-password -pin')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query)
        ]);

        // Batch fetch active slot counts with aggregation instead of N+1
        const userIds = users.map(u => u._id);
        const slotCounts = await QueueSlot.aggregate([
            { $match: { userId: { $in: userIds }, status: { $in: ['active', 'waiting'] } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } }
        ]);
        const slotMap = {};
        slotCounts.forEach(s => { slotMap[s._id.toString()] = s.count; });

        const usersWithSlots = users.map(user => ({
            ...user,
            activeSlots: slotMap[user._id.toString()] || 0
        }));

        res.json({
            users: usersWithSlots,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch users', error: err.message });
    }
});

app.get('/api/admin/deposits', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;
        const status = req.query.status; // optional filter

        let query = { type: 'deposit' };
        if (status) query.status = status;

        const [deposits, total] = await Promise.all([
            Transaction.find(query)
                .populate('userId', 'username')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            Transaction.countDocuments(query)
        ]);

        res.json({
            deposits,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DEPOSIT VERIFY → AUTO QUEUE ASSIGNMENT
app.post('/api/admin/deposits/:id/verify', adminAuth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const transaction = await Transaction.findById(req.params.id).session(session);
        if (!transaction || transaction.status !== 'pending' || transaction.type !== 'deposit') {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Pending deposit not found' });
        }

        transaction.status = 'completed';
        await transaction.save();

        // Credit user balance + LOCK deposit permanently
        await User.findByIdAndUpdate(transaction.userId, {
            $inc: { 'wallet.balance': transaction.amount },
            $set: {
                hasDeposited: true,
                depositStatus: 'approved',
                lifecyclePhase: 'in_queue'
            }
        }).session(session);

        await session.commitTransaction();
        session.endSession();

        console.log(`[ADMIN] Deposit $${transaction.amount} verified for user ${transaction.userId} | Deposit LOCKED`);

        // AUTO-ASSIGN to queue after approval
        try {
            await queueEngine.assignToQueue(transaction.userId, transaction._id);
            // Deduct the deposit amount from balance into queue
            await User.findByIdAndUpdate(transaction.userId, {
                $inc: { 'wallet.balance': -transaction.amount, 'wallet.activeInQueue': transaction.amount }
            });
            res.json({ message: 'Deposit verified, credited, and user assigned to queue' });
        } catch (queueErr) {
            console.error('[QUEUE ASSIGN ERROR]', queueErr.message);
            res.json({ message: `Deposit verified and credited. Queue assignment: ${queueErr.message}` });
        }
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
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

        // Reset user deposit status so they can try again
        await User.findByIdAndUpdate(transaction.userId, {
            $set: {
                depositStatus: 'rejected',
                lifecyclePhase: 'fresh'
            }
        });

        res.json({ message: 'Deposit rejected. User can submit a new deposit.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const [withdrawals, total] = await Promise.all([
            Transaction.find({ type: 'withdrawal' })
                .populate('userId', 'username')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            Transaction.countDocuments({ type: 'withdrawal' })
        ]);

        res.json({
            withdrawals,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
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

        // ═══ ACCOUNT LIFECYCLE: TERMINATE on withdrawal approval ═══
        const user = await User.findById(transaction.userId);
        if (user) {
            // Remove from queue
            await QueueSlot.updateMany(
                { userId: user._id, status: { $in: ['active', 'waiting'] } },
                { $set: { status: 'completed' } }
            );

            // Terminate account
            user.status = 'terminated';
            user.lifecyclePhase = 'completed';
            user.terminatedAt = new Date();
            user.wallet.activeInQueue = 0;
            await user.save();

            console.log(`[LIFECYCLE] User ${user.username} TERMINATED after withdrawal of $${transaction.amount}`);
        }

        res.json({ message: 'Withdrawal paid. User account terminated.' });
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

        const activeSlots = await QueueSlot.find({ userId, status: { $in: ['active', 'waiting'] } });
        if (activeSlots.length > 0) {
            const refundAmount = activeSlots.reduce((sum, s) => sum + s.amount, 0);
            await QueueSlot.updateMany(
                { userId, status: { $in: ['active', 'waiting'] } },
                { status: 'cancelled' }
            );
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
        await User.findByIdAndUpdate(req.params.id, { status: 'active', queueStatus: 'eligible' });
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

// ═══════════════════════════════════════════════════
// ADMIN QUEUE MANAGEMENT
// ═══════════════════════════════════════════════════

app.get('/api/admin/queue', adminAuth, async (req, res) => {
    try {
        const mainQueue = await QueueSlot.find({ status: 'active', queueType: 'main' })
            .sort({ position: 1 })
            .populate('userId', 'username email');
        const waitlist = await QueueSlot.find({ status: 'waiting', queueType: 'waitlist' })
            .sort({ waitlistNumber: 1 })
            .populate('userId', 'username email');
        const settings = await queueEngine.getSettings();

        // Get expired slots (recent)
        const expiredSlots = await QueueSlot.find({ status: 'expired' })
            .sort({ expiredAt: -1 })
            .limit(20)
            .populate('userId', 'username email');

        // Get timers for all active slots
        const timers = mainQueue
            .filter(s => s.withdrawalDeadline)
            .map(s => ({
                slotId: s._id,
                userId: s.userId,
                position: s.position,
                deadline: s.withdrawalDeadline,
                remainingMs: Math.max(0, new Date(s.withdrawalDeadline).getTime() - Date.now()),
                isNearExpiry: (new Date(s.withdrawalDeadline).getTime() - Date.now()) < (2 * 60 * 60 * 1000), // < 2 hours
            }));

        res.json({
            mainQueue,
            waitlist,
            expiredSlots,
            settings,
            timer: queueEngine.cycleTimer,
            timers,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Manually assign user to queue
app.post('/api/admin/queue/assign/:userId', adminAuth, async (req, res) => {
    try {
        const settings = await Settings.findOne();
        const depositAmt = settings?.depositAmount ?? 1.00;
        const slot = await queueEngine.assignToQueue(req.params.userId, null);
        // Deduct from balance (dynamic amount)
        await User.findByIdAndUpdate(req.params.userId, {
            $inc: { 'wallet.balance': -depositAmt, 'wallet.activeInQueue': depositAmt }
        });
        res.json({ message: 'User assigned to queue', slot });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Admin: Extend timer
app.post('/api/admin/queue/extend-timer/:slotId', adminAuth, async (req, res) => {
    try {
        const { hours } = req.body;
        if (!hours || hours <= 0) return res.status(400).json({ message: 'Hours must be positive' });
        const slot = await queueEngine.extendTimer(req.params.slotId, hours);
        res.json({ message: `Timer extended by ${hours} hours`, slot });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Admin: Reactivate expired user
app.post('/api/admin/queue/reactivate/:userId', adminAuth, async (req, res) => {
    try {
        const user = await queueEngine.reactivateUser(req.params.userId);
        res.json({ message: 'User reactivated and eligible for queue', user: { _id: user._id, username: user.username, queueStatus: user.queueStatus } });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ═══════════════════════════════════════════════════
// ADMIN SETTINGS
// ═══════════════════════════════════════════════════

app.post('/api/admin/settings', adminAuth, async (req, res) => {
    try {
        const allowedFields = ['queueSize', 'waitlistStart', 'waitlistMax', 'maturityMultiplier', 'cycleTimerSeconds', 'cooldownSeconds', 'autoPromote', 'depositAmount', 'minDeposit', 'maxDeposit', 'withdrawalTimerHours', 'allowAutoReentry'];
        const updates = {};
        allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        const updatedSettings = await Settings.findOneAndUpdate({}, updates, { upsert: true, new: true });

        // Broadcast deposit amount change to all connected clients
        if (updates.depositAmount !== undefined) {
            io.emit('depositAmountUpdated', {
                depositAmount: updatedSettings.depositAmount
            });
            console.log(`[ADMIN] Deposit amount updated to $${updatedSettings.depositAmount}`);
        }

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
// LEGACY INVEST ROUTES (backward compat)
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

app.post('/api/reinvest', auth, pinVerify, async (req, res) => {
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
    let admin = await User.findOne({ username: 'Admin' });
    if (!admin) {
        admin = new User({
            username: 'Admin',
            email: 'admin@1dollar.app',
            password: 'admin123',
            status: 'admin'
        });
        await admin.save();
        console.log('[INIT] Admin created: Admin / admin123');
    } else {
        let needsSave = false;
        if (admin.status !== 'admin') {
            admin.status = 'admin';
            needsSave = true;
        }
        if (!admin.email) {
            admin.email = 'admin@1dollar.app';
            needsSave = true;
        }
        if (needsSave) {
            await admin.save();
            console.log('[INIT] Admin user updated (status/email fixed)');
        } else {
            console.log('[INIT] Admin already exists with correct status');
        }
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
server.listen(PORT, () => console.log(`[1 DOLLAR APP v4.0] Server running on port ${PORT}`));
