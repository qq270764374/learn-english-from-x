import { BookOpen, Check, Eye, EyeOff, RotateCcw, Sparkles, Volume2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { previewReviewIntervals, getCardStageLabel, type DueQueueResult } from '../services/srs'
import type { RatingGrade, UserSettings, VocabCard } from '../types/vocab'
import { categoryLabelZh, speakEnglishText, splitHighlightSegments } from '../utils/textHelpers'

interface StudyViewProps {
  dueQueue: DueQueueResult
  totalCardsCount: number
  settings: UserSettings
  isModalOpen: boolean
  onRateCard: (card: VocabCard, rating: RatingGrade) => void
  onMarkKnown: (card: VocabCard) => void
  onIgnoreCard: (card: VocabCard) => void
  onLoadDemoCards: () => Promise<void>
  onAddExtraNew: () => void
  onToggleShowContext: () => void
  onGoToIngest: () => void
}

function HighlightedTweet({ text, word }: { text: string; word: string }) {
  const segments = useMemo(() => splitHighlightSegments(text, word), [text, word])
  return (
    <p className="tweet-quote-text">
      {segments.map((seg, idx) =>
        seg.highlighted ? (
          <mark key={idx} className="tweet-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </p>
  )
}

export function StudyView({
  dueQueue,
  totalCardsCount,
  settings,
  isModalOpen,
  onRateCard,
  onMarkKnown,
  onIgnoreCard,
  onLoadDemoCards,
  onAddExtraNew,
  onToggleShowContext,
  onGoToIngest,
}: StudyViewProps) {
  const currentCard = dueQueue.dueCards[0] ?? null
  const [flippedCardId, setFlippedCardId] = useState<string | null>(null)
  const [loadingDemo, setLoadingDemo] = useState(false)
  const isFlipped = Boolean(currentCard && flippedCardId === currentCard.id)

  const previews = useMemo(() => {
    if (!currentCard) return null
    return previewReviewIntervals(currentCard)
  }, [currentCard])

  useEffect(() => {
    if (!currentCard || isModalOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (e.code === 'Space') {
        e.preventDefault()
        setFlippedCardId((prev) => (prev === currentCard.id ? null : currentCard.id))
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        speakEnglishText(currentCard.word, settings.ttsAccent)
        return
      }
      if (isFlipped && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        onRateCard(currentCard, Number(e.key) as RatingGrade)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentCard, isFlipped, isModalOpen, onRateCard, settings.ttsAccent])

  const handleDemoClick = async () => {
    setLoadingDemo(true)
    try {
      await onLoadDemoCards()
    } finally {
      setLoadingDemo(false)
    }
  }

  if (totalCardsCount === 0) {
    return (
      <section className="study-stage" aria-label="今日学习">
        <div className="empty-paper">
          <BookOpen size={34} color="#B44322" />
          <h2>你的 X 推文生词本还是空的</h2>
          <p>
            刷 X 时遇到真正高频、有趣的表达，用 Chrome 插件采集后即可用 DeepSeek / Gemini 自动生成语境卡片。
            现在也可以先加载 7 张精选示例词卡，直接体验 FSRS 记忆曲线。
          </p>
          <div className="empty-actions">
            <button
              id="btn-load-demo-cards"
              type="button"
              className="btn btn-primary"
              disabled={loadingDemo}
              onClick={handleDemoClick}
            >
              <Sparkles size={16} />
              {loadingDemo ? '加载中...' : '一键加载 7 张示例词卡'}
            </button>
            <button id="btn-empty-go-ingest" type="button" className="btn" onClick={onGoToIngest}>
              去采集 X 推文 / 看推荐博主
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (!currentCard) {
    const remainingNew = Math.max(0, dueQueue.newAvailableCount - dueQueue.newInQueueCount)
    return (
      <section className="study-stage" aria-label="今日学习完成">
        <div className="empty-paper">
          <Check size={36} color="#2B6E4E" />
          <h2>今日记忆任务已完成</h2>
          <p>
            今天已完成 <strong className="tabular">{dueQueue.reviewedTodayCount}</strong> 次复习回顾，
            所有到期的复习词卡已全部按 FSRS 记忆曲线排入下一轮周期。
          </p>
          <div className="empty-actions">
            {remainingNew > 0 && (
              <button id="btn-extra-new-cards" type="button" className="btn btn-primary" onClick={onAddExtraNew}>
                <RotateCcw size={15} />
                再加学 5 张新词（剩余 {remainingNew} 张）
              </button>
            )}
            <button id="btn-done-go-ingest" type="button" className="btn" onClick={onGoToIngest}>
              去采集更多 X 推文
            </button>
          </div>
        </div>
      </section>
    )
  }

  const stage = getCardStageLabel(currentCard)
  const ratings: RatingGrade[] = [1, 2, 3, 4]

  return (
    <section className="study-stage" aria-label="Anki 词卡复习">
      <div className="study-meta-bar">
        <div className="study-counters">
          <span className="study-counter-item">
            本轮剩余 <strong>{dueQueue.dueCards.length}</strong> 张
          </span>
          <span className="study-counter-item">
            复习 <strong>{dueQueue.strictReviewCount + dueQueue.learnAheadCount}</strong>
          </span>
          <span className="study-counter-item">
            新词 <strong>{dueQueue.newInQueueCount}</strong>
          </span>
          <span className="study-counter-item">
            今日已完成 <strong>{dueQueue.reviewedTodayCount}</strong> 次
          </span>
        </div>

        <div className="study-toggles">
          <button
            id="btn-toggle-context-front"
            type="button"
            className="btn btn-sm"
            onClick={onToggleShowContext}
            title="切换翻卡前是否显示原推文线索"
          >
            {settings.showContextOnFront ? <Eye size={14} /> : <EyeOff size={14} />}
            {settings.showContextOnFront ? '正面显示原推文' : '正面纯看词记忆'}
          </button>
        </div>
      </div>

      <article className="flashcard">
        <div className="card-top-row">
          <div className="pill-group">
            <span className={`tag ${currentCard.category}`}>{categoryLabelZh(currentCard.category)}</span>
            {currentCard.cefr_level && <span className="tag">{currentCard.cefr_level}</span>}
            {currentCard.pos && <span className="tag">{currentCard.pos}</span>}
            <span className={`tag ${stage.tone === 'mastered' ? 'mastered' : ''}`}>{stage.label}</span>
          </div>

          <div className="pill-group">
            <button
              id="btn-mark-known"
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onMarkKnown(currentCard)}
              title="将此词记为已熟知，今后不再抽检"
            >
              <Check size={14} />
              已熟知
            </button>
            <button
              id="btn-ignore-card"
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onIgnoreCard(currentCard)}
              title="屏蔽该词"
            >
              <X size={14} />
              屏蔽
            </button>
          </div>
        </div>

        <div className="card-word-block">
          <h2 className="card-word">{currentCard.word}</h2>
          <div className="card-phonetic-row">
            {currentCard.ipa && <span className="card-ipa">{currentCard.ipa}</span>}
            <button
              id="btn-speak-word"
              type="button"
              className="speak-btn"
              onClick={() => speakEnglishText(currentCard.word, settings.ttsAccent)}
              title="朗读单词发音（快捷键 R）"
            >
              <Volume2 size={14} />
              发音 ({settings.ttsAccent === 'en-US' ? '美' : '英'})
            </button>
          </div>
        </div>

        {(settings.showContextOnFront || isFlipped) && currentCard.sample_tweet && (
          <div className="tweet-quote-box">
            <HighlightedTweet text={currentCard.sample_tweet} word={currentCard.word} />
            <div className="tweet-meta-line">
              <span>
                {currentCard.author_handle ? `@${currentCard.author_handle}` : 'X 原推文语境'}
              </span>
              <div className="pill-group">
                {isFlipped && (
                  <button
                    id="btn-speak-tweet"
                    type="button"
                    className="speak-btn"
                    onClick={() => speakEnglishText(currentCard.sample_tweet, settings.ttsAccent)}
                  >
                    <Volume2 size={13} />
                    朗读整句
                  </button>
                )}
                {currentCard.tweet_url && (
                  <a href={currentCard.tweet_url} target="_blank" rel="noreferrer">
                    查看原推 ↗
                  </a>
                )}
              </div>
            </div>
            {isFlipped && currentCard.sample_tweet_zh && (
              <p className="tweet-zh">{currentCard.sample_tweet_zh}</p>
            )}
          </div>
        )}

        {!isFlipped ? (
          <div className="card-reveal-cta">
            <button
              id="btn-flip-card"
              type="button"
              className="btn btn-primary card-reveal-btn"
              onClick={() => setFlippedCardId(currentCard.id)}
            >
              查看释义与语境记忆（空格键 Space）
            </button>
          </div>
        ) : (
          <div className="card-back-section">
            <p className="meaning-zh">{currentCard.meaning_zh}</p>
            {currentCard.memory_tip_zh && (
              <div className="tip-box">
                <strong>记忆提示：</strong>
                {currentCard.memory_tip_zh}
              </div>
            )}

            {previews && (
              <div className="rating-grid" role="group" aria-label="记忆程度反馈">
                {ratings.map((r) => {
                  const p = previews[r]
                  return (
                    <button
                      key={r}
                      id={`btn-rate-${r}`}
                      type="button"
                      className={`rating-btn rate-${r}`}
                      onClick={() => onRateCard(currentCard, r)}
                      title={p.hint}
                    >
                      <span className="rating-label">{p.label}</span>
                      <span className="rating-interval">{p.intervalText}</span>
                      <span className="rating-kbd">{r}</span>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="card-footer-actions">
              <span>快捷键：1~4 评分 · R 朗读单词</span>
              <span>已复习 {currentCard.fsrs.reps} 次</span>
            </div>
          </div>
        )}
      </article>
    </section>
  )
}
