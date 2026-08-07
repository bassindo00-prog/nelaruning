# Persistent Job Queue - Test Plan & Results

## Objective
Verify that the persistent job queue system correctly handles:
1. Job persistence across bot restarts
2. Automatic resume of RUNNING jobs on startup
3. Video delivery with retry logic
4. /sync command recovery for SUCCESS jobs
5. Final message edits showing 100% completion

## Test Scenarios

### Test 1: Normal Workflow (Generate → Deliver → Done)
**Steps:**
1. User sends /start
2. User selects model V1
3. User sends image
4. User sends video (3-30s)
5. User clicks Run button
6. Bot creates job, locks tokens
7. Bot executes workflow (polling updates progress)
8. RunningHub returns SUCCESS
9. Bot downloads video
10. Bot sends video to Telegram
11. Bot edits progress message to 100%
12. Job marked as DELIVERED

**Expected Results:**
- ✅ Single progress message (no duplicates)
- ✅ Progress message shows: "🟣 Motion Control...... / ███████░░░ 71%"
- ✅ Final message shows: "🟢 Motion Control / ██████████ 100% / ✅ Video berhasil dikirim!"
- ✅ Video caption: "🟢 Motion Control\n✅ Status: Selesai\n🎬 Video berhasil dikirim\n⏱️ Total waktu: XXXs"
- ✅ Job status in jobStore: DELIVERED
- ✅ Tokens deducted from user balance

---

### Test 2: Bot Restart While Job RUNNING
**Setup:** Job at 40% progress (RUNNING status)

**Steps:**
1. User initiates generation
2. Job status = RUNNING, has messageId, has runningHubTaskId
3. *Stop bot: `pm2 stop nadinmotion-bot`*
4. *Restart bot: `pm2 restart nadinmotion-bot`*
5. Bot startup loads jobStore
6. Bot finds RUNNING jobs
7. Bot spawns resumeJob() for each
8. Bot continues polling existing task
9. RunningHub returns SUCCESS
10. Bot delivers video via deliverVideoBuffer()
11. Job marked DELIVERED

**Expected Results:**
- ✅ Job NOT lost after restart
- ✅ Bot resumes polling without user intervention
- ✅ User sees ONE continuous progress message (same messageId)
- ✅ Progress updates continue smoothly
- ✅ Video eventually delivered
- ✅ Final message edited on same messageId
- ✅ No duplicate jobs created

---

### Test 3: Bot Restart After SUCCESS (Before Delivery)
**Setup:** Job at SUCCESS status but Telegram delivery failed

**Steps:**
1. User initiates generation
2. Workflow completes → RunningHub returns SUCCESS
3. Job status = SUCCESS
4. Video delivery fails (network error, etc)
5. *Stop bot during delivery retry*
6. *Restart bot*
7. Bot startup loads jobStore
8. Bot finds SUCCESS jobs without DELIVERED status
9. *User runs `/sync` command*
10. Bot attempts deliverToTelegram() for each SUCCESS job
11. Video successfully sent

**Expected Results:**
- ✅ Job remains in SUCCESS status after restart
- ✅ Job not lost, stored in persistent storage
- ✅ /sync command finds SUCCESS jobs
- ✅ Video delivered on retry
- ✅ Job marked DELIVERED
- ✅ No need to regenerate (cost-effective)

---

### Test 4: Multiple Simultaneous Jobs
**Setup:** Two users generating at same time

**Steps:**
1. User A: sends image, video, clicks Run
2. User B: sends image, video, clicks Run
3. Both jobs created with unique IDs
4. Both jobs tracked in jobStore
5. *Stop bot while both RUNNING*
6. *Restart bot*
7. Bot resumes both jobs
8. Both continue polling independently
9. Both eventually deliver

**Expected Results:**
- ✅ Both jobs persisted
- ✅ Both resumed independently
- ✅ No cross-chat interference
- ✅ Each has its own messageId
- ✅ Both eventually complete

---

### Test 5: /sync Command Recovery
**Setup:** User has 3 SUCCESS jobs, 1 DELIVERED

**Steps:**
1. User has 4 previous jobs from failed sessions
2. 3 jobs status = SUCCESS (video ready but not sent)
3. 1 job status = DELIVERED (already done)
4. *User runs `/sync`*
5. Bot fetches getUndeliveredSuccess()
6. Bot filters by chatId
7. Bot attempts delivery for each SUCCESS
8. /sync shows progress for each job

**Expected Results:**
- ✅ Only SUCCESS jobs attempted (not FAILED)
- ✅ Only current chat's jobs processed
- ✅ DELIVERED jobs not re-attempted
- ✅ Each job shows: "✅ Job ID: video delivered!" or "❌ Job ID: delivery failed"
- ✅ Summary at end: "✅ Terkirim: 3 / ⏳ Masih berjalan: 0 / ❌ Gagal: 0"

---

### Test 6: Token Persistence & Accounting
**Steps:**
1. User balance: 5000 tokens
2. User generates V1 job (700 tokens cost)
3. Job completes and delivers
4. Check user balance: 5000 - 700 = 4300 tokens ✅
5. *Stop bot, restart bot*
6. Check balance still 4300 tokens ✅
7. No double-deduction

**Expected Results:**
- ✅ Tokens locked during RUNNING
- ✅ Tokens deducted on SUCCESS (before delivery)
- ✅ Tokens not refunded if delivery fails (kept at SUCCESS)
- ✅ Tokens refunded on FAILED (workflow error)
- ✅ Tokens NOT double-deducted on restart

