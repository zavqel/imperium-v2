CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_single_owner
  ON admin_users(role)
  WHERE role = 'owner';
