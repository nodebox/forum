-- Categories about products that are no longer developed stay readable but take no new topics.
ALTER TABLE categories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
UPDATE categories SET archived = 1 WHERE name IN ('NodeBox 1', 'NodeBox OpenGL');
