# 0006: Bind each Browser profile to one backend

Ordered backend selection applies only before a Browser profile has a home. The
selected backend is recorded before its first mutation, so an interrupted creation
cannot leave state on one backend and retry against another. The durable profile
remains bound to that backend across target deletion because silently launching a
same-named empty volume elsewhere would discard the cookies and authentication the
profile promises to preserve. A versioned profile binding receipt also names the
current exact target when one exists; serialized cleanup may clear it only when the
backend and target identity still match.
