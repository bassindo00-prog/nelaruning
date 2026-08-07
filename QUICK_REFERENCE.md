# Persistent Job Queue - Quick Reference

## System Overview

```
User generates → Job created (persistent) → Workflow executes
                                             ↓
                                        SUCCESS? 
                                             ↓
                                        Retry delivery (3x)
                                             ↓
                                        DELIVERED ✅
                                        
Bot Restart? → Resume RUNNING jobs automatically ✅
Delivery Fails? → User runs /sync → Retry delivery ✅
```

## Key Files

| File | Purpose |
|------|---------|
| `src/job/store.ts` | Persistent JSON storage |
| `src/job/manager.ts` | Job orchestration |
| `src/bot/handlers.ts` | Command handlers + refactored startJob() |
| `src/index.ts` | Startup + job resume |
| `data/jobs/jobs.json` | All jobs stored here |
| `TEST_PLAN.md` | 6 test scenarios |
| `IMPLEMENTATION_SUMMARY.md` | Full documentation |
| `COMPLETION_REPORT.md` | This project's completion status |

## Job States

```
QUEUED      → Initial state (ready to run)
RUNNING     → Polling RunningHub
SUCCESS     → Video ready, not yet sent
DELIVERED   → Video sent to user ✅
FAILED      → Workflow or delivery failed (no retry)
```

## User Commands

### /start
- Initialize user
- Show main menu

### /sync
- Find SUCCESS jobs (video ready, not sent)
- Attempt delivery for each
- Show summary

### /model
- Select model: V1, V2, V3
- Shows token cost

### /credit
- Show token balance
- Show token stats

### /reset
- Clear session (image, video, prompt)

## API Reference

### jobStore
```typescript
await jobStore.initialize()              // Load jobs from disk
const job = jobStore.getById(id)         // Get single job
const jobs = jobStore.getRunningJobs()   // Get RUNNING jobs
const jobs = jobStore.getUndeliveredSuccess()  // Get SUCCESS jobs
await jobStore.updateStatus(id, status)  // Update + save
```

### Job Manager
```typescript
const job = await createJob(opts)        // Create + lock tokens
const ok = await executeAndDeliver(...)  // Workflow + delivery
const ok = await deliverToTelegram(...)  // Send video
await resumeJob(job, bot, config, client)  // Resume on startup
```

## Logging Patterns

### Normal Execution
```
[JobManager] Created job task_6493313218_XXX
[JobManager] Starting execution for job...
[JobManager] Workflow succeeded for job...
[JobManager] Delivery attempt 1/3...
[JobManager] Successfully delivered job...
```

### Bot Restart Resume
```
[JobStore] Loaded 3 jobs from disk
[JobManager] Resuming job task_6493313218_XXX, taskId=YYYY
[JobManager] Job task_6493313218_XXX resumed and completed
```

### /sync Command
```
/sync - processing job task_6493313218_XXX (status=SUCCESS)
[JobManager] Delivery attempt 1/3 for job...
[JobManager] Successfully delivered job task_6493313218_XXX
/sync - job task_6493313218_XXX delivered successfully
```

## Monitoring

### Check Bot Status
```bash
pm2 list nadinmotion-bot
pm2 logs nadinmotion-bot --lines 50
```

### Check Job Storage
```bash
cat data/jobs/jobs.json | jq '.'  # Pretty print
```

### Check Specific Chat Jobs
```bash
cat data/jobs/jobs.json | jq '.[].chatId' | sort | uniq -c
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Jobs not resuming | Bot crashed before resume | Check `data/jobs/jobs.json` |
| Video stuck at processing | Delivery failed | Run `/sync` command |
| Double token deduction | Restart during deduction | Should not happen (locked) |
| Bot won't start | Stale lock | `rm data/bot.lock` |
| Duplicate messages | Old code still running | `pm2 restart nadinmotion-bot` |

## Configuration

```typescript
// src/job/manager.ts
const POLL_INTERVAL_MS = 5000            // Query every 5 sec
const TIMEOUT_MS = 1_800_000             // 30 min max
const MAX_DELIVERY_ATTEMPTS = 3          // Retry 3x
const BACKOFF = [5s, 10s, 15s]           // Exponential backoff
```

## Token Flow

```
User has: 5000 tokens

Generate V1 (700 tokens):
  1. Check balance (5000 ≥ 700) ✅
  2. Lock 700 tokens
  3. Execute workflow
  4. On SUCCESS: Deduct 700 (balance = 4300)
  5. On FAILED: Refund 700 (balance = 5000)

Restart doesn't affect tokens:
  - Already deducted before restart
  - No double-deduction
```

## Message Format

### Progress Message (Edited)
```
🟣 Motion Control......

███████░░░ 71%

⏳ 05:34

📍 Mohon tunggu 7 sampai 15 menit hasil akan dikirim otomatis.....
```

### Final Message (100%)
```
🟢 Motion Control

██████████ 100%

⏱️ 9m 33s

✅ Video berhasil dikirim!
```

### Video Message (Separate)
```
Caption:
🟢 Motion Control
✅ Status: Selesai
🎬 Video berhasil dikirim
⏱️ Total waktu: 9m 33s

Terima kasih telah menggunakan NADIN AI.
```

## Performance Metrics

| Metric | Value |
|--------|-------|
| Job size | ~500 bytes |
| 1000 jobs | ~500 KB disk, ~500 KB RAM |
| Startup time | <1 second |
| Poll interval | 5 seconds |
| Max duration | 30 minutes |
| Delivery retries | 3 attempts |
| Retry delays | 5s, 10s, 15s |

## Testing Quick Start

```bash
# Terminal 1: Watch logs
pm2 logs nadinmotion-bot --lines 50

# Terminal 2: Run tests
# See TEST_PLAN.md for detailed scenarios
```

### Test 1: Normal (10 min)
- /start → Select model → Send image/video → Run
- Verify: Video delivered in ~9-10 minutes

### Test 2: Restart Resume (15 min)
- Generate → Wait 1 min → Stop bot
- Restart → Verify resume → Verify delivery

### Test 3: Sync Recovery (15 min)
- Generate → Wait 9 min (SUCCESS) → Stop bot
- Restart → /sync → Verify delivery

---

**Need more details?** See IMPLEMENTATION_SUMMARY.md

