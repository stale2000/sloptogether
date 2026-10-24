const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function processComfyFrameExpiry(pool,message){
  const id=message?.payload?.id;
  if(typeof id!=="string"||!UUID.test(id)||message.aggregateId!==id)throw new Error("comfy_frame_expiry_invalid");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const removed=await client.query("DELETE FROM sloptogether.comfy_frame_generations WHERE id=$1 AND expires_at<=now() RETURNING id",[id]);
    const acknowledged=await client.query(`UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL
      WHERE id=$1::bigint AND aggregate_id=$2 AND event_kind='comfy.frame_generation.expire'
        AND delivered_at IS NULL AND leased_until=$3::timestamptz RETURNING id`,[message.id,id,new Date(message.leaseUntil)]);
    if(!acknowledged.rowCount)throw new Error("comfy_frame_expiry_lease_stale");
    await client.query("COMMIT");
    return {expired:Boolean(removed.rowCount)};
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  }finally{client.release();}
}
