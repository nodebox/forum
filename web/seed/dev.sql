-- Sample content for local development only.
INSERT INTO categories (id, slug, name, description, position, topic_count) VALUES
 (1, 'general-discussion', 'General Discussion', 'Questions and talk about NodeBox. Stuck on something? Ask here, and attach your project.', 1, 2),
 (2, 'show-your-work', 'Show Your Work', 'Share what you made with NodeBox.', 2, 1),
 (3, 'nodebox-3', 'NodeBox 3', 'The desktop app: bugs, nodes and how-tos.', 3, 1),
 (4, 'nodebox-live', 'NodeBox Live', 'NodeBox in the browser.', 4, 0),
 (5, 'nodebox-1', 'NodeBox 1', 'The original Python app for Mac, no longer developed.', 5, 1),
 (6, 'nodebox-opengl', 'NodeBox OpenGL', 'The Python library for OpenGL, no longer developed.', 6, 0);
UPDATE categories SET archived = 1 WHERE slug IN ('nodebox-1', 'nodebox-opengl');

INSERT INTO users (id, email, name, is_admin, created_at, tender_id) VALUES
 (1, 'frederik@example.com', 'Frederik De Bleser', 1, '2010-01-01T00:00:00Z', 101),
 (2, 'lucas@example.com', 'Lucas Nijs', 0, '2011-03-01T00:00:00Z', 102),
 (3, 'ana@example.com', 'Ana Moreira', 0, '2026-10-01T00:00:00Z', NULL),
 (4, 'kenji@example.com', 'Kenji Watanabe', 0, '2026-09-20T00:00:00Z', NULL),
 (5, NULL, 'pakket-melding', 0, '2025-01-01T00:00:00Z', 999);

INSERT INTO topics (id, category_id, user_id, title, slug, created_at, last_post_at, last_post_user_id, post_count, pinned, solved, status, tender_id) VALUES
 (1, 1, 3, 'How do I make a grid of circles follow a CSV column?', 'how-do-i-make-a-grid-of-circles-follow-a-csv-column', '2026-10-11T09:12:00Z', '2026-10-12T08:40:00Z', 1, 3, 0, 1, 'visible', NULL),
 (2, 2, 4, 'Generative posters for a jazz festival', 'generative-posters-for-a-jazz-festival', '2026-10-10T14:00:00Z', '2026-10-12T11:05:00Z', 2, 2, 0, 0, 'visible', NULL),
 (3, 1, 2, 'Welcome to the new forum: read this first', 'welcome-to-the-new-forum-read-this-first', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 2, 1, 1, 0, 'visible', NULL),
 (4, 3, 2, 'Import SVG crashes on files with gradients', 'import-svg-crashes-on-files-with-gradients', '2014-05-02T10:00:00Z', '2014-05-03T12:00:00Z', 1, 2, 0, 1, 'visible', 4711),
 (6, 5, 4, 'Drawing a path along a Bézier curve with the Bezier library', 'drawing-a-path-along-a-bezier-curve', '2009-03-14T10:00:00Z', '2009-03-14T10:00:00Z', 4, 1, 0, 0, 'visible', 4700),
 (5, 1, 5, 'Pakketmelding: verlies uw levering niet!', 'pakketmelding-verlies-uw-levering-niet', '2025-02-01T10:00:00Z', '2025-02-01T10:00:00Z', 5, 0, 0, 0, 'spam', 4712);

INSERT INTO posts (id, topic_id, user_id, body, created_at, status, moderation_reason, tender_number) VALUES
 (1, 1, 3, 'I have a CSV with a `size` column and I want each circle in a 10×10 grid to take its radius from the matching row.

Right now every circle gets the same size. Project attached, along with a screenshot of what I see.', '2026-10-11T09:12:00Z', 'visible', NULL, NULL),
 (2, 1, 1, 'You''re almost there. The **Grid** node outputs 100 points, but the CSV gives you a list of rows. Put a **Lookup** node between them and set its key to `size`:

```
import_csv → lookup (key: size) → ellipse.width
grid → ellipse.position
```

NodeBox matches the two lists element by element, so the first point gets the first row.', '2026-10-11T10:02:00Z', 'visible', NULL, NULL),
 (3, 1, 3, 'That was it, thank you!', '2026-10-12T08:40:00Z', 'visible', NULL, NULL),
 (4, 2, 4, 'Made a set of posters for a small jazz festival. Every poster is the same network with a different seed, and the colours come from the line-up spreadsheet.

Happy to share the project if anyone wants to dig in.', '2026-10-10T14:00:00Z', 'visible', NULL, NULL),
 (5, 2, 2, 'These are lovely. The rhythm in the third one is great.', '2026-10-12T11:05:00Z', 'visible', NULL, NULL),
 (6, 3, 2, 'This forum replaces the old one. Your old account and posts came along: sign in with the same email address and they''re yours.

- Attach your `.ndbx` project or a ZIP of the project folder when you ask a question.
- Paste screenshots straight into the message box.
- Mark your topic **solved** when you have an answer.', '2026-10-01T10:00:00Z', 'visible', NULL, NULL),
 (7, 4, 2, 'When I import an SVG that has a linear gradient, NodeBox 3.0.40 crashes with a NullPointerException.', '2014-05-02T10:00:00Z', 'visible', NULL, 1),
 (8, 4, 1, 'Fixed in 3.0.41. Gradients are now ignored on import instead of crashing.', '2014-05-03T12:00:00Z', 'visible', NULL, 2),
 (10, 6, 4, 'How do I make every point of a path follow a Bézier curve in NodeBox 1? I can draw the curve but not walk along it.', '2009-03-14T10:00:00Z', 'visible', NULL, 1),
 (9, 5, 5, 'Uw pakket kon niet worden bezorgd. Klik hier om uw adres te bevestigen.', '2025-02-01T10:00:00Z', 'spam', 'Classified as spam during import', 1);

INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES
 (2, 3, '❤️', '2026-10-11T10:30:00Z'), (2, 3, '👍', '2026-10-11T10:30:00Z'), (2, 4, '👍', '2026-10-11T11:30:00Z'),
 (4, 2, '🎉', '2026-10-11T11:30:00Z'), (4, 1, '🎉', '2026-10-11T11:31:00Z'), (4, 3, '❤️', '2026-10-11T11:32:00Z'),
 (8, 2, '👍', '2014-05-03T13:00:00Z'),
 (2, 4, '❤️', '2026-10-11T12:00:00Z'), (2, 2, '❤️', '2026-10-11T12:10:00Z'), (3, 1, '❤️', '2026-10-12T09:00:00Z'),
 (4, 1, '❤️', '2026-10-11T11:33:00Z'), (6, 3, '❤️', '2026-10-02T09:00:00Z');

INSERT INTO legacy_redirects (path, topic_id) VALUES ('/discussions/problems/4711-import-svg-crashes-on-files-with-gradients', 4);

-- Frederik watches the topics he answered; he hasn't seen the latest replies yet.
INSERT INTO topic_users (user_id, topic_id, watching, last_seen_at) VALUES
 (1, 1, 1, '2026-10-11T10:02:00Z'),
 (1, 2, 1, '2026-10-11T12:00:00Z'),
 (1, 4, NULL, '2014-05-03T12:00:00Z');
