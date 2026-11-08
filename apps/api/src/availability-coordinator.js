import { DurableObject } from "cloudflare:workers";

/** Serializes reservations for a single operational date. */
export class AvailabilityCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_holds (
        hold_id TEXT PRIMARY KEY,
        starts_at_minute INTEGER NOT NULL,
        ends_at_minute INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_active_holds_expiry ON active_holds(expires_at);
    `);
  }

  removeExpired(now = Date.now()) {
    this.ctx.storage.sql.exec("DELETE FROM active_holds WHERE expires_at <= ?", now);
  }

  async reserve({ holdId, startsAtMinute, endsAtMinute, expiresAt, capacity }) {
    this.removeExpired();
    if (!holdId || !Number.isInteger(startsAtMinute) || !Number.isInteger(endsAtMinute) || startsAtMinute >= endsAtMinute) {
      throw new Error("Reserva inválida.");
    }

    const occupied = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM active_holds WHERE starts_at_minute < ? AND ends_at_minute > ?",
      endsAtMinute,
      startsAtMinute,
    ).one().total;

    if (Number(occupied) >= Math.max(1, Number(capacity) || 1)) {
      return { reserved: false, reason: "slot_unavailable" };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO active_holds (hold_id, starts_at_minute, ends_at_minute, expires_at) VALUES (?, ?, ?, ?)",
      holdId,
      startsAtMinute,
      endsAtMinute,
      expiresAt,
    );
    await this.scheduleNextExpiration();
    return { reserved: true };
  }

  async release(holdId) {
    this.ctx.storage.sql.exec("DELETE FROM active_holds WHERE hold_id = ?", holdId);
    await this.scheduleNextExpiration();
  }

  async scheduleNextExpiration() {
    const next = this.ctx.storage.sql.exec("SELECT MIN(expires_at) AS expires_at FROM active_holds").one();
    if (next.expires_at) await this.ctx.storage.setAlarm(Number(next.expires_at));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    this.removeExpired();
    await this.scheduleNextExpiration();
  }
}