---

## Manual Testing Checklist

### Prerequisites
- [ ] Bot running: `pm2 list` shows nadinmotion-bot online
- [ ] User chat ID: 6493313218 has sufficient tokens
- [ ] Test image ready (PNG/JPG)
- [ ] Test video ready (MP4, 5-10 seconds)

### Test Execution

**Setup:**
```bash
# Terminal 1: Watch logs
pm2 logs nadinmotion-bot --lines 50

# Terminal 2: Bot control
pm2 status
```

**Run Tests:**

- [ ] **Test 1 (Normal):** Generate → Deliver → Done
  - Command: /start → Select V1 → Send image → Send video → Run
  - Verify: Single progress message, final message at 100%, token deducted
  - Duration: ~10-15 minutes
  - Expected logs:
    ```
    [JobManager] Created job task_6493313218_XXXXXXXXX
    [JobManager] Starting execution for job...
    [JobManager] Workflow succeeded for job...
    [JobManager] Delivery attempt 1/3...
    [JobManager] Successfully delivered job...
    ```

- [ ] **Test 2 (Restart RUNNING):** 
  - Command: /start → Select V1 → Send image → Send video → Run
  - After ~60 seconds (job at 40%): `pm2 stop nadinmotion-bot`
  - Wait 5 seconds, then: `pm2 restart nadinmotion-bot`
  - Verify: Progress message continues updating, video eventually delivered
  - Expected logs on restart:
    ```
    [JobStore] Loaded 1 jobs from disk
    [JobManager] Resuming job task_6493313218_XXXXXXXXX, taskId=YYYYYY
    [JobManager] Job task_6493313218_XXXXXXXXX resumed and completed
    ```

- [ ] **Test 3 (Restart after SUCCESS):**
  - Command: Generate → Let run for ~9 minutes until SUCCESS
  - During delivery (after SUCCESS): `pm2 stop nadinmotion-bot`
  - Wait 5 seconds, restart: `pm2 restart nadinmotion-bot`
  - Then run: `/sync`
  - Verify: Video delivered on sync, job marked DELIVERED
  - Expected logs:
    ```
    [JobStore] Loaded 1 jobs from disk
    Job loaded with status: SUCCESS
    /sync - processing job task_6493313218_XXXXXXXXX
    /sync - job task_6493313218_XXXXXXXXX delivered successfully
    ```

- [ ] **Test 4 (Multiple jobs):** Ask another user to generate simultaneously
  - Verify: Both jobs tracked separately
  - Stop bot, restart
  - Verify: Both resume independently

- [ ] **Test 5 (/sync command):**
  - Trigger multiple test 3 scenarios (SUCCESS but delivery failed)
  - Command: `/sync`
  - Verify: Output shows all jobs attempted
  - Check each job: status DELIVERED (success) or status QUEUED (retry later)

- [ ] **Test 6 (Token accounting):**
  - Check balance before: `use /credit`
  - Generate complete job
  - Check balance after: should be -700
  - Stop bot, restart
  - Check balance: should remain same (no double deduction)

---

## Success Criteria

✅ **All tests pass if:**
1. No duplicate progress messages (single messageId edited)
2. Final message format correct (🟢 Motion Control / ██████████ 100%)
3. Jobs survive bot restart (RUNNING → resume)
4. Videos delivered on /sync (SUCCESS → DELIVERED)
5. Token accounting correct (no double-deduction)
6. No jobs lost after restart
7. Logs show proper state transitions
8. Error handling works (retry logic activates)

❌ **Tests fail if:**
1. Duplicate progress messages appear
2. Job lost after restart (counts as FAILED)
3. Tokens double-deducted
4. /sync doesn't find SUCCESS jobs
5. Video delivery fails permanently (after 3 retries)
6. Error messages not logged

---

## Log Analysis

### Key Log Patterns to Look For

**Successful Flow:**
```
[JobManager] Created job task_6493313218_XXXXXXXXX: chat 6493313218, model v1
[JobManager] Starting execution for job task_6493313218_XXXXXXXXX
[JobManager] Workflow succeeded for job task_6493313218_XXXXXXXXX, taskId=YYYYYY
[JobManager] Deducting tokens for task_6493313218_XXXXXXXXX
[JobManager] Delivery attempt 1/3 for job task_6493313218_XXXXXXXXX
[JobManager] Successfully delivered job task_6493313218_XXXXXXXXX
```

**Resume Flow:**
```
[JobStore] Loaded 5 jobs from disk
[JobStore] Status: RUNNING
[JobManager] Resuming job task_6493313218_XXXXXXXXX, taskId=YYYYYY
[JobManager] Job task_6493313218_XXXXXXXXX resumed and completed
[JobManager] Successfully delivered job task_6493313218_XXXXXXXXX
```

**Sync Flow:**
```
/sync - processing job task_6493313218_XXXXXXXXX (status=SUCCESS)
[JobManager] Delivery attempt 1/3 for job task_6493313218_XXXXXXXXX
[JobManager] Successfully delivered job task_6493313218_XXXXXXXXX
/sync - job task_6493313218_XXXXXXXXX delivered successfully
```

---

## Notes

- Job IDs format: `task_{chatId}_{timestamp}`
- RunningHub task IDs stored separately in `runningHubTaskId` field
- Progress messages use same `messageId` (edited, not replaced)
- Retry backoff: 5s → 10s → 15s between attempts
- Timeout on resume: 30 minutes per job
- Jobs stored in: `data/jobs/jobs.json` (JSON format)

