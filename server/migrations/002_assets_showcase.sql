-- Asset library, studio presentation and the homepage showcase.

-- Categories belong to a section of the collection (women's gowns, menswear, costumes…).
ALTER TABLE categories ADD COLUMN section TEXT NOT NULL DEFAULT 'gowns'
  CHECK (section IN ('gowns', 'menswear', 'costumes', 'other'));

-- Which manifest entry a listing was created from (keeps the import idempotent).
ALTER TABLE gowns ADD COLUMN source_asset TEXT;
CREATE UNIQUE INDEX gowns_source_asset ON gowns(source_asset) WHERE source_asset IS NOT NULL;

-- gown_images gains the 'studio' presentation (the shared ivory canvas). SQLite cannot
-- change a CHECK constraint in place, so the table is rebuilt with its data.
CREATE TABLE gown_images_new (
  id            INTEGER PRIMARY KEY,
  gown_id       INTEGER NOT NULL REFERENCES gowns(id) ON DELETE CASCADE,
  file_key      TEXT NOT NULL,
  has_cutout    INTEGER NOT NULL DEFAULT 0,
  has_studio    INTEGER NOT NULL DEFAULT 0,
  presentation  TEXT NOT NULL DEFAULT 'frame' CHECK (presentation IN ('frame', 'cutout', 'studio')),
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
INSERT INTO gown_images_new (id, gown_id, file_key, has_cutout, presentation, backdrop, kind, alt, caption, width, height, cut_width, cut_height, is_main, sort_order, created_at)
  SELECT id, gown_id, file_key, has_cutout, presentation, backdrop, kind, alt, caption, width, height, cut_width, cut_height, is_main, sort_order, created_at FROM gown_images;
DROP TABLE gown_images;
ALTER TABLE gown_images_new RENAME TO gown_images;
CREATE INDEX gown_images_gown ON gown_images(gown_id, sort_order);
CREATE INDEX gown_images_key ON gown_images(file_key);

-- Every processed photograph available to the studio, whether or not a listing uses it yet.
CREATE TABLE library_images (
  id           INTEGER PRIMARY KEY,
  file_key     TEXT NOT NULL UNIQUE,
  sha256       TEXT UNIQUE,                 -- of the source file, so imports never duplicate
  source       TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('manifest', 'upload')),
  source_file  TEXT,                        -- e.g. assets/originals/dress11.jpg
  category     TEXT,                        -- manifest category path, e.g. gowns/evening-gowns
  title        TEXT,
  kind         TEXT NOT NULL DEFAULT 'look' CHECK (kind IN ('look', 'detail', 'atelier')),
  caption      TEXT,
  width        INTEGER,
  height       INTEGER,
  has_cutout   INTEGER NOT NULL DEFAULT 0,
  cut_width    INTEGER,
  cut_height   INTEGER,
  has_studio   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  people_note  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The curated homepage showcase: one masterpiece and an ordered set of signature gowns.
CREATE TABLE showcase (
  id        INTEGER PRIMARY KEY,
  gown_id   INTEGER NOT NULL UNIQUE REFERENCES gowns(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('masterpiece', 'signature')),
  position  INTEGER NOT NULL DEFAULT 0,
  image_id  INTEGER REFERENCES gown_images(id) ON DELETE SET NULL,  -- which photograph to show; main if NULL
  note      TEXT                                                     -- optional line shown with the gown
);
CREATE UNIQUE INDEX showcase_one_masterpiece ON showcase(role) WHERE role = 'masterpiece';
