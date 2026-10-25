-- Tailored by Kyla — initial schema.
-- Dates without a time (event, pickup, return) are stored as 'YYYY-MM-DD' text in Asia/Manila.
-- Timestamps are stored as ISO-8601 UTC text. Money is stored in centavos (INTEGER).

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  full_name       TEXT NOT NULL,
  phone           TEXT,
  address         TEXT,
  disabled        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,           -- sha256 of the cookie token; the raw token is never stored
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE gowns (
  id                   INTEGER PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  description          TEXT,
  category_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sizes                TEXT,               -- free text as Kyla writes it, e.g. "S, M" or "Made to measure"
  measurements         TEXT,               -- JSON {bust, waist, hips, length, notes}; only shown when provided
  color                TEXT,
  design_details       TEXT,
  offer_rental         INTEGER NOT NULL DEFAULT 0,
  offer_purchase       INTEGER NOT NULL DEFAULT 0,
  offer_custom         INTEGER NOT NULL DEFAULT 0,  -- "request a version of this gown"
  rental_price         INTEGER,            -- centavos, for one rental period
  rental_period_days   INTEGER,            -- maximum days covered by rental_price
  purchase_price       INTEGER,            -- centavos
  security_deposit     INTEGER,            -- centavos
  care_instructions    TEXT,
  terms                TEXT,
  listing_status       TEXT NOT NULL DEFAULT 'draft'
                       CHECK (listing_status IN ('draft', 'published', 'unpublished', 'archived')),
  availability_status  TEXT NOT NULL DEFAULT 'available'
                       CHECK (availability_status IN ('available', 'reserved', 'rented', 'sold', 'unavailable')),
  featured             INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  published_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  version              INTEGER NOT NULL DEFAULT 1   -- optimistic lock for concurrent edits
);
CREATE INDEX gowns_listing ON gowns(listing_status, sort_order);

CREATE TABLE gown_images (
  id            INTEGER PRIMARY KEY,
  gown_id       INTEGER NOT NULL REFERENCES gowns(id) ON DELETE CASCADE,
  file_key      TEXT NOT NULL,             -- base name of the stored derivatives
  has_cutout    INTEGER NOT NULL DEFAULT 0,
  presentation  TEXT NOT NULL DEFAULT 'frame' CHECK (presentation IN ('frame', 'cutout')),
  backdrop      TEXT NOT NULL DEFAULT 'bone',
  kind          TEXT NOT NULL DEFAULT 'look' CHECK (kind IN ('look', 'detail', 'atelier')),
  alt           TEXT,
  caption       TEXT,
  width         INTEGER,
  height        INTEGER,
  cut_width     INTEGER,
  cut_height    INTEGER,
  is_main       INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX gown_images_gown ON gown_images(gown_id, sort_order);

-- One row per physical piece. Rentals and sales are assigned to a unit so that
-- a gown with a single piece can never be double-booked.
CREATE TABLE gown_units (
  id        INTEGER PRIMARY KEY,
  gown_id   INTEGER NOT NULL REFERENCES gowns(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  size      TEXT,
  status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reserved_sale', 'sold', 'retired'))
);
CREATE INDEX gown_units_gown ON gown_units(gown_id);

-- Dates Kyla blocks manually (fittings, repairs, personal use).
CREATE TABLE availability_blocks (
  id          INTEGER PRIMARY KEY,
  gown_id     INTEGER NOT NULL REFERENCES gowns(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES gown_units(id) ON DELETE CASCADE,  -- NULL blocks every unit
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX availability_blocks_gown ON availability_blocks(gown_id, start_date);

CREATE TABLE wishlist (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gown_id     INTEGER NOT NULL REFERENCES gowns(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, gown_id)
);

CREATE TABLE rentals (
  id                 INTEGER PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,
  customer_id        INTEGER NOT NULL REFERENCES users(id),
  gown_id            INTEGER NOT NULL REFERENCES gowns(id),
  unit_id            INTEGER REFERENCES gown_units(id),
  event_date         TEXT NOT NULL,
  pickup_date        TEXT NOT NULL,
  return_date        TEXT NOT NULL,
  size_note          TEXT,
  customer_note      TEXT,
  -- Prices are copied from the listing when the request is made so later edits don't change it.
  quoted_price       INTEGER,
  quoted_deposit     INTEGER,
  period_days        INTEGER,
  terms_snapshot     TEXT,
  status             TEXT NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'awaiting_deposit', 'confirmed', 'picked_up',
                                       'returned', 'completed', 'rejected', 'cancelled')),
  deposit_status     TEXT NOT NULL DEFAULT 'not_received'
                     CHECK (deposit_status IN ('not_required', 'not_received', 'received', 'refunded', 'partially_refunded', 'withheld')),
  actual_pickup_at   TEXT,
  actual_return_at   TEXT,
  return_condition   TEXT CHECK (return_condition IS NULL OR return_condition IN ('good', 'needs_cleaning', 'damaged')),
  damage_notes       TEXT,
  admin_note         TEXT,
  decision_reason    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (pickup_date <= event_date AND event_date <= return_date)
);
CREATE INDEX rentals_gown_dates ON rentals(gown_id, status, pickup_date, return_date);
CREATE INDEX rentals_customer ON rentals(customer_id, created_at);

CREATE TABLE orders (
  id                 INTEGER PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,
  customer_id        INTEGER NOT NULL REFERENCES users(id),
  gown_id            INTEGER NOT NULL REFERENCES gowns(id),
  unit_id            INTEGER REFERENCES gown_units(id),
  size_note          TEXT,
  fulfillment        TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfillment IN ('pickup', 'delivery')),
  delivery_address   TEXT,
  customer_note      TEXT,
  quoted_price       INTEGER,
  terms_snapshot     TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'processing', 'ready', 'completed', 'cancelled')),
  payment_status     TEXT NOT NULL DEFAULT 'unpaid'
                     CHECK (payment_status IN ('unpaid', 'partially_paid', 'verified', 'refunded')),
  payment_note       TEXT,
  admin_note         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX orders_customer ON orders(customer_id, created_at);
