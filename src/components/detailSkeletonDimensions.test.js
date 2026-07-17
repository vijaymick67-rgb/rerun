import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('detail skeleton dimensions resemble their real rows', () => {
  it('SeasonDetailSkeleton episode row padding matches SeasonDetail.jsx', () => {
    const skeleton = src('./SeasonDetailSkeleton.jsx')
    const real = src('../routes/SeasonDetail.jsx')

    expect(skeleton).toContain('px-3 py-1.5')
    expect(real).toContain('px-3 py-1.5')
  })

  it('ShowDetailSkeleton season row wrapper matches ShowDetail.jsx spacing', () => {
    const skeleton = src('./ShowDetailSkeleton.jsx')
    const real = src('../routes/ShowDetail.jsx')

    expect(skeleton).toContain('pl-3 pr-1')
    expect(real).toContain('pl-3 pr-1')

    expect(skeleton).toContain('py-3 pr-2')
    expect(real).toContain('py-3 pr-2')

    // Both use the same 44px circular-action footprint (WatchedCircle).
    expect(skeleton).toContain('h-11 w-11')
  })
})
