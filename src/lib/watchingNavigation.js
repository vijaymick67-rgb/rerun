// Tracks whether the Watching list is currently on screen (`showing`) and how
// many times it has come back into view. `showing` is false whenever the list
// is covered by a Show/Season detail overlay OR hidden behind another main tab.
// The token bumps once on every transition back into view — but never on the
// very first reveal (`hasShown` guards that), because Watching's own mount-time
// load already paints that first view. Each later bump asks the preserved list
// to refresh quietly (no skeleton, no remount) so data changed elsewhere — a
// show added in Discover, an episode marked watched in a detail route — appears.
export function advanceWatchingRefreshState(state, showing) {
  const hasShown = state.hasShown || showing
  return {
    showing,
    hasShown,
    refreshToken:
      showing && !state.showing && state.hasShown
        ? state.refreshToken + 1
        : state.refreshToken,
  }
}

export function getWatchingInteractionState(active, openSwipeId, confirmingShow) {
  if (!active) {
    return {
      openSwipeId: null,
      confirmingShow: null,
    }
  }

  return {
    openSwipeId,
    confirmingShow,
  }
}
