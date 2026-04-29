/**
 * ═══════════════════════════════════════════════════
 * CLEANUP SCRIPT — Remove All Non-Admin Users
 * ═══════════════════════════════════════════════════
 * 
 * This script removes ALL user accounts from the database
 * EXCEPT admin accounts. It also cleans up:
 *   - Queue Slots belonging to removed users
 *   - Transactions belonging to removed users
 * 
 * Usage:
 *   node scripts/cleanup-users.js
 * 
 * Add --dry-run flag to preview what would be deleted:
 *   node scripts/cleanup-users.js --dry-run
 * 
 * Add --force flag to skip confirmation prompt:
 *   node scripts/cleanup-users.js --force
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const readline = require('readline');

// Load env from parent directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import models
const User = require('../models/User');
const QueueSlot = require('../models/QueueSlot');
const Transaction = require('../models/Transaction');

const isDryRun = process.argv.includes('--dry-run');
const isForce = process.argv.includes('--force');

async function askConfirmation(message) {
    if (isForce) return true;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(message, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

async function cleanup() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  1 Dollar App — User Cleanup Script');
    console.log('═══════════════════════════════════════════════════\n');

    if (isDryRun) {
        console.log('🔍 DRY RUN MODE — No data will be deleted\n');
    }

    // Connect to MongoDB
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB:', err.message);
        process.exit(1);
    }

    try {
        // Find admin accounts (to preserve)
        const admins = await User.find({ status: 'admin' }).select('username email status');
        console.log(`🛡️  Admin accounts found (WILL BE KEPT):`);
        if (admins.length === 0) {
            console.log('   ⚠️  No admin accounts found!');
        } else {
            admins.forEach(a => {
                console.log(`   • ${a.username} (${a.email})`);
            });
        }

        // Find non-admin accounts (to delete)
        const nonAdmins = await User.find({ status: { $ne: 'admin' } }).select('username email status wallet hasDeposited lifecyclePhase');
        console.log(`\n🗑️  Non-admin accounts to DELETE: ${nonAdmins.length}`);
        if (nonAdmins.length > 0) {
            nonAdmins.forEach(u => {
                console.log(`   • ${u.username} (${u.email}) — status: ${u.status}, balance: $${u.wallet?.balance || 0}, phase: ${u.lifecyclePhase}`);
            });
        }

        const nonAdminIds = nonAdmins.map(u => u._id);

        // Count related data
        const queueSlotCount = await QueueSlot.countDocuments({ userId: { $in: nonAdminIds } });
        const transactionCount = await Transaction.countDocuments({ userId: { $in: nonAdminIds } });

        console.log(`\n📊 Related data to be cleaned:`);
        console.log(`   • Queue Slots: ${queueSlotCount}`);
        console.log(`   • Transactions: ${transactionCount}`);

        if (nonAdmins.length === 0) {
            console.log('\n✅ No non-admin users to remove. Database is clean!');
            await mongoose.disconnect();
            process.exit(0);
        }

        if (isDryRun) {
            console.log('\n🔍 DRY RUN complete — No data was modified.');
            await mongoose.disconnect();
            process.exit(0);
        }

        // Confirmation
        const confirmed = await askConfirmation(
            `\n⚠️  This will permanently DELETE ${nonAdmins.length} user(s), ${queueSlotCount} queue slot(s), and ${transactionCount} transaction(s).\n   Continue? (y/N): `
        );

        if (!confirmed) {
            console.log('\n❌ Cleanup cancelled.');
            await mongoose.disconnect();
            process.exit(0);
        }

        console.log('\n🔄 Deleting...');

        // Delete in order: queue slots → transactions → users
        const deletedSlots = await QueueSlot.deleteMany({ userId: { $in: nonAdminIds } });
        console.log(`   ✅ Deleted ${deletedSlots.deletedCount} queue slots`);

        const deletedTxns = await Transaction.deleteMany({ userId: { $in: nonAdminIds } });
        console.log(`   ✅ Deleted ${deletedTxns.deletedCount} transactions`);

        const deletedUsers = await User.deleteMany({ status: { $ne: 'admin' } });
        console.log(`   ✅ Deleted ${deletedUsers.deletedCount} users`);

        // Also clean up orphaned queue slots and transactions (just in case)
        const orphanedSlots = await QueueSlot.deleteMany({});
        if (orphanedSlots.deletedCount > 0) {
            console.log(`   ✅ Cleaned ${orphanedSlots.deletedCount} remaining orphaned queue slots`);
        }

        console.log('\n═══════════════════════════════════════════════════');
        console.log('  ✅ CLEANUP COMPLETE');
        console.log(`  • ${deletedUsers.deletedCount} users removed`);
        console.log(`  • ${deletedSlots.deletedCount + deletedTxns.deletedCount} related records removed`);
        console.log(`  • ${admins.length} admin account(s) preserved`);
        console.log('═══════════════════════════════════════════════════\n');

    } catch (err) {
        console.error('\n❌ Cleanup failed:', err.message);
        console.error(err);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

cleanup();
