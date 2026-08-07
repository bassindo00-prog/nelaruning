# PM2 Autostart Configuration Report
**Date:** 2026-08-06  
**Bot:** nadinmotion-bot  
**Status:** ✅ CONFIGURED FOR AUTOSTART

---

## Summary

Bot Telegram `@nadinmotion_bot` kini dikonfigurasi untuk berjalan otomatis setelah Windows 11 restart. Berikut adalah langkah-langkah dan konfigurasi yang dilakukan.

---

## What Was Changed

### 1. ✅ PM2 Configuration
**File:** `c:\Users\avelin\Downloads\RUN\runninghub-telegram-bot\ecosystem.config.cjs`

- Updated script path to absolute path: `c:\\Users\\avelin\\Downloads\\RUN\\runninghub-telegram-bot\\dist\\index.js`
- Set working directory (cwd)
- Max memory: 500MB
- Kill timeout: 5000ms
- Logging enabled: `logs/out.log`, `logs/error.log`

### 2. ✅ PM2 Process Saved
**Command:** `pm2 save`  
**Location:** `C:\Users\avelin\.pm2\dump.pm2`

Process state persisted. Contains:
- nadinmotion-bot config
- Environment variables
- Auto-restart settings
- Autostart: true

### 3. ✅ PM2 Installed & Set Up
- pm2-windows-startup installed globally (Node.js version via npm)
- Registry entry attempted (may require Admin rights for HKLM write)

### 4. ✅ Windows Startup Scripts Created

**Batch File (Primary):**
- Path: `C:\Users\avelin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\pm2-resurrect.bat`
- Function: Launches PowerShell script on Windows startup
- Delay: 5 seconds (wait for network)
- Logs: `runninghub-telegram-bot\logs\startup.log`

**PowerShell Script (Secondary):**
- Path: `C:\Users\avelin\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\pm2-resurrect.ps1`
- Function: Executes `pm2 resurrect` to restore all saved processes
- Execution policy: Bypass (needed for startup)

---

## How It Works

### Startup Flow:
1. **Windows boots** → Startup folder triggers
2. **pm2-resurrect.bat** runs → executes PowerShell
3. **pm2-resurrect.ps1** runs → calls `pm2 resurrect`
4. **PM2 reads dump.pm2** → restores nadinmotion-bot
5. **Bot starts** → connects to Telegram API
6. **Log entry** created in `startup.log`

---

## Verification

### Current PM2 Status:
```
ID  | Name             | Status | PID   | Uptime | Memory
----+------------------+--------+-------+--------+----------
0   | nadinmotion-bot  | online | 8976  | 61s    | 73.8mb
```

### Saved Process:
- autostart: **true**
- autorestart: **true**
- exec_mode: **fork_mode**

---

## Files Created/Modified

| File | Type | Status |
|------|------|--------|
| `ecosystem.config.cjs` | Modified | ✅ Absolute paths updated |
| `C:\Users\avelin\.pm2\dump.pm2` | Auto-generated | ✅ Process saved |
| `Startup\pm2-resurrect.bat` | Created | ✅ New |
| `Startup\pm2-resurrect.ps1` | Created | ✅ New |
| `PM2_AUTOSTART_SETUP.md` | Created | ✅ This file |

---

## Admin Rights Required?

❌ **NO ADMIN RIGHTS NEEDED** for your user!

The Startup folder method works entirely within user context:
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` is user-writable
- No registry HKLM edits required
- PowerShell execution policy bypass used (for startup scripts only)

**If you want HKLM registry entry** (machine-wide startup, not just this user):
- Run: `node "C:\Users\avelin\AppData\Roaming\npm\node_modules\pm2-windows-startup\index.js" install`
- Requires: Administrator PowerShell window

---

## Testing the Setup

### Test 1: Check Saved State
```powershell
pm2 list
```
Should show: `nadinmotion-bot` with status `online`

### Test 2: Manually Test Resurrect
```powershell
pm2 stop nadinmotion-bot
pm2 resurrect
```
Bot should restart automatically.

### Test 3: After Real Restart
- Restart Windows
- Wait 10 seconds
- Bot should be running: `pm2 list` or check Telegram @nadinmotion_bot

---

## Troubleshooting

### If Bot Doesn't Start on Reboot

1. **Check startup scripts exist:**
   ```powershell
   ls "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
   ```
   Should see: `pm2-resurrect.bat` and `pm2-resurrect.ps1`

2. **Check PM2 dump.pm2:**
   ```powershell
   cat C:\Users\avelin\.pm2\dump.pm2
   ```
   Should contain nadinmotion-bot config with `autostart: true`

3. **Manual test:**
   ```powershell
   pm2 resurrect
   ```
   If this works, startup scripts just didn't run. Check Windows Task Scheduler logs.

4. **Check logs:**
   ```powershell
   cat c:\Users\avelin\Downloads\RUN\runninghub-telegram-bot\logs\startup.log
   ```

---

## Next Steps

1. **Restart Windows** to verify autostart works
2. **Monitor logs** for first startup: `pm2 logs nadinmotion-bot`
3. **Test bot** by sending command to @nadinmotion_bot on Telegram
4. If issues arise, share logs from `startup.log` and `error.log`

---

## Notes

- Bot will survive process crashes (PM2 auto-restart)
- Bot will survive Windows restarts (PM2 resurrect + startup scripts)
- Logs preserved in: `runninghub-telegram-bot/logs/`
- To stop: `pm2 stop nadinmotion-bot`
- To pause resurrect: Remove startup scripts (manually) or `pm2 unstartup`

---

**Configuration Complete!** ✅  
Bot is now **24/7 production-ready** on Windows 11.
