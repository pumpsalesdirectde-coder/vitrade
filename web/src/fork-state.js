const snapshot = (settings) => JSON.stringify(settings);

export const createForkDraft = (settings) => ({ settings, saved: snapshot(settings) });
export const forkDraftDirty = (draft) => snapshot(draft.settings) !== draft.saved;

export function forkDraftReducer(draft, action) {
  if (action.type === "edit") return { ...draft, settings: { ...draft.settings, [action.key]: action.value } };
  if (action.type === "saved") return { ...draft, saved: snapshot(action.settings) };
  if (action.type === "sync") {
    const saved = snapshot(action.settings);
    if (saved === draft.saved) return draft;
    return { settings: forkDraftDirty(draft) ? draft.settings : action.settings, saved };
  }
  return draft;
}

export const activeFork = (forks = [], botId) => forks.find((pair) => pair.status !== "CLOSED" && (pair.parentBotId === botId || pair.childBotId === botId));
