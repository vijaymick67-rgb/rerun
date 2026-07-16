// Explicit allow-list of curated TV/entertainment RSS feeds.
// api/news.js only ever fetches these fixed URLs — never a client-supplied feed.
export const CURATED_FEED_SOURCES = [
  { name: 'TVLine', url: 'https://tvline.com/feed/', maxArticles: 8 },
  { name: 'Deadline', url: 'https://deadline.com/feed/', maxArticles: 8 },
]
