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
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"]
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check route
app.get('/api/health', (req, res) => res.json({ status: 'Engine Running', time: new Date() }));

const User = require('./models/User');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');
const Entry = require('./models/Entry');

// MongoDB connection with Robust Startup
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('Connected to MongoDB Atlas');
        try {
            await initSettings();
            await initAdmin();
            await syncQueue();
        } catch (err) {
            console.error('Initialization error:', err);
        }
    })
    .catch(err => console.error('MongoDB error:', err));

// Initialize Settings if not exists
const initSettings = async () => {
    const settings = await Settings.findOne();
    if (!settings) {
        await new Settings({ entryFee: 1 }).save();
    }
};

// Initialize Admin if not exists or reset credentials
const initAdmin = async () => {
    let admin = await User.findOne({ status: 'Admin' });
    if (!admin) {
        admin = new User({
            username: 'Admin',
            password: 'admin123',
            status: 'Admin'
        });
        await admin.save();
        console.log('Admin created: Admin / admin123');
    } else {
        console.log('Admin already exists. Skipping credential reset.');
    }
};

// Sync Active Queue from Database on Startup
const syncQueue = async () => {
    try {
        const activeEntries = await Entry.find({ status: 'active' }).sort({ position: 1 });
        activeQueue = activeEntries.map(e => e._id.toString());
        console.log(`Queue synced: ${activeQueue.length} entries`);

        // If queue was full, restart cycle
        if (activeQueue.length >= 21) {
            startCycle();
        }
    } catch (err) {
        console.error('Queue sync error:', err);
    }
};

// --- QUEUE LOGIC ---
let activeQueue = []; // List of Entry IDs (strings)
let queueTimer = 30;
let timerRunning = false;

const startCycle = () => {
    if (timerRunning) return;
    timerRunning = true;
    queueTimer = 30;
    const interval = setInterval(async () => {
        queueTimer--;
        io.emit('timerUpdate', queueTimer);
        if (queueTimer <= 0) {
            clearInterval(interval);
            timerRunning = false;
            await processCycle();
            if (activeQueue.length >= 21) startCycle();
        }
    }, 1000);
};

const processCycle = async () => {
    if (activeQueue.length === 0) return;

    const entryId = activeQueue.shift();
    const winningEntry = await Entry.findById(entryId);

    if (winningEntry) {
        winningEntry.status = 'completed';
        winningEntry.position = 0;
        await winningEntry.save();

        await User.findByIdAndUpdate(winningEntry.userId, {
            isWithdrawEligible: true,
            status: 'Withdraw Available'
        });
    }

    // Update positions for remaining entries
    for (let i = 0; i < activeQueue.length; i++) {
        await Entry.findByIdAndUpdate(activeQueue[i], { position: i + 1 });
    }

    io.emit('queueUpdate', { queue: activeQueue, timer: 30 });
};

