/**
 * Child process for the two-process lost-update test (Phase 2 acceptance gate).
 *
 * Hammers writeReceipt against a shared real ledger file. Two of these running
 * at once will, on the current split load->mutate->save code, race and silently
 * drop receipts (last-writer-wins). Under a correct withLedger cross-process
 * transaction, every write survives.
 *
 * Usage: tsx concurrent-writer.mjs <ledgerPath> <eventLogPath> <messageId> <agentId> <count>
 */
import { dirname } from 'node:path'
import { setLedgerPath, setEventLogPath, writeReceipt } from '../../src/core.js'

const [ledgerPath, eventLogPath, messageId, agentId, countStr] = process.argv.slice(2)
setLedgerPath(dirname(ledgerPath), ledgerPath)
setEventLogPath(eventLogPath)

const count = Number(countStr)
for (let i = 0; i < count; i++) {
  // Each action is unique, so every call is a distinct receipt (unique idempotency
  // key). Total expected across both writers = 2 * count. Any shortfall = lost updates.
  writeReceipt(agentId, messageId, `vote-${agentId}-${i}`)
}
