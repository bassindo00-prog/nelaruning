#!/bin/bash
# Deployment script untuk Hermes Bot ke VPS AlmaLinux
# Run: bash DEPLOY_TO_VPS.sh

set -e  # Exit on error

echo "🚀 HERMES BOT DEPLOYMENT SCRIPT"
echo "================================"

# Step 1: Clone repository
echo ""
echo "📥 Step 1: Cloning repository..."
cd /root
if [ -d "runninghub-telegram-bot" ]; then
    echo "⚠️  Directory runninghub-telegram-bot sudah ada. Menghapus..."
    rm -rf runninghub-telegram-bot
fi
git clone https://github.com/bassindo00-prog/runinghub.git runninghub-telegram-bot
cd runninghub-telegram-bot
echo "✅ Repository cloned successfully"

# Step 2: Install dependencies
echo ""
echo "📦 Step 2: Installing dependencies..."
npm install
echo "✅ Dependencies installed"

# Step 3: Build TypeScript
echo ""
echo "🔨 Step 3: Building TypeScript..."
npm run build
echo "✅ Build completed"

# Step 4: Copy .env (manual - user harus setup)
echo ""
echo "⚠️  Step 4: .env Configuration"
echo "IMPORTANT: You must create .env file manually with:"
echo ""
echo "TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE"
echo "RUNNINGHUB_API_KEY=YOUR_KEY_HERE"
echo "RUNNINGHUB_BASE_URL=https://www.runninghub.ai/openapi/v2"
echo "RUNNINGHUB_WORKFLOW_ID=YOUR_WORKFLOW_ID"
echo "RUNNINGHUB_INSTANCE_TYPE=default"
echo "RUNNINGHUB_POLL_INTERVAL=5000"
echo "RUNNINGHUB_TIMEOUT=1800000"
echo "RUNNINGHUB_RETAIN_SECONDS=60"
echo "OUTPUT_DIR=downloads"
echo "RUNNINGHUB_RUN_PATH=run/workflow"
echo "RUNNINGHUB_MAPPING=aiwood"
echo "ADMIN_TELEGRAM_ID=YOUR_ADMIN_ID"
echo "QRIS_IMAGE_PATH=./6318678276276162638_120.jpg"
echo ""
echo "Then press Enter to continue..."
read dummy

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found! Please create it first."
    exit 1
fi
echo "✅ .env file found"

# Step 5: Start with PM2
echo ""
echo "🤖 Step 5: Starting bot with PM2..."
pm2 start dist/index.js --name hermes
echo "✅ Bot started with PM2"

# Step 6: Save PM2 config
echo ""
echo "💾 Step 6: Saving PM2 configuration..."
pm2 save
echo "✅ PM2 configuration saved"

# Step 7: Verify
echo ""
echo "🔍 Step 7: Verifying..."
echo ""
echo "PM2 Status:"
pm2 status
echo ""
echo "Recent logs (last 20 lines):"
pm2 logs hermes --lines 20 --nostream

echo ""
echo "✅ DEPLOYMENT COMPLETE!"
echo ""
echo "Next steps:"
echo "1. Check bot is online: pm2 logs hermes"
echo "2. Bot will auto-start on VPS reboot"
echo ""
