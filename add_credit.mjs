import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data', 'bot.json');
const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));

const userId = 6493313218;
const amount = 2000;

if (!data.tokenBalances) data.tokenBalances = {};
if (!data.tokenBalances[userId]) {
  data.tokenBalances[userId] = {
    chatId: userId,
    balance: 0,
    lockedTokens: 0,
    totalEarned: 0,
    totalSpent: 0,
    updatedAt: Date.now()
  };
}

data.tokenBalances[userId].balance += amount;
data.tokenBalances[userId].totalEarned += amount;
data.tokenBalances[userId].updatedAt = Date.now();

if (!data.tokenHistory) data.tokenHistory = [];
data.tokenHistory.push({
  id: `${userId}_${Date.now()}_0.admin`,
  chatId: userId,
  type: 'earn',
  tokens: amount,
  reason: 'Admin manual add',
  createdAt: Date.now()
});

fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

console.log('✅ BERHASIL!');
console.log('User: 6493313218');
console.log('Amount: +2000 token');
console.log('New Balance: ' + data.tokenBalances[userId].balance + ' token');
