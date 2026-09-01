import { Hono } from 'hono';
import { getDb } from '../db.js';

const feed = new Hono();

/**
 * GET /api/feed
 * Library/store-style homepage feed:
 *  - trending: recency-weighted blend of downloads + searches (last 14 days)
 *  - most_downloaded: all-time
 *  - recently_added: newest uploads
 *  - discover: random units outside the above, so the feed doesn't go stale
 *              and lesser-known units still get surfaced (the "general liking"
 *              signal comes from download_count/search_count nudging what's
 *              *likely* interesting, random keeps it fresh).
 */
feed.get('/', async (c) => {
  const sql = await getDb(c.env);

  const [trending, mostDownloaded, recentlyAdded, discover] = await Promise.all([
    sql`
      SELECT u.id, u.code_display, u.title, u.resource_count,
        (
          COALESCE(dl.recent_downloads, 0) * 3 +
          COALESCE(sl.recent_searches, 0) * 1
        ) AS trend_score
      FROM units u
      LEFT JOIN (
        SELECT unit_id, COUNT(*) AS recent_downloads
        FROM download_logs
        WHERE created_at > now() - interval '14 days'
        GROUP BY unit_id
      ) dl ON dl.unit_id = u.id
      LEFT JOIN (
        SELECT unit_id, COUNT(*) AS recent_searches
        FROM search_logs
        WHERE created_at > now() - interval '14 days'
        GROUP BY unit_id
      ) sl ON sl.unit_id = u.id
      WHERE COALESCE(dl.recent_downloads, 0) + COALESCE(sl.recent_searches, 0) > 0
      ORDER BY trend_score DESC
      LIMIT 10
    `,
    sql`
      SELECT id, code_display, title, resource_count, download_count
      FROM units ORDER BY download_count DESC LIMIT 10
    `,
    sql`
      SELECT r.id AS resource_id, r.title, r.type, r.academic_year, r.created_at,
             u.id AS unit_id, u.code_display, u.title AS unit_title
      FROM resources r JOIN units u ON u.id = r.unit_id
      WHERE r.is_flagged = false
      ORDER BY r.created_at DESC LIMIT 10
    `,
    sql`
      SELECT id, code_display, title, resource_count
      FROM units
      ORDER BY random()
      LIMIT 8
    `,
  ]);

  return c.json({ trending, most_downloaded: mostDownloaded, recently_added: recentlyAdded, discover });
});

export default feed;