CREATE INDEX orders_status ON orders(status);

CREATE TABLE custom_requests (
  id                   INTEGER PRIMARY KEY,
  reference            TEXT NOT NULL UNIQUE,
  customer_id          INTEGER NOT NULL REFERENCES users(id),
  based_on_gown_id     INTEGER REFERENCES gowns(id) ON DELETE SET NULL,
  event_type           TEXT NOT NULL,
  event_date           TEXT,
  silhouette           TEXT,
  colors               TEXT,
  fabrics              TEXT,
  measurements         TEXT,               -- JSON; private to the customer and admins
  budget_min           INTEGER,
  budget_max           INTEGER,
  instructions         TEXT,
  contact_name         TEXT NOT NULL,
  contact_phone        TEXT,
  contact_email        TEXT NOT NULL,
  preferred_contact    TEXT,
  status               TEXT NOT NULL DEFAULT 'pending_review'
                       CHECK (status IN ('pending_review', 'quotation_sent', 'awaiting_approval', 'approved',
                                         'in_progress', 'ready_for_fitting', 'completed', 'cancelled')),
  agreed_measurements  TEXT,
  design_notes         TEXT,
  fitting_date         TEXT,
  deadline             TEXT,
  admin_note           TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX custom_requests_customer ON custom_requests(customer_id, created_at);
CREATE INDEX custom_requests_status ON custom_requests(status);

-- Inspiration images are private: served only to the owner and admins.
CREATE TABLE custom_request_images (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
  file_key    TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE quotations (
  id                  INTEGER PRIMARY KEY,
  request_id          INTEGER NOT NULL REFERENCES custom_requests(id) ON DELETE CASCADE,
  amount              INTEGER NOT NULL,
  downpayment         INTEGER,
  details             TEXT NOT NULL,
  proposed_deadline   TEXT,
  valid_until         TEXT,
  status              TEXT NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn', 'superseded')),
  customer_response   TEXT,
  responded_at        TEXT,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX quotations_request ON quotations(request_id, created_at);

-- Every status change on a rental, order or custom request.
CREATE TABLE status_events (
  id           INTEGER PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('rental', 'order', 'custom', 'gown')),
  entity_id    INTEGER NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users(id),
  note         TEXT,
  visible_to_customer INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX status_events_entity ON status_events(entity_type, entity_id, created_at);

-- Conversations between a customer and the studio, optionally about one gown or request.
CREATE TABLE threads (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type     TEXT NOT NULL CHECK (subject_type IN ('general', 'gown', 'rental', 'order', 'custom')),
  subject_id       INTEGER,
  subject_label    TEXT NOT NULL,
  last_message_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  customer_unread  INTEGER NOT NULL DEFAULT 0,
  studio_unread    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (customer_id, subject_type, subject_id)
);
CREATE INDEX threads_last ON threads(last_message_at);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX messages_thread ON messages(thread_id, created_at);

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  dedupe_key  TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE login_attempts (
  key         TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX login_attempts_key ON login_attempts(key, at);
