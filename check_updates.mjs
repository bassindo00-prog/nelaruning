import { config } from 'dotenv'; config();
const T = process.env.TELEGRAM_BOT_TOKEN;
const base = `https://api.telegram.org/bot${T}`;
const chatId = 6493313218;
const off = await (await fetch(`${base}/getUpdates?limit=100`)).json();
const msgs = (off.result || []).filter(x => (x.message || x.callback_query?.message)?.chat?.id === chatId);
console.log('recent msgs:');
for (const x of msgs.slice(-5)) {
  const m = x.message || x.callback_query?.message;
  const t = m.text || '(inline kb)';
  console.log(`  ${new Date(m.date * 1000).toLocaleTimeString()}: ${t.slice(0, 90)}`);
}
