-- Signing-in help without email: a customer asks for help, Kyla issues a temporary
-- password from the studio, and the customer must choose a new one on next sign-in.
ALTER TABLE users ADD COLUMN password_help_at TEXT;      -- when the customer last asked for help signing in
ALTER TABLE users ADD COLUMN password_help_note TEXT;    -- how they asked to be contacted
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
