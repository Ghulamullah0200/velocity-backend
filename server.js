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
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('MongoDB error:', err));

const User = require('./models/User');
const Transaction = require('./models/Transaction');
const Settings = require('./models/Settings');

// Initialize Settings if not exists
const initSettings = async () => {
    const settings = await Settings.findOne();
    if (!settings) {
        await new Settings({ entryFee: 1 }).save();
    }
};

// Initialize Admin if not exists
const initAdmin = async () => {
    const admin = await User.findOne({ status: 'Admin' });
    if (!admin) {
        const newAdmin = new User({
            username: 'admin',
            password: 'password123',
            status: 'Admin'
        });
        await newAdmin.save();
        console.log('Default admin created: admin / password123');
    }
};

initSettings();
initAdmin();

// --- QUEUE LOGIC ---
let activeQueue = []; // List of user IDs
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
    const winnerId = activeQueue.shift();
    await User.findByIdAndUpdate(winnerId, { rank: 0, isWithdrawEligible: true, status: 'Withdraw Available' });

    for (let i = 0; i < activeQueue.length; i++) {
        await User.findByIdAndUpdate(activeQueue[i], { rank: i + 1 });
    }

    io.emit('queueUpdate', { queue: activeQueue, timer: 30 });
};

// --- ROUTES ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (await User.findOne({ username })) return res.status(400).json({ message: 'Exists' });
        const user = new User({ username, password });
        await user.save();
        res.status(201).json({ message: 'Registered' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) return res.status(401).json({ message: 'Invalid' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user });
});

app.post('/api/join-queue', async (req, res) => {
    const { userId, amount } = req.body; // amount is the deposit amount
    const user = await User.findById(userId);
    const settings = await Settings.findOne();

    if (!user || user.status !== 'Verified' || user.rank > 0 || activeQueue.length >= 21) {
        return res.status(400).json({ message: 'Cannot join. Check status or queue capacity.' });
    }

    // Enforce deposit rules: $1 or > $2
    if (amount !== 1 && amount <= 2) {
        return res.status(400).json({ message: 'Invalid deposit amount. Must be $1 or more than $2.' });
    }

    // Use admin-set entry fee
    const entryFee = settings ? settings.entryFee : 1;
    if (user.balance < entryFee) {
        return res.status(400).json({ message: `Insufficient balance. Entry fee is $${entryFee}` });
    }

    user.balance -= entryFee;
    activeQueue.push(userId);
    user.rank = activeQueue.length;
    await user.save();

    io.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
    if (activeQueue.length === 21) startCycle();
    res.json({ rank: user.rank, balance: user.balance });
});

// Admin: Set Entry Fee
app.post('/api/admin/settings', async (req, res) => {
    const { entryFee } = req.body;
    await Settings.findOneAndUpdate({}, { entryFee }, { upsert: true });
    res.json({ message: 'Settings updated' });
});

// Admin: Get Settings
app.get('/api/admin/settings', async (req, res) => {
    const settings = await Settings.findOne();
    res.json(settings || { entryFee: 1 });
});

// Admin: Terminate User
app.post('/api/admin/terminate', async (req, res) => {
    const { userId } = req.body;
    await User.findByIdAndUpdate(userId, { status: 'Terminated', rank: 0 });
    // Remove from queue if present
    activeQueue = activeQueue.filter(id => id.toString() !== userId);
    io.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
    res.json({ message: 'User terminated' });
});

// Admin verification
app.post('/api/admin/verify', async (req, res) => {
    const { userId } = req.body;
    await User.findByIdAndUpdate(userId, { status: 'Verified' });
    res.json({ message: 'Verified' });
});

io.on('connection', (socket) => {
    socket.emit('queueUpdate', { queue: activeQueue, timer: queueTimer });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
