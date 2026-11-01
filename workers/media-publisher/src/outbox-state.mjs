export async function finishStale(pool, message) {
  await pool.query(`UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL
    WHERE id=$1 AND delivered_at IS NULL AND leased_until=$2`, [message.id, message.leaseUntil]);
}