// --- ROUTES ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, paymentScreenshot, numVelos } = req.body;
        if (await User.findOne({ username })) return res.status(400).json({ message: 'Exists' });

        const user = new User({
            username,
            password,
            paymentScreenshot: paymentScreenshot || null,
            status: 'Pending Verification',
            velosOwned: 0 // Will be updated by admin after verification
        });
        await user.save();

        if (paymentScreenshot) {
            const settings = await Settings.findOne();
            const entryFee = settings ? settings.entryFee : 1;
            const requestedVelos = parseInt(numVelos) || 1;
            const totalAmount = requestedVelos * entryFee;

            const deposit = new Transaction({
                userId: user._id,
                type: 'deposit',
                amount: totalAmount,
                numVelos: requestedVelos,
                screenshot: paymentScreenshot,
                status: 'pending'
            });
            await deposit.save();
        }

        res.status(201).json({ message: 'Registered successfully! Please wait for admin approval.' });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await user.comparePassword(password))) return res.status(401).json({ message: 'Invalid' });
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
        res.json({ token, user });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/join-queue', async (req, res) => {
    try {
        const { userId } = req.body;
        const user = await User.findById(userId);

        if (!user || user.status !== 'Verified' || user.velosOwned <= 0 || activeQueue.length >= 21) {
            return res.status(400).json({ message: 'Cannot join. Check status or velos.' });
        }

        user.velosOwned -= 1;
        await user.save();

        const entry = new Entry({
            userId,
            position: activeQueue.length + 1,
            status: 'active'
        });
        await entry.save();

        activeQueue.push(entry._id.toString());

        io.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
        if (activeQueue.length === 21) startCycle();

        res.json({ velosOwned: user.velosOwned, entryId: entry._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// User: Request Withdrawal
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, accountDetails } = req.body;
        const user = await User.findById(userId);

        if (!user || user.status !== 'Withdraw Available') {
            return res.status(400).json({ message: 'Withdrawal not allowed' });
        }

        const withdrawal = new Transaction({
            userId,
            type: 'withdrawal',
            amount: 50, // Example fixed amount or based on balance
            accountDetails,
            status: 'pending'
        });
        await withdrawal.save();

        // Optionally deduct balance immediately or wait for admin payment
        // For now, let's keep it pending and deduct upon payment in /api/admin/withdrawals/:id/pay

        res.json({ message: 'Withdrawal request submitted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Set Entry Fee
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { entryFee } = req.body;
        await Settings.findOneAndUpdate({}, { entryFee }, { upsert: true });
        res.json({ message: 'Settings updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Get Settings
app.get('/api/admin/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        res.json(settings || { entryFee: 1 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Terminate User
app.post('/api/admin/terminate', async (req, res) => {
    try {
        const { userId } = req.body;
        await User.findByIdAndUpdate(userId, { status: 'Terminated', rank: 0 });
        // Remove from queue if present
        activeQueue = activeQueue.filter(id => id.toString() !== userId);
        io.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
        res.json({ message: 'User terminated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// User: Get status
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'Not found' });

        const entries = await Entry.find({ userId: user._id, status: 'active' }).sort({ position: 1 });

        res.json({
            status: user.status,
            balance: user.balance,
            velosOwned: user.velosOwned,
            entries: entries.map(e => ({ id: e._id, position: e.position }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const adminAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Unauthorized' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user || user.status !== 'Admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        req.user = user;
        next();
    } catch (err) { res.status(401).json({ message: 'Invalid token' }); }
};

// Admin: Get all users
app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const users = await User.find({ status: { $ne: 'Admin' } }).sort({ createdAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Get Dashboard Stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ status: { $ne: 'Admin' } });
        const pendingVerifications = await User.countDocuments({ status: 'Pending Verification' });
        const verifiedUsers = await User.countDocuments({ status: 'Verified' });

        // Deposits (Sum of all completed deposits)
        const deposits = await Transaction.aggregate([
            { $match: { type: 'deposit', status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        // Withdrawals (Sum of all completed withdrawals)
        const withdrawals = await Transaction.aggregate([
            { $match: { type: 'withdrawal', status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        res.json({
            totalUsers,
            pendingVerifications,
            verifiedUsers,
            totalDeposits: deposits[0]?.total || 0,
            totalWithdrawals: withdrawals[0]?.total || 0,
            activeQueue: activeQueue.length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Get All Deposits (Pending/All)
app.get('/api/admin/deposits', adminAuth, async (req, res) => {
    try {
        const deposits = await Transaction.find({ type: 'deposit' })
            .populate('userId', 'username')
            .sort({ createdAt: -1 });
        res.json(deposits);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Verify Deposit
app.post('/api/admin/deposits/:id/verify', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.type !== 'deposit') return res.status(404).json({ message: 'Not found' });

        transaction.status = 'completed';
        await transaction.save();

        // Ensure we are getting a valid number from the transaction
        let velosToIncr = Number(transaction.numVelos); [cite: 756]

        // Fallback: If numVelos is missing, calculate it from the amount
        if (!velosToIncr || velosToIncr <= 0) { [cite: 757]
            const settings = await Settings.findOne(); [cite: 757]
            const entryFee = settings ? settings.entryFee : 1; [cite: 757]
            velosToIncr = Math.floor(transaction.amount / entryFee); [cite: 757]
        }

        // UPDATE: Make sure the $inc operation uses the validated number
        await User.findByIdAndUpdate(transaction.userId, {
            $inc: { velosOwned: velosToIncr }, // This adds the velos to current count [cite: 758]
            $set: { status: 'Verified' } // This changes the status [cite: 758]
        });

        res.json({ message: `Verified. Added ${velosToIncr} velos.` }); [cite: 759]
    } catch (err) { 
        res.status(500).json({ error: err.message }); [cite: 760]
    }
});

// Admin: Get All Withdrawals
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
    try {
        const withdrawals = await Transaction.find({ type: 'withdrawal' })
            .populate('userId', 'username')
            .sort({ createdAt: -1 });
        res.json(withdrawals);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Mark Withdrawal as Paid
app.post('/api/admin/withdrawals/:id/pay', adminAuth, async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction || transaction.type !== 'withdrawal' || transaction.status === 'completed') {
            return res.status(404).json({ message: 'Valid pending withdrawal not found' });
        }

        transaction.status = 'completed';
        await transaction.save();

        // Update user: deduct balance and reset status/rank
        await User.findByIdAndUpdate(transaction.userId, {
            status: 'Verified',
            isWithdrawEligible: false,
            $inc: { balance: -transaction.amount }
        });

        res.json({ message: 'Withdrawal marked as paid and user balance updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Update User Velos Manually
app.patch('/api/admin/users/:id/velos', adminAuth, async (req, res) => {
    try {
        const { velosOwned } = req.body;
        if (typeof velosOwned !== 'number') return res.status(400).json({ message: 'Invalid velo count' });

        const user = await User.findByIdAndUpdate(req.params.id, { velosOwned }, { new: true });
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ message: 'Velo count updated', velosOwned: user.velosOwned });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Get Red-List Users
app.get('/api/admin/red-list', adminAuth, async (req, res) => {
    try {
        const users = await User.find({ status: 'Red-List' }).sort({ updatedAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Add to Red-List
app.post('/api/admin/red-list/add', adminAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        await User.findByIdAndUpdate(userId, { status: 'Red-List', rank: 0 });
        // Remove from queue if present
        activeQueue = activeQueue.filter(id => id.toString() !== userId);
        io.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
        res.json({ message: 'User added to Red-List' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Remove from Red-List (Reset to Pending or Verified?)
app.post('/api/admin/red-list/remove/:id', adminAuth, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.params.id, { status: 'Verified' });
        res.json({ message: 'User removed from Red-List and verified' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: Update Credentials
app.post('/api/admin/update-credentials', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Unauthorized' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const adminUser = await User.findById(decoded.id);

        if (!adminUser || adminUser.status !== 'Admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { username, password } = req.body;
        if (username) adminUser.username = username;
        if (password) adminUser.password = password;

        await adminUser.save();
        res.json({ message: 'Admin credentials updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
    socket.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
