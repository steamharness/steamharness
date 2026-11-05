import type pg from "pg";
import { DatabaseResourceError } from "steamharness/database";

/** Preserve shared/exclusive fencing without configuring a timeout on an uncontended lock. */
export async function advisoryLock<T>(pool: pg.Pool, key: string, message: string, work: () => Promise<T>, wait: boolean, shared = false): Promise<T> {
  const client = await pool.connect();
  const suffix = shared ? "_shared" : "";
  let locked = false, previousTimeout: string | undefined, releaseError: Error | undefined;
  try {
    locked = (await client.query(`select pg_try_advisory_lock${suffix}(hashtextextended($1,0)) as locked`, [key])).rows[0].locked;
    if (!locked && wait) {
      previousTimeout = (await client.query("select current_setting('lock_timeout') as timeout")).rows[0].timeout;
      await client.query("select set_config('lock_timeout','5s',false)");
      try {
        await client.query(`select pg_advisory_lock${suffix}(hashtextextended($1,0))`, [key]);
        locked = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03") throw error;
      }
    }
    if (!locked) throw new DatabaseResourceError("DATABASE_BUSY", message);
    return await work();
  } finally {
    try {
      if (locked) await client.query(`select pg_advisory_unlock${suffix}(hashtextextended($1,0))`, [key]);
      if (previousTimeout !== undefined) await client.query("select set_config('lock_timeout',$1,false)", [previousTimeout]);
    } catch (error) { releaseError = error as Error; throw error; }
    finally { client.release(releaseError); }
  }
}
