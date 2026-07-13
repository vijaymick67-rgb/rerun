const TV_SIGNALS = [
  /\btv\b/i,
  /television/i,
  /series/i,
  /season\s*\d/i,
  /showrunner/i,
  /renew(?:ed|al|s)?/i,
  /cancel(?:led|ed|lation|s)?/i,
  /premiere/i,
  /episode/i,
  /trailer/i,
  /casting|cast/i,
  /production/i,
  /streamer/i,
  /network/i,
  /sitcom|miniseries|limited series/i,
]

const HARD_EXCLUSIONS = [
  /box office/i,
  /\bconcert\b|\balbum\b|\bsong\b|\bsinger\b|\bmusic video\b/i,
  /\bfootball\b|\bbasketball\b|\bbaseball\b|\bhockey\b|\bsoccer\b|\btennis\b/i,
  /video game|gaming|console/i,
  /election|politician|president|parliament/i,
]

const MOVIE_TERMS = /\bmovie\b|\bfilm\b|\bcinema\b|\btheatrical\b|\bfilmmaker\b|\bbox office\b/i
const GOSSIP_TERMS = /dating|relationship|breakup|fashion|red carpet|influencer|reality star|celebrity gossip/i
const SHOW_DEVELOPMENT_TERMS = /series|season|showrunner|episode|premiere|renew|cancel|casting|cast|trailer|production|network|streamer/i

export function isTvNewsArticle(article) {
  if (!article?.title) return false

  const text = `${article.title} ${article.description ?? ''}`
  if (!TV_SIGNALS.some((pattern) => pattern.test(text))) return false
  if (HARD_EXCLUSIONS.some((pattern) => pattern.test(article.title))) return false
  if (MOVIE_TERMS.test(article.title) && !SHOW_DEVELOPMENT_TERMS.test(article.title)) return false
  if (GOSSIP_TERMS.test(text) && !SHOW_DEVELOPMENT_TERMS.test(text)) return false
  return true
}

export function filterTvNews(articles) {
  return articles.filter(isTvNewsArticle)
}
