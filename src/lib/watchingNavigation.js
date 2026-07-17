export function advanceWatchingRefreshState(state, detailOpen) {
  return {
    detailOpen,
    refreshToken:
      state.detailOpen && !detailOpen
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
